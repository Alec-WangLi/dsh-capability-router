#!/usr/bin/env node
/**
 * 技能供给体检：专家声明了哪些技能，本机装了哪些。
 *
 * 用法：
 *   node tools/doctor.mjs                     # 读 ~/.dsh/skills
 *   node tools/doctor.mjs --dir D:/skills     # 额外扫一个技能目录（可重复）
 *   node tools/doctor.mjs --json
 *
 * 退出码：0 必装齐全；1 有必装缺席；2 参数错误。
 *
 * 为什么单独做一条命令：插件不内置技能（别人的技能一直在更新，内置就吃不到新特性），
 * 所以「声明了但没装」是常态而不是错误——需要的是一个能随时跑一遍的体检，而不是加载时炸掉。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSupply, doctorExitCode, renderReport } from "../lib/doctor.js";
import { defaultSkillDirs, discoverSkills } from "../lib/skills.js";
import { expertDirs, scanExperts } from "../lib/experts.js";

const argv = process.argv.slice(2);

function take(flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} 缺少参数`);
    process.exit(2);
  }
  argv.splice(at, 2);
  return value;
}

const asJson = argv.includes("--json");
if (asJson) argv.splice(argv.indexOf("--json"), 1);

const extraDirs = [];
for (let value = take("--dir"); value !== undefined; value = take("--dir")) {
  if (!path.isAbsolute(value)) {
    console.error(`--dir 需要绝对路径：${value}`);
    process.exit(2);
  }
  extraDirs.push(value);
}

if (argv.length > 0) {
  console.error(`未知参数：${argv.join(" ")}`);
  process.exit(2);
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const STATE_DIR = path.join(DSH_HOME, "capability-router");
const SKILL_DIRS = defaultSkillDirs(DSH_HOME, extraDirs);

const { experts, errors, warnings } = scanExperts({ dirs: expertDirs(STATE_DIR) });
const installed = discoverSkills(SKILL_DIRS);
const report = checkSupply(experts, new Set(installed.keys()));

for (const line of errors) console.error(`专家包错误：${line}`);
for (const line of warnings) console.error(`专家包告警：${line}`);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        experts: report.rows,
        missingRequired: report.missingRequired,
        missingOptional: report.missingOptional,
        skillDirs: SKILL_DIRS,
        installedCount: installed.size,
      },
      null,
      2,
    ),
  );
} else {
  console.log(renderReport(report, { expertCount: experts.length, installedCount: installed.size }));
  console.log(`扫描的技能目录：${SKILL_DIRS.join("、")}`);
}

process.exit(doctorExitCode(report));
