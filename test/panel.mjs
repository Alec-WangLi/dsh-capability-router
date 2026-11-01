import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, readGaps, readRuns, readSessions, renderHtml } from "../lib/panel.js";

/**
 * 面板数据层测试：读坏文件不炸、缺口聚合对、渲染转义对。
 * 服务本身（tools/panel.mjs）不在这里起——它只是把这几件事串起来。
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-panel-"));
const sessionsDir = path.join(tmp, "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

// 场景一：runs 读取——坏行跳过，limit 生效
{
  const file = path.join(tmp, "runs.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ at: "2026-11-01T10:00:00.000Z", session: "s1", phase: "idle", rout: "miss", injected: [] }),
      "{半截行",
      JSON.stringify({ at: "2026-11-01T10:01:00.000Z", session: "s1", phase: "spec", rout: "hit", expert: "intake", injected: ["capability-router-state"] }),
      "",
    ].join("\n"),
    "utf8",
  );
  const runs = readRuns(file);
  assert.equal(runs.length, 2, "坏行应被跳过");
  assert.equal(readRuns(file, 1)[0].phase, "spec", "limit 取最后几条");
  assert.deepEqual(readRuns(path.join(tmp, "missing.jsonl")), []);
}

// 场景二：会话状态——坏文件跳过，按 since 倒序
{
  fs.writeFileSync(path.join(sessionsDir, "a.json"), JSON.stringify({ sessionId: "a", phase: "spec", experts: ["intake"], since: "2026-11-01T09:00:00.000Z" }), "utf8");
  fs.writeFileSync(path.join(sessionsDir, "b.json"), JSON.stringify({ sessionId: "b", phase: "build", experts: ["intake", "backend"], since: "2026-11-01T11:00:00.000Z" }), "utf8");
  fs.writeFileSync(path.join(sessionsDir, "broken.json"), "{oops", "utf8");
  fs.writeFileSync(path.join(sessionsDir, "notes.txt"), "忽略", "utf8");

  const sessions = readSessions(sessionsDir);
  assert.equal(sessions.length, 2, "坏文件与非 json 都不该进来");
  assert.equal(sessions[0].sessionId, "b", "最近的排前面");
  assert.deepEqual(readSessions(path.join(tmp, "nope")), []);
}

// 场景三：缺口聚合——同一句话计数、候选去重、按次数排序
{
  const file = path.join(tmp, "gaps.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ at: "2026-11-01T10:00:00.000Z", kind: "miss", text: "帮我搭个视频监控", candidates: [] }),
      JSON.stringify({ at: "2026-11-01T10:05:00.000Z", kind: "miss", text: "帮我搭个视频监控", candidates: [] }),
      JSON.stringify({ at: "2026-11-01T10:06:00.000Z", kind: "ambiguous", text: "SQL 为什么慢", candidates: ["backend", "data"] }),
    ].join("\n"),
    "utf8",
  );
  const gaps = readGaps(file);
  assert.equal(gaps[0].text, "帮我搭个视频监控");
  assert.equal(gaps[0].count, 2);
  assert.equal(gaps[0].last, "2026-11-01T10:05:00.000Z");
  assert.deepEqual(gaps[1].candidates, ["backend", "data"]);
  assert.equal(gaps[1].kinds[0], "ambiguous");
}

// 场景四：collect 把三份数据 + 体检结果装一起
{
  const data = collect(tmp, { doctor: { rows: [] }, experts: [{ id: "intake" }] });
  assert.equal(data.sessions.length, 2);
  assert.equal(data.gaps.length, 2);
  assert.equal(data.experts[0].id, "intake");
  assert.ok(typeof data.generatedAt === "string");
}

// 场景五：渲染——四个区块都在，用户输入被转义，没数据时给空态而不是白屏
{
  const html = renderHtml({
    generatedAt: "2026-11-01T12:00:00.000Z",
    sessions: [{ sessionId: "session-abcdefgh-1234", phase: "spec", experts: ["intake"], since: "2026-11-01T11:00:00.000Z" }],
    runs: [{ at: "2026-11-01T11:59:00.000Z", session: "s", phase: "spec", rout: "hit", expert: "intake", injected: ["capability-router-state"] }],
    gaps: [{ text: "<script>alert(1)</script>", count: 1, kinds: ["miss"], candidates: [], last: "" }],
    doctor: { rows: [{ id: "backend", kind: "worker", deps: [1, 2], missingRequired: [] }] },
  });
  for (const section of ["会话阶段", "最近 25 步", "缺口队列", "技能供给"]) {
    assert.ok(html.includes(section), `缺区块：${section}`);
  }
  assert.ok(html.includes("&lt;script&gt;"), "缺口原话必须转义");
  assert.ok(!html.includes("<script>alert(1)</script>"), "不该原样输出用户内容");
  assert.ok(html.includes("齐全"), "体检无缺口时应显示齐全");

  const empty = renderHtml({ generatedAt: "x", sessions: [], runs: [], gaps: [] });
  assert.ok(empty.includes("还没有会话进入项目模式"));
  assert.ok(empty.includes("没有落空记录"));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("场景一 runs 读取      ✓");
console.log("场景二 会话读取        ✓");
console.log("场景三 缺口聚合        ✓");
console.log("场景四 collect 组装    ✓");
console.log("场景五 渲染与转义      ✓");
console.log("面板数据层测试通过");
