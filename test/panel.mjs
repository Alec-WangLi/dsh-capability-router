import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, foldRuns, readGaps, readRuns, readSessions, renderHtml } from "../lib/panel.js";

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

// 场景六：带 sessionId 时只看这一个会话；缺口仍全局，并在标题上说明范围
{
  const runs = path.join(tmp, "runs.jsonl");
  fs.appendFileSync(
    runs,
    `${JSON.stringify({ at: "2026-11-01T11:00:00.000Z", session: "other", phase: "build", rout: "hit", expert: "backend", injected: [] })}\n`,
    "utf8",
  );

  const scoped = collect(tmp, { sessionId: "b" });
  assert.equal(scoped.scope, "b");
  assert.ok(scoped.sessions.every((row) => row.sessionId === "b"), "会话列表只剩这一个");
  assert.ok(scoped.runs.every((row) => row.session === "b"), "runs 只剩这一个会话的");

  const html = renderHtml(scoped);
  assert.match(html, /会话 b/, "标题要写清看的是哪个会话");
  assert.match(html, /缺口队列是全局的/);
  assert.ok(!html.includes("other"), "别的会话不该出现在这一页");

  const all = collect(tmp);
  assert.equal(all.scope, undefined);
  assert.ok(all.runs.some((row) => row.session === "other"), "不带参数时仍然看全部");
}

// 场景七（A13 渲染层 / F2）：会话卡第 3 行——「方案｜水平」，位置与文案都在。
// 后端给的结构：.k → .v(阶段) → .meta(方案｜水平) → .meta(在场) → .meta(自 …)。
// 这里断三件事：顺序不能变、三种取值的中文对、全角竖线（不是 `|`）。
{
  const html = renderHtml({
    generatedAt: "2026-11-02T04:00:00.000Z",
    sessions: [
      { sessionId: "s-null", phase: "spec", experts: ["intake"], since: "2026-11-02T03:00:00.000Z", approved: false, level: null },
      { sessionId: "s-novice", phase: "build", experts: ["intake", "backend"], since: "2026-11-02T03:10:00.000Z", approved: false, level: "novice" },
      { sessionId: "s-pro", phase: "review", experts: ["qa"], since: "2026-11-02T03:20:00.000Z", approved: true, level: "pro" },
    ],
    runs: [],
    gaps: [],
  });

  const cards = [
    ...html.matchAll(
      /<div class="card">\s*<div class="k">会话 [^<]*<\/div>\s*<div class="v phase-([a-z]+)">[^<]*<\/div>\s*<div class="meta">(方案：[^<]*)<\/div>\s*<div class="meta">在场：([^<]*)<\/div>/g,
    ),
  ];
  assert.equal(cards.length, 3, `应渲染出 3 张完整会话卡，实际 ${cards.length}`);
  assert.deepEqual(cards.map((card) => card[1]), ["spec", "build", "review"], "卡内顺序：阶段行在前");
  assert.deepEqual(
    cards.map((card) => card[2]),
    ["方案：待确认｜水平：未判定", "方案：待确认｜水平：新手", "方案：已确认｜水平：老手"],
    "方案与水平的中文说法、顺序、全角竖线都得对",
  );
  assert.deepEqual(cards.map((card) => card[3]), ["intake", "intake、backend", "qa"], "方案行必须夹在阶段与在场之间");

  // approved 只认严格 true：字符串 "true" 在渲染层也不能算确认；缺字段不许抛
  const legacySession = { sessionId: "s-legacy", phase: "idle", experts: [], since: "2026-11-01T00:00:00.000Z" };
  let legacyHtml;
  assert.doesNotThrow(() => {
    legacyHtml = renderHtml({ generatedAt: "x", sessions: [legacySession], runs: [], gaps: [] });
  }, "缺 approved / level 的老记录渲染不许抛");
  assert.ok(legacyHtml.includes("方案：待确认｜水平：未判定"), "缺字段时给默认值，不能留空白");

  const loose = renderHtml({
    generatedAt: "x",
    sessions: [{ ...legacySession, approved: "true", level: "expert" }],
    runs: [],
    gaps: [],
  });
  assert.ok(loose.includes("方案：待确认｜水平：未判定"), "脏数据（字符串 true / 未知水平）一律按未确认 + 未判定");
}

// 场景八（L6）：运行记录按句折叠——55 步的一句在表里只能占一行
{
  const many = [];
  for (let i = 0; i < 55; i += 1) {
    many.push({
      at: `2026-11-02T03:00:${String(i).padStart(2, "0")}.000Z`,
      session: "s-a",
      phase: "build",
      promptId: "p-1",
      rout: i === 0 ? "miss" : "hit",
      expert: i === 0 ? undefined : "backend",
      injected: i === 0 ? [] : ["capability-router-state"],
    });
  }
  many.push({ at: "2026-11-02T03:01:00.000Z", session: "s-a", phase: "build", promptId: "p-2", rout: "hit", expert: "review", injected: [] });

  const folded = foldRuns(many);
  assert.equal(folded.length, 2, "两句只该出两行");
  assert.equal(folded[0].steps, 55, "同一句 55 步要折成一行");
  assert.equal(folded[0].rout, "hit", "路由取最后一步");
  assert.equal(folded[0].expert, "backend", "专家名不能被前面那步的空值抹掉");
  assert.deepEqual(folded[0].injected, ["capability-router-state"], "注入类型取并集");
  assert.equal(folded[0].at, "2026-11-02T03:00:54.000Z", "时间取最后一次");
  assert.equal(folded[1].steps, 1, "单步的就该是 1");

  // 不同会话交错写进来：同 id 不相邻就不合并，否则会把别人那一步算到这句头上
  const interleaved = [
    { promptId: "x", session: "s1", at: "t1" },
    { promptId: "y", session: "s2", at: "t2" },
    { promptId: "x", session: "s1", at: "t3" },
  ];
  assert.equal(foldRuns(interleaved).length, 3, "不相邻的同 id 不许跨行合并");
  assert.equal(foldRuns([{ at: "a" }, { at: "b" }]).length, 2, "缺 promptId 的老记录不许合并");

  // 渲染层：先折叠再截断，否则 25 行会被一句话占满
  const html = renderHtml({ generatedAt: "x", sessions: [], runs: many, gaps: [] });
  assert.ok(html.includes("×55"), "折叠后的步数要显示出来");
  assert.equal((html.match(/backend/g) ?? []).length, 1, "55 步在表里只占一行");

  // 截断顺序：25 句进来，表里要出 25 行
  const wide = [];
  for (let i = 0; i < 30; i += 1) wide.push({ at: `2026-11-02T04:00:${String(i).padStart(2, "0")}.000Z`, session: "s-a", phase: "build", promptId: `w-${i}`, rout: "hit", expert: "backend", injected: [] });
  const wideHtml = renderHtml({ generatedAt: "x", sessions: [], runs: wide, gaps: [] });
  assert.equal((wideHtml.match(/backend/g) ?? []).length, 25, "折叠后截断，表里应有 25 句而不是 1 句");
}

// 场景九（v0.20.6）：会话镜像过期时，面板要以项目状态为准
// 同一个项目被几个会话接手时，各会话文件里的 phase 停在推它的那一刻。
// 面板照抄镜像，用户会同时看见三个不一样的「现在」——而 pre-step 一直按项目文件判。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-panel-proj-"));
  const project = path.join(root, "proj");
  const projDir = path.join(project, ".capability-router");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, "state.json"),
    JSON.stringify({ sessionId: "project", phase: "review", experts: ["backend", "review"], since: "2026-11-01T00:00:00.000Z", project }, null, 2),
    "utf8",
  );
  const dir2 = path.join(root, "sessions");
  fs.mkdirSync(dir2, { recursive: true });
  const mkSession = (id, phase) =>
    fs.writeFileSync(
      path.join(dir2, `${id}.json`),
      JSON.stringify({ sessionId: id, phase, experts: ["backend"], since: "2026-11-01T00:00:00.000Z", project }),
      "utf8",
    );
  mkSession("sess-stale-build", "build");
  mkSession("sess-stale-idle", "idle");
  fs.writeFileSync(path.join(root, "runs.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(root, "gaps.jsonl"), "", "utf8");

  const snap = collect(root);
  assert.equal(snap.sessions.length, 2);
  for (const row of snap.sessions) {
    assert.equal(row.phase, "review", `${row.sessionId} 的阶段要跟项目走，不是跟镜像走`);
    assert.equal(row.fromProject, true);
    assert.deepEqual(row.experts, ["backend", "review"], "在场专家也要以项目为准");
  }

  // 项目文件没了 → 退回镜像，并标 fromProject:false，让人知道这份可能过期
  fs.rmSync(projDir, { recursive: true, force: true });
  const stale = collect(root);
  assert.equal(stale.sessions[0].fromProject, false, "项目文件没了要说清这是镜像");
  assert.equal(stale.sessions[0].phase, "build");
  fs.rmSync(root, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("场景一 runs 读取      ✓");
console.log("场景二 会话读取        ✓");
console.log("场景三 缺口聚合        ✓");
console.log("场景四 collect 组装    ✓");
console.log("场景五 渲染与转义      ✓");
console.log("场景六 按会话过滤      ✓");
console.log("场景七 方案与水平行    ✓");
console.log("场景八 按句折叠        ✓");
console.log("场景九 项目状态覆盖镜像 ✓");
console.log("面板数据层测试通过");
