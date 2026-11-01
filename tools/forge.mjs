#!/usr/bin/env node
/**
 * 造专家：按参数生成一个专家包的骨架，并当场用扫描器校验。
 *
 *   node tools/forge.mjs rtsp \
 *     --name 流媒体工程师 \
 *     --description "摄像头接入、推流、回放与存储" \
 *     --triggers 摄像头,推流,RTSP,回放,目标检测 \
 *     --skills pdf
 *
 * 默认写到 <DSH_HOME>/capability-router/experts/<id>/（用户目录，优先级高于包内）。
 * --dry-run 只打印不落盘；--force 覆盖已存在的同名专家。
 *
 * 刻意不做的事：不猜触发词、不编描述。缺哪个必填参数就报错退出——
 * 猜出来的措辞会被人直接接受，那比生成失败更糟。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExpert } from "../lib/experts.js";

const USAGE = `用法：
  node tools/forge.mjs <id> --name <名字> --description <一句话> --triggers <词,词,词>
                         [--synonyms <词,词>] [--skills <名,名>] [--dir <目录>]
                         [--force] [--dry-run]

示例：
  node tools/forge.mjs rtsp --name 流媒体工程师 \\
    --description "摄像头接入、推流、回放与存储" \\
    --triggers 摄像头,推流,RTSP,回放,目标检测 --skills pdf`;

function parseArgs(argv) {
  const options = { flags: new Set(), values: {} };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--force" || token === "--dry-run" || token === "--help") {
      options.flags.add(token);
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`参数 ${token} 缺少取值`);
      }
      options.values[key] = value;
      index += 1;
      continue;
    }
    positional.push(token);
  }
  return { ...options, positional };
}

function splitList(value) {
  if (value === undefined) return [];
  return String(value)
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function fail(message) {
  console.error(`forge: ${message}`);
  console.error("");
  console.error(USAGE);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error.message);
}

if (parsed.flags.has("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const id = parsed.positional[0];
if (id === undefined) fail("缺少专家 id");
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`id 只能是 kebab-case：a-z 0-9 与连字符，实际是「${id}」`);

const name = parsed.values.name?.trim();
const description = parsed.values.description?.trim();
const triggers = splitList(parsed.values.triggers);
if (name === undefined || name === "") fail("缺少 --name");
if (description === undefined || description === "") fail("缺少 --description（一句话说明这个专家干什么、什么时候该找它）");
if (triggers.length === 0) fail("缺少 --triggers（用户会怎么说这件事，逗号分隔）");

const skills = splitList(parsed.values.skills);
const synonyms = splitList(parsed.values.synonyms);
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const dir = parsed.values.dir ?? path.join(dshHome, "capability-router", "experts", id);

const manifest = [
  `name: ${name}`,
  `description: ${description}`,
  `triggers: [${triggers.join(", ")}]`,
  `synonyms: [${synonyms.join(", ")}]`,
  `skills: [${skills.join(", ")}]`,
  "tools: []",
  "",
].join("\n");

const role = `# 角色：${name}

你负责的是「${description}」。

## 工作方式

- 先确认场景与约束：谁用、什么规模、失败时最坏会怎样。缺哪一件就先问那一件。
- 先给能验证的结果，再谈优化。说不清怎么验证，等于没做完。

## 边界

- 不猜领域规则。含糊的地方列出来问，只问会改变做法的那几个。
- 领域里没有对应能力时直说缺什么，不要拿相近的东西硬凑。

## 交付

三句话：做了什么、依据是什么、怎么验证。
`;

if (parsed.flags.has("--dry-run")) {
  console.log(`# 将写入 ${dir}`);
  console.log(`--- expert.yml ---\n${manifest}`);
  console.log(`--- role.md ---\n${role}`);
  process.exit(0);
}

const exists = fs.existsSync(path.join(dir, "expert.yml"));
if (exists && !parsed.flags.has("--force")) {
  fail(`${dir} 已经有一个专家包了；确认要改就加 --force`);
}

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "expert.yml"), manifest, "utf8");
fs.writeFileSync(path.join(dir, "role.md"), role, "utf8");

// 写完当场校验：不给出去一个自己都读不出来的包。
const { expert, warnings, errors } = loadExpert(dir);
if (expert === undefined) {
  console.error(`forge: 生成的专家包没通过校验：${errors.join("; ")}`);
  process.exit(1);
}

console.log(`已写入 ${dir}`);
console.log(`  expert.yml  name=${expert.name}  triggers=${expert.triggers.length} 个  skills=${expert.skills.length} 个`);
console.log(`  role.md     ${expert.hasRole ? "已生成骨架，记得按这个领域改" : "缺失"}`);
for (const warning of warnings) console.log(`  警告 ${warning}`);
console.log("");
console.log("下一步：");
console.log("  1. 改 role.md——骨架只是占位，写这个领域真正的工作方式与交付标准");
console.log("  2. 重启 DSH（专家包在挂载时扫描）");
console.log(`  3. 验收：node -e \"import('./lib/router.js').then(async m => { const e = await import('./lib/experts.js'); const {experts} = e.scanExperts({dirs: e.expertDirs(process.env.USERPROFILE + '/.dsh/capability-router')}); console.log(m.describeMatch(m.matchExpert('${triggers[0]}', experts))); })\"`);
