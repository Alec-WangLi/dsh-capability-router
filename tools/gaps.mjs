#!/usr/bin/env node
/**
 * 看缺口：把 gaps.jsonl 聚合成「哪个领域最缺人」。
 *
 *   node tools/gaps.mjs            # 最近 20 条里的分组统计
 *   node tools/gaps.mjs --all      # 全量
 *   node tools/gaps.mjs --json
 *
 * 只做聚合，不做解释：同一句话出现三次，就是有人在三次里都没找到人接。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const asJson = args.includes("--json");

const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const file = path.join(home, "capability-router", "gaps.jsonl");

if (!fs.existsSync(file)) {
  console.log(`还没有缺口记录：${file}`);
  console.log("它会在匹配落空时自动写入（配置 gapLog 默认开）。");
  process.exit(0);
}

const rows = fs.readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter((row) => row !== undefined);

const scope = showAll ? rows : rows.slice(-200);
const groups = new Map();
for (const row of scope) {
  const key = `${row.kind}\u0000${(row.text ?? "").trim()}`;
  const entry =
    groups.get(key) ??
    { kind: row.kind, text: row.text, count: 0, last: row.at, candidates: row.candidates ?? [], phases: new Set(), langs: new Set() };
  entry.count += 1;
  // 同一句话在 idle 里落空和在大任务里落空是两种信号：聚合仍按原话，
  // 但把这句话在哪些阶段落空过带上，不然新写的 phase 字段没人看等于没写。
  if (typeof row.phase === "string" && row.phase !== "") entry.phases.add(row.phase);
  // 非中文才记（中文是基线，旧行没这个键）。没有它就没法回答
  // 「英文语料落空率是多少」——而那是补不补英文词表的唯一依据。
  if (typeof row.lang === "string" && row.lang !== "" && row.lang !== "zh") entry.langs.add(row.lang);
  if (row.at > entry.last) entry.last = row.at;
  groups.set(key, entry);
}

const sorted = [...groups.values()]
  .map((entry) => ({ ...entry, phases: [...entry.phases], langs: [...entry.langs] }))
  .sort((left, right) => right.count - left.count || String(right.last).localeCompare(String(left.last)));

if (asJson) {
  console.log(JSON.stringify({ file, total: scope.length, groups: sorted }, null, 2));
  process.exit(0);
}

if (sorted.length === 0) {
  console.log("缺口记录是空的。");
  process.exit(0);
}

console.log(`缺口记录：${scope.length} 条，去重后 ${sorted.length} 种说法（${file}）`);
console.log("");
for (const entry of sorted.slice(0, 20)) {
  const tag = entry.kind === "ambiguous" ? `分不清/${entry.candidates.join("|")}` : "没人接";
  const where = entry.phases.length === 0 ? "" : `  ·  阶段 ${entry.phases.join("/")}`;
  const which = entry.langs.length === 0 ? "" : `  ·  ${entry.langs.map((code) => code.toUpperCase()).join("/")}`;
  console.log(`×${String(entry.count).padStart(2)}  ${entry.text}`);
  console.log(`      ${tag}${where}${which}  ·  最近 ${entry.last}`);
}
if (sorted.length > 20) console.log(`\n还有 ${sorted.length - 20} 种没显示，用 --all 或 --json 看全量。`);
