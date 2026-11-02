import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, foldRuns, gapSuggestion, groupProjects, readGaps, readRuns, readSessions, renderHtml } from "../lib/panel.js";

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
      JSON.stringify({ at: "2026-11-01T10:00:00.000Z", kind: "miss", text: "帮我搭个视频监控", candidates: [], lang: "zh" }),
      JSON.stringify({ at: "2026-11-01T10:05:00.000Z", kind: "miss", text: "帮我搭个视频监控", candidates: [], lang: "en" }),
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
  // 语言分布：同一句话中英都落空过，说明不是「英文没人接」这一个原因。
  assert.deepEqual(gaps[0].langs, ["zh", "en"], "语言去重且保序");
  // 没有 lang 键的老行按中文读——写入口径是「中文是基线，只记非中文」。
  assert.deepEqual(gaps[1].langs, ["zh"], "缺 lang 键 = 中文，不是「不明」");

  // 结论列：内部值翻成人话，且同一句 miss 在需求期与实现期给的下一步动作不同。
  assert.match(gapSuggestion({ kinds: ["miss"], phases: ["spec"] }), /补触发词/);
  assert.match(gapSuggestion({ kinds: ["miss"], phases: ["build"] }), /造一个新专家/);
  assert.match(gapSuggestion({ kinds: ["ambiguous"], phases: [] }), /两个专家在抢/);
  // 这条分支以前没人测：`miss` 但阶段既不是需求期、也不在建/审/交期（比如 idle 或没记阶段），
  // 它走的是「先看是不是新领域」——删掉这个分支，20 套测试仍然全绿，说明断言漏了一格。
  assert.match(gapSuggestion({ kinds: ["miss"], phases: ["idle"] }), /没人接/);
  assert.match(gapSuggestion({ kinds: ["miss"], phases: [] }), /没人接/, "没记阶段也走同一条");
  assert.match(gapSuggestion({ kinds: ["cross"], phases: ["build"] }), /跨领域/);
  assert.match(gapSuggestion({ kinds: [], phases: [] }, "en"), /^watch it/, "英文页给英文结论");

  // 阶段要跟着聚合：同一句话在「需求确认」和「实现」阶段落空，意思完全不同——
  // 前者说明词表没收住需求，后者说明该补一个专家。v0.20.1 之前的老行没有 phase，空着。
  assert.deepEqual(gaps[0].phases, [], "老行没有 phase 就是空数组，不是 undefined");
  const phased = path.join(tmp, "gaps-phase.jsonl");
  fs.writeFileSync(
    phased,
    [
      JSON.stringify({ at: "2026-11-02T10:00:00.000Z", kind: "miss", text: "帮我搭个视频监控", phase: "build" }),
      JSON.stringify({ at: "2026-11-02T10:01:00.000Z", kind: "miss", text: "帮我搭个视频监控", phase: "spec" }),
      JSON.stringify({ at: "2026-11-02T10:02:00.000Z", kind: "miss", text: "帮我搭个视频监控", phase: "build" }),
      JSON.stringify({ at: "2026-11-02T10:03:00.000Z", kind: "miss", text: "帮我搭个视频监控" }),
    ].join(String.fromCharCode(10)),
    "utf8",
  );
  const withPhase = readGaps(phased)[0];
  assert.deepEqual(withPhase.phases, ["build", "spec"], "阶段去重且保序，缺的不占位");
  assert.equal(withPhase.count, 4, "计数不受 phase 影响");
}

// 场景四：collect 把三份数据 + 体检结果装一起
{
  const data = collect(tmp, { doctor: { rows: [] }, experts: [{ id: "intake" }] });
  assert.equal(data.sessions.length, 2);
  assert.equal(data.gaps.length, 2);
  assert.equal(data.experts[0].id, "intake");
  assert.ok(typeof data.generatedAt === "string");
  // v0.22.0：概览条要的版本与数据目录在快照里，渲染层不用自己去猜/去读文件。
  assert.match(data.version, /^\d+\.\d+\.\d+$/, "版本号要能显示出来（重启后跑的是哪一版）");
  assert.equal(data.stateDir, tmp, "数据目录原样带出来");
  // 会话按项目合并：没有 project 的两条各自成组，所以 projects 也是 2。
  assert.equal(data.projects.length, 2, "没有 project 的会话各自成组");
  assert.ok(Array.isArray(data.projects[0].sessions), "组里要能数出几个会话");
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
  // v0.22.0 起区块是六块：概览条 + 项目阶段 / 专家名册 / 最近 25 句 / 缺口队列 / 技能供给。
  // 「最近 25 步」改成「句」不是换个说法：表里一行是一句话（多步折叠成一行），
  // 标题写「步」会让人以为跑了 25 步，实际是 25 句。
  for (const section of ["项目阶段", "专家名册", "最近 25 句", "缺口队列", "技能供给"]) {
    assert.ok(html.includes(section), `缺区块：${section}`);
  }
  assert.ok(!html.includes("最近 25 步"), "单位是句，不是步");
  assert.ok(html.includes('id="overview"'), "概览条要在");
  // 轮询靠这六个 id 换内容：id 一改名，页面就静默停更——不报错、不白屏，
  // 只是永远停在打开那一刻。这种坏法只有断言能抓住。
  for (const id of ["overview", "projects", "experts", "runs", "gaps", "doctor"]) {
    assert.ok(html.includes(`id="${id}"`), `轮询要换的区块 ${id} 必须在页面上`);
  }
  assert.ok(!/http-equiv="refresh"/.test(html), "不许整页自动刷新——滚动位置会被打回顶部");
  assert.ok(html.includes("&lt;script&gt;"), "缺口原话必须转义");
  assert.ok(!html.includes("<script>alert(1)</script>"), "不该原样输出用户内容");
  assert.ok(html.includes("齐全"), "体检无缺口时应显示齐全");
  // 缺口表要带阶段：同一句话在「需求确认」和「实现」阶段落空，意思完全不同。
  assert.match(html, /<th>原话<\/th><th>次数<\/th><th>阶段<\/th>/, "缺口表要有阶段列（跟运行表的阶段列区分开）");
  // v0.22.0：语言与最近时间两列，「结论」列给的是中文建议而不是 miss / ambiguous / cross 这种内部值。
  assert.match(html, /<th>语言<\/th><th>最近<\/th><th>结论<\/th>/, "缺口表要带语言 / 最近 / 结论三列");
  assert.ok(!html.includes("<td>miss</td>"), "内部值不该直接印在结论列上");
  assert.ok(html.includes("没人接") || html.includes("该造一个新专家") || html.includes("先观察"), "结论列要给出下一步动作");

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
  // 切语言必须带着 session 走：会话页 iframe 里点一下 English，
  // 地址要是只剩 ?lang=en，面板就跳出当前会话范围了（v0.21 的老毛病）。
  assert.match(html, /\?lang=en&amp;session=b/, "语言切换链接要保留 session 参数");

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

// 场景十一（v0.22.0）：同一个项目的 N 个会话，在面板上只该是一张卡。
// 老行为是按会话铺卡：重启三次就三张一模一样的「实现 · 在场 backend、review」，
// 用户分不清是三个项目还是一个项目被接手了三次。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-group-"));
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const project = path.join(root, "proj-a");
  fs.mkdirSync(path.join(project, ".capability-router"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".capability-router", "state.json"),
    JSON.stringify({ phase: "build", experts: ["backend"], approved: true, level: "pro" }),
    "utf8",
  );
  // 三条镜像故意停在不同的阶段（spec / spec / idle）：项目文件在的时候它们都该被纠正成 build，
  // 项目文件一没，三条各说各话——那正是冲突要报出来的情况。
  for (const [id, since, phase] of [
    ["s-1", "2026-11-02T10:00:00.000Z", "spec"],
    ["s-2", "2026-11-02T09:00:00.000Z", "spec"],
    ["s-3", "2026-11-02T08:00:00.000Z", "idle"],
  ]) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ sessionId: id, phase, experts: [], since, project }), "utf8");
  }
  const snap = collect(root);
  assert.equal(snap.sessions.length, 3, "三条镜像都还在（快照不丢数据）");
  assert.equal(snap.projects.length, 1, "同一个项目只该有一组");
  assert.equal(snap.projects[0].sessions.length, 3, "组里三个会话都要列出来");
  assert.equal(snap.projects[0].phase, "build", "组的状态取项目文件，不是某个镜像");
  assert.equal(snap.projects[0].conflict, false, "都读得到项目文件时不该报冲突");

  const html = renderHtml(snap);
  assert.equal((html.match(/<div class="card">/g) ?? []).length, 1, "三张重复卡要合成一张");
  assert.match(html, /会话 3 个/, "卡片上要说清这个项目被几个会话接手");

  // 组内阶段不一致 = 有会话读不到项目文件、退回的是过期镜像，必须说出来
  fs.rmSync(path.join(project, ".capability-router"), { recursive: true, force: true });
  const staleGroup = collect(root);
  assert.equal(staleGroup.projects[0].conflict, true, "镜像阶段不一致要标冲突");
  assert.match(renderHtml(staleGroup), /组内阶段不一致/);

  // 卡片上限 8 张，但概览条印的是全量计数：多出来的必须说出来，
  // 否则「概览说 10 个项目、屏幕只有 8 张卡」看起来就是项目丢了。
  const many = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-many-"));
  const manySessions = path.join(many, "sessions");
  fs.mkdirSync(manySessions, { recursive: true });
  for (let index = 0; index < 10; index += 1) {
    const proj = path.join(many, `proj-${index}`);
    fs.mkdirSync(path.join(proj, ".capability-router"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".capability-router", "state.json"),
      JSON.stringify({ phase: "build", experts: [], approved: false, level: null }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(manySessions, `m-${index}.json`),
      JSON.stringify({ sessionId: `m-${index}`, phase: "build", experts: [], since: `2026-11-02T1${index}:00:00.000Z`, project: proj }),
      "utf8",
    );
  }
  const manySnap = collect(many);
  const manyHtml = renderHtml(manySnap);
  assert.equal(manySnap.projects.length, 10, "十个项目十组");
  assert.equal((manyHtml.match(/<div class="card">/g) ?? []).length, 8, "卡片只铺 8 张");
  assert.match(manyHtml, /还有 2 个项目没画/, "截断必须说出来，不能只截不报");
  assert.match(manyHtml, /项目 <b>10<\/b>/, "概览条印的是全量计数");
  fs.rmSync(many, { recursive: true, force: true });

  // 两个项目截成同样的「…/app/docs」就分不清了（只靠 title 悬停不算分清）。
  // 撞名时多留一段，直到能分开为止。
  const twin = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-twin-"));
  const twinSessions = path.join(twin, "sessions");
  fs.mkdirSync(twinSessions, { recursive: true });
  [path.join(twin, "work", "app", "docs"), path.join(twin, "backup", "app", "docs")].forEach((proj, index) => {
    fs.mkdirSync(path.join(proj, ".capability-router"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".capability-router", "state.json"),
      JSON.stringify({ phase: "build", experts: [], approved: false, level: null }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(twinSessions, `t-${index}.json`),
      JSON.stringify({ sessionId: `t-${index}`, phase: "build", experts: [], since: "2026-11-02T10:00:00.000Z", project: proj }),
      "utf8",
    );
  });
  const twinHtml = renderHtml(collect(twin));
  assert.match(twinHtml, /…\/work\/app\/docs/, "撞名时多留一段，要能分出是哪个项目");
  assert.match(twinHtml, /…\/backup\/app\/docs/, "另一个也要留到能分开");
  fs.rmSync(twin, { recursive: true, force: true });

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

// 场景十（v0.21.6）：面板跟人走，不跟数据走。同一份快照，语言由 ?lang= 决定。
// 为什么要有这一条：v0.21.0 把动态注入全翻了，面板一个字没动——
// 英文用户打开面板看到的还是中文，等于英文适配在最后一步断掉。
{
  const data = {
    sessions: [
      {
        sessionId: "abc12345-0000-0000-0000-000000000000",
        phase: "build",
        approved: false,
        level: "pro",
        experts: ["intake", "backend"],
        since: "2026-11-02T10:00:00Z",
        project: "C:/p",
      },
    ],
    runs: [],
    gaps: [],
    // 名册故意用真名（中文）：以前这里喂纯 ASCII，于是「英文页无汉字」恒绿，
    // 而真页上排除 style/script 后有 200+ 段汉字——断言测的是夹具，不是产品。
    experts: [
      { id: "backend", name: "后端工程师", kind: "worker", triggers: ["接口", "数据模型"], deliverables: ["接口定义"], missing: [] },
    ],
    generatedAt: "2026-11-02 14:40",
  };
  const han = /[\u4e00-\u9fff]/;
  // 只看「人读到的字」：<style> 与 <script> 里的注释不算正文（页面里那段轮询脚本
  // 带中文注释，它不进渲染结果，也不该被当成翻译漏项）。
  //
  // 而且「英文页一个汉字都没有」只对**框架文案**成立，对内容既不成立也不该成立：
  // 专家名 / 触发词 / 产出走静态层（L11：翻两份 = 每个语言一套缓存键），
  // 项目路径与用户原话更是数据。所以断言收窄到标题、表头、概览条这三类，
  // 内容照旧按原样输出——这一条另有断言盯着。
  const chrome = (html) => {
    const picked =
      html.match(
        /<h1[^>]*>[\s\S]*?<\/h1>|<h2[^>]*>[\s\S]*?<\/h2>|<th[^>]*>[\s\S]*?<\/th>|<span class="chip"[^>]*>[\s\S]*?<\/span>/g,
      ) ?? [];
    return picked.join(" ").replace(/<[^>]+>/g, " ");
  };

  const zh = renderHtml(data);
  const en = renderHtml(data, "en");

  assert.ok(han.test(chrome(zh)), "默认是中文");
  assert.ok(!han.test(chrome(en)), "英文面板的框架文案（标题 / 表头 / 概览条）不能有汉字");
  assert.ok(en.includes("后端工程师"), "名册本体仍是中文——L11 的既定取舍，别当漏翻");
  assert.ok(en.includes('lang="en"'), "文档语言要跟着变");
  assert.ok(en.includes("?lang=zh"), "英文页要给一个切回中文的入口");
  assert.ok(zh.includes("?lang=en"), "中文页要给一个切到英文的入口");
  assert.ok(/build/.test(en) && en.includes("experienced"), "阶段名与水平名走英文表");
  assert.ok(en.includes("unconfirmed"), "方案状态也要翻");
}
console.log("场景十 面板双语          ✓");
console.log("场景十一 项目分组        ✓");

console.log("面板数据层测试通过");
