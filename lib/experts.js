/**
 * 专家包的发现与校验。
 *
 * 专家包 = 一个目录，里面三样东西：
 *   expert.yml   元数据（name / description / triggers / skills / tools）
 *   role.md      角色提示词，命中后注入系统提示
 *   skills/      可选，专家自带的技能目录
 *
 * 扫描顺序：先包内 experts/（随插件发布），再 <DSH_HOME>/capability-router/experts/（用户自建）。
 * 同一个 id 两边都有时用户那份胜出——改别人的专家包不需要动源码。
 *
 * 这里只负责「读出什么有什么」，不做匹配、不动技能目录。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlSubset, toStringList } from "./yaml.js";

/** 包根目录（lib/ 的上一层）。 */
export const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 缺少 role.md 时的占位：仍然能用，只是没有角色提示词可注入。 */
const MISSING_ROLE = "";

/**
 * 专家包搜索目录，按优先级从低到高。
 * @param {string} stateDir 本插件的状态目录（一般是 ~/.dsh/capability-router）
 * @returns {string[]}
 */
export function expertDirs(stateDir) {
  return [path.join(PACKAGE_ROOT, "experts"), path.join(stateDir, "experts")];
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 读一个专家目录。
 * @param {string} dir 专家目录的绝对路径
 * @returns {{expert?: object, warnings: string[], errors: string[]}}
 */
export function loadExpert(dir) {
  const id = path.basename(dir);
  const warnings = [];
  const errors = [];

  const manifest = readText(path.join(dir, "expert.yml"));
  if (manifest === undefined) {
    return { warnings, errors: [`${id}: 缺少 expert.yml`] };
  }

  const { data, warnings: yamlWarnings } = parseYamlSubset(manifest);
  for (const warning of yamlWarnings) warnings.push(`${id}/expert.yml ${warning}`);

  const known = new Set(["name", "description", "triggers", "synonyms", "skills", "tools"]);
  for (const key of Object.keys(data)) {
    if (!known.has(key)) warnings.push(`${id}: 未知字段 ${key}，已忽略`);
  }

  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const triggers = toStringList(data.triggers);

  if (name === "") errors.push(`${id}: name 为空`);
  if (description === "") errors.push(`${id}: description 为空`);
  if (triggers.length === 0) errors.push(`${id}: triggers 为空，这个专家永远不会被命中`);

  const roleFile = path.join(dir, "role.md");
  const roleText = readText(roleFile);
  if (roleText === undefined) warnings.push(`${id}: 没有 role.md，命中后只会注入技能集`);

  const skillDir = path.join(dir, "skills");
  const ownSkills = fs.existsSync(skillDir) ? fs.readdirSync(skillDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];

  if (errors.length > 0) return { warnings, errors };

  return {
    expert: {
      id,
      name,
      description,
      triggers,
      /** 口语化的领域词：分量低于 triggers，用来接住日常说法。 */
      synonyms: toStringList(data.synonyms),
      skills: toStringList(data.skills),
      /** 空数组 = 不限制工具。 */
      tools: toStringList(data.tools),
      role: roleText ?? MISSING_ROLE,
      hasRole: roleText !== undefined,
      ownSkills,
      dir,
    },
    warnings,
    errors,
  };
}

/**
 * 扫描所有专家目录。
 * @param {{dirs: string[]}} options 目录列表，优先级从低到高
 * @returns {{experts: object[], warnings: string[], errors: string[]}}
 */
export function scanExperts({ dirs }) {
  const byId = new Map();
  const warnings = [];
  const errors = [];

  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在是常态，不是错误
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const result = loadExpert(path.join(dir, entry.name));
      for (const warning of result.warnings) warnings.push(warning);
      if (result.expert === undefined) {
        for (const error of result.errors) errors.push(error);
        byId.delete(entry.name); // 用户那份坏了就不要退回旧版本，免得静默用错
        continue;
      }
      byId.set(entry.name, result.expert);
    }
  }

  return { experts: [...byId.values()], warnings, errors };
}

/**
 * 把专家列表渲染成一段人类可读的清单，供自检技能使用。
 * @param {object[]} experts
 * @returns {string}
 */
export function renderExpertList(experts) {
  if (experts.length === 0) return "（没有找到任何专家包）";
  return experts
    .map((expert) => {
      const skills = expert.skills.length === 0 ? "不限" : expert.skills.join("、");
      return `- **${expert.name}**（${expert.id}）：${expert.description}\n  触发词：${expert.triggers.join("、")}\n  技能：${skills}`;
    })
    .join("\n");
}
