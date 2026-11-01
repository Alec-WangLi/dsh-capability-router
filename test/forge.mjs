import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExpert, scanExperts } from "../lib/experts.js";
import { matchExpert } from "../lib/router.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const FORGE = path.join(REPO, "tools", "forge.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-forge-"));
const home = path.join(tmp, "home");

function forge(args, options = {}) {
  return spawnSync(process.execPath, [FORGE, ...args], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
    ...options,
  });
}

const ARGS = [
  "rtsp",
  "--name",
  "流媒体工程师",
  "--description",
  "摄像头接入、推流、回放与存储",
  "--triggers",
  "摄像头,推流,RTSP,回放,目标检测",
  "--skills",
  "pdf",
];

// 场景一：缺必填项直接失败，不生成半成品
{
  const result = forge(["rtsp", "--name", "只有名字"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /缺少 --description/);
  assert.equal(fs.existsSync(path.join(home, "capability-router", "experts", "rtsp")), false);
}

// 场景二：id 不是 kebab-case 就拒绝
{
  const result = forge(["RTSP_Thing", "--name", "x", "--description", "y", "--triggers", "z"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /kebab-case/);
}

// 场景三：正常生成，且生成物当场就能被扫描器读出来
{
  const result = forge(ARGS);
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(home, "capability-router", "experts", "rtsp");
  assert.ok(fs.existsSync(path.join(dir, "expert.yml")));
  assert.ok(fs.existsSync(path.join(dir, "role.md")));

  const { expert, errors } = loadExpert(dir);
  assert.deepEqual(errors, []);
  assert.equal(expert.name, "流媒体工程师");
  assert.deepEqual(expert.triggers, ["摄像头", "推流", "RTSP", "回放", "目标检测"]);
  assert.deepEqual(expert.skills, ["pdf"]);
  assert.equal(expert.hasRole, true);
}

// 场景四：生成的专家真的能被匹配到
{
  const dirs = [path.join(home, "capability-router", "experts")];
  const { experts } = scanExperts({ dirs });
  const verdict = matchExpert("摄像头推流老是断", experts);
  assert.equal(verdict.kind, "hit");
  assert.equal(verdict.expert.id, "rtsp");
}

// 场景五：同名已存在且没加 --force → 拒绝覆盖
{
  const result = forge(ARGS);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--force/);
}

// 场景六：--force 才覆盖
{
  const result = forge([...ARGS, "--force", "--name", "流媒体工程师（改名）"]);
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(home, "capability-router", "experts", "rtsp");
  assert.equal(loadExpert(dir).expert.name, "流媒体工程师（改名）");
}

// 场景七：--dry-run 一行都不写
{
  const result = forge([
    "player",
    "--name",
    "播放器工程师",
    "--description",
    "播放内核与兼容性",
    "--triggers",
    "播放器,卡顿",
    "--dry-run",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /expert\.yml/);
  assert.equal(fs.existsSync(path.join(home, "capability-router", "experts", "player")), false);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("场景一 必填校验      ✓");
console.log("场景二 id 规范       ✓");
console.log("场景三 生成即可读    ✓");
console.log("场景四 生成即可命中  ✓");
console.log("场景五 覆盖需确认    ✓");
console.log("场景六 --force       ✓");
console.log("场景七 --dry-run     ✓");
console.log("造专家测试通过");
