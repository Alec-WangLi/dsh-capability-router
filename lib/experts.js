/**
 * 专家包的发现与校验。
 *
 * 专家包 = 一个目录，里面三样东西：
 *   expert.yml   元数据（name / description / triggers / skills / tools）
 *                外加 v2 字段：kind（intake|worker|reviewer）/ handoff / deliverables
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

  const known = new Set([
    "name",
    "description",
    "triggers",
    "synonyms",
    "skills",
    "tools",
    "kind",
    "role",
    "handoff",
    "deliverables",
  ]);
  for (const key of Object.keys(data)) {
    if (!known.has(key)) warnings.push(`${id}: 未知字段 ${key}，已忽略`);
  }

  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const triggers = toStringList(data.triggers);

  if (name === "") errors.push(`${id}: name 为空`);
  if (description === "") errors.push(`${id}: description 为空`);
  if (triggers.length === 0) errors.push(`${id}: triggers 为空，这个专家永远不会被命中`);

  const { kind, kindWarning } = parseKind(data, id);
  if (kindWarning !== undefined) warnings.push(kindWarning);
  const { skillDeps, depWarnings } = parseSkillDeps(data.skills, id);
  for (const warning of depWarnings) warnings.push(warning);

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
      /** intake | worker | reviewer。名字决定行为：接单的先出文档，审查的按验收标准收口。 */
      kind,
      /** 通常把活交给谁（id 列表），只作提示，不强制。 */
      handoff: toStringList(data.handoff),
      /** 这个专家该产出什么文件，审查专家按它验收。 */
      deliverables: toStringList(data.deliverables),
      /** 技能名列表（v1 兼容视图），给匹配器与自检技能用。 */
      skills: skillDeps.map((dep) => dep.name),
      /** 依赖声明（v2）：每项含 name / required / source，供 doctor 体检。 */
      skillDeps,
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

/** 允许的专家角色。 */
const KINDS = new Set(["intake", "worker", "reviewer"]);

/**
 * 解析 `kind`（兼容 v1 里没人用过的 `role` 写法）。
 * @param {Record<string, unknown>} data
 * @param {string} id
 * @returns {{kind: string, kindWarning?: string}}
 */
function parseKind(data, id) {
  const hasKind = data.kind !== undefined;
  const hasRole = data.role !== undefined;
  if (hasKind && hasRole) return { kind: "worker", kindWarning: `${id}: kind 与 role 同时出现，只用 kind` };
  const raw = hasKind ? data.kind : hasRole ? data.role : undefined;
  if (raw === undefined) return { kind: "worker" };
  const text = String(raw).trim().toLowerCase();
  if (!KINDS.has(text)) {
    return { kind: "worker", kindWarning: `${id}: kind 只能是 intake / worker / reviewer，收到「${text}」，按 worker 处理` };
  }
  return { kind: text };
}

/**
 * 把 `skills` 规整成依赖声明。
 * 支持两种写法：
 *   skills: [pdf, office-xlsx]                                  老写法，全部视为非必装、来源不明
 *   skills: [{name: pdf, required: true, source: local}]         v2 写法
 * @param {unknown} value
 * @param {string} id
 * @returns {{skillDeps: {name: string, required: boolean, source: string}[], depWarnings: string[]}}
 */
function parseSkillDeps(value, id) {
  const depWarnings = [];
  const skillDeps = [];
  const items = Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value];
  for (const item of items) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name !== "") skillDeps.push({ name, required: false, source: "unknown" });
      continue;
    }
    if (item !== null && typeof item === "object") {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (name === "") {
        depWarnings.push(`${id}: skills 里有一项没有 name，已忽略`);
        continue;
      }
      const required = item.required === true;
      const source = typeof item.source === "string" && item.source.trim() !== "" ? item.source.trim() : "unknown";
      skillDeps.push({ name, required, source });
      continue;
    }
    depWarnings.push(`${id}: skills 里有无法识别的项（${JSON.stringify(item)}），已忽略`);
  }
  return { skillDeps, depWarnings };
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
      const kind = expert.kind ?? "worker";
      const carry = (expert.handoff ?? []).length > 0 ? "\n  常交给：" + expert.handoff.join("、") : "";
      const outs = (expert.deliverables ?? []).length > 0 ? "\n  该产出：" + expert.deliverables.join("、") : "";
      return `- **${expert.name}**（${expert.id}，${kind}）：${expert.description}\n  触发词：${expert.triggers.join("、")}\n  技能：${skills}${carry}${outs}`;
    })
    .join("\n");
}
