import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const SCRIPT = path.join(REPO, "tools", "gaps.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-gaps-"));
const home = path.join(tmp, "home");
const stateDir = path.join(home, "capability-router");

function run(args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
  });
}

// 场景一：没有记录时说清楚，不报错
{
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /还没有缺口记录/);
}

fs.mkdirSync(stateDir, { recursive: true });
const rows = [
  { at: "2026-11-01T10:00:00.000Z", kind: "miss", text: "帮我做视频监控系统", candidates: [] },
  { at: "2026-11-01T10:01:00.000Z", kind: "miss", text: "帮我做视频监控系统", candidates: [] },
  { at: "2026-11-01T10:02:00.000Z", kind: "miss", text: "帮我写个爬虫", candidates: [] },
  {
    at: "2026-11-01T10:03:00.000Z",
    kind: "ambiguous",
    text: "帮我写一下这个接口的文档",
    candidates: ["backend", "docs"],
  },
  "这不是 JSON",
];
fs.writeFileSync(path.join(stateDir, "gaps.jsonl"), `${rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`, "utf8");

// 场景二：同一句话合并计数，坏的行走忽略而不是让整份文件读不出来
{
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /缺口记录：4 条，去重后 3 种说法/);
  assert.match(result.stdout, /× 2 {2}帮我做视频监控系统/);
}

// 场景三：分不清与没人接要能分开显示
{
  const result = run();
  assert.match(result.stdout, /分不清\/backend\|docs/);
  assert.match(result.stdout, /没人接/);
}

// 场景四：--json 给机读
{
  const result = run(["--json"]);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.total, 4);
  assert.equal(parsed.groups[0].count, 2);
  assert.equal(parsed.groups[0].text, "帮我做视频监控系统");
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("场景一 无记录提示    ✓");
console.log("场景二 合并计数      ✓");
console.log("场景三 分类显示      ✓");
console.log("场景四 机读输出      ✓");
console.log("缺口汇总测试通过");
