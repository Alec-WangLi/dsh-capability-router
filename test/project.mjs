import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 项目模式的集成测试：真实 lib/index.js × 假宿主。
 * 验三件事——目录在场时不再重复注入角色、有状态时检查点降级成状态卡、打开专家会推进状态。
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-project-"));
process.env.DSH_HOME = HOME;
const STATE_DIR = path.join(HOME, "capability-router");

const plugin = await import("../lib/index.js");

function createFakeContext() {
  const handlers = new Map();
  const sections = [];
  const tools = [];
  const warnings = [];
  const ctx = {
    logger: { warn: (message) => warnings.push(message), info: () => {} },
    effect(factory) {
      factory();
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    systemPrompt: { section: (section) => sections.push(section) },
    skills: { register: () => () => {} },
    tools: { register: (definition) => tools.push(definition) },
  };
  return { ctx, handlers, sections, tools, warnings };
}

function userMessage(id, text) {
  return { role: "user", id, content: [{ type: "text", text }], source: { kind: "user" } };
}

async function step(handler, agentId, messages) {
  return handler({ agent: { id: agentId }, messages }, async () => ({ kind: "continue", messages }));
}

// 场景一：目录在场 → 命中专家也不再注入角色（选人交给模型），检查点照常
{
  const { ctx, handlers, warnings } = createFakeContext();
  plugin.apply(ctx, {});
  assert.deepEqual(warnings, [], `挂载不该有告警：${warnings.join(" | ")}`);
  const handler = handlers.get("agent/pre-step");
  const messages = [userMessage("p1", "登录页的样式在窄屏下全乱了")];
  const decision = await step(handler, "sess-1", messages);

  const kinds = decision.messages.map((message) => message.source?.kind);
  assert.ok(!kinds.includes("capability-router-role"), "目录在场时不该再注入角色（会跟目录唱反调）");
  assert.ok(kinds.includes("capability-router-hint"), "普通对话仍然有检查点");
}

// 场景二+三：会话有状态（spec）→ 状态卡取代检查点，缺口闭嘴，runs.jsonl 记一条
{
  fs.mkdirSync(path.join(STATE_DIR, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(STATE_DIR, "sessions", "sess-2.json"),
    JSON.stringify({ sessionId: "sess-2", phase: "spec", experts: ["intake"], since: new Date().toISOString() }),
    "utf8",
  );

  const { ctx, handlers } = createFakeContext();
  plugin.apply(ctx, {});
  const handler = handlers.get("agent/pre-step");

  const messages = [userMessage("p2", "帮我做视频监控系统")];
  const decision = await step(handler, "sess-2", messages);
  const injected = decision.messages.filter((message) => message.source?.kind !== "user");
  const kinds = injected.map((message) => message.source?.kind);

  assert.deepEqual(kinds, ["capability-router-state"], `项目模式只该有状态卡，实际：${kinds.join(",")}`);
  const card = injected[0].content[0].text;
  assert.match(card, /项目模式/);
  assert.match(card, /需求确认（spec）/);

  const runs = fs.readFileSync(path.join(STATE_DIR, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const last = runs[runs.length - 1];
  assert.equal(last.session, "sess-2");
  assert.equal(last.phase, "spec");
  assert.deepEqual(last.injected, ["capability-router-state"]);
  assert.ok(!("text" in last), "runs 里不记原话，原话在 gaps.jsonl");
}

// 场景四：expert 工具推进状态——spec 阶段打开 worker 会带回闸门提醒
{
  const { ctx, tools } = createFakeContext();
  plugin.apply(ctx, {});
  const tool = tools.find((definition) => definition.name === "expert");
  assert.ok(tool !== undefined, "应注册 expert 工具");

  const result = await tool.execute({ name: "backend" }, { agent: { id: "sess-2" } });
  assert.equal(result.found, true);
  assert.match(result.note ?? "", /需求还没确认/);

  const saved = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "sessions", "sess-2.json"), "utf8"));
  assert.equal(saved.phase, "spec", "开 worker 不该推进阶段");
  assert.deepEqual(saved.experts, ["intake", "backend"]);

  const idle = await tool.execute({ name: "frontend" }, { agent: { id: "sess-3" } });
  // 2026-11-02 复盘：整场没打开过接单专家，直接叫领域专家开工，于是没有验收标准、
  // 也没人收口。跳过接单是最容易犯的错，所以在 idle 的第一次开口说一句。
  assert.match(idle.note ?? "", /还没接单/, "空闲会话第一次叫领域专家应提醒先接单");
  const fresh = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "sessions", "sess-3.json"), "utf8"));
  assert.deepEqual(fresh.experts, ["frontend"]);
  assert.equal(fresh.phase, "idle");
}

// 场景六：模型显式交卷——expert("intake", { phase: "build" }) 推进状态，回退会被拒绝
{
  const { ctx, tools } = createFakeContext();
  plugin.apply(ctx, {});
  const tool = tools.find((definition) => definition.name === "expert");

  const built = await tool.execute({ name: "intake", phase: "build" }, { agent: { id: "sess-4" } });
  assert.equal(built.found, true);
  const saved = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "sessions", "sess-4.json"), "utf8"));
  assert.equal(saved.phase, "build", "spec 由 openExpert 推进，build 由显式 phase 推进");

  // 推进到 build 之后再开 worker：闸门必须闭嘴（它之前会拿旧状态喊「先别开工」）
  const worker = await tool.execute({ name: "backend" }, { agent: { id: "sess-4" } });
  assert.equal(worker.found, true);
  assert.ok(!(worker.note ?? "").includes("需求还没确认"), `进 build 后不该再提醒需求未确认：${worker.note}`);

  const review = await tool.execute({ name: "review", phase: "review" }, { agent: { id: "sess-4" } });
  assert.equal(review.found, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(STATE_DIR, "sessions", "sess-4.json"), "utf8")).phase, "review", "跨一格也允许");

  const back = await tool.execute({ name: "intake", phase: "spec" }, { agent: { id: "sess-4" } });
  assert.match(back.note ?? "", /只能往前走/);
  const after = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "sessions", "sess-4.json"), "utf8"));
  assert.equal(after.phase, "review", "被拒绝的推进不该改状态（此时已推进到 review）");
}

// 场景七：项目级状态——两个会话接手同一个项目，共用一个阶段
{
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-proj-"));
  const { ctx, tools, handlers } = createFakeContext();
  plugin.apply(ctx, {});

  const tool = tools.find((definition) => definition.name === "expert");
  const a = await tool.execute({ name: "intake", project: projectDir }, { agent: { id: "sess-A" } });
  assert.equal(a.found, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectDir, ".capability-router", "state.json"), "utf8")).phase, "spec");

  // 第二个会话接手：只给项目路径，阶段应直接看到 spec，并被闸门提醒「先别开工」
  const b = await tool.execute({ name: "backend", project: projectDir }, { agent: { id: "sess-B" } });
  assert.match(b.note ?? "", /需求还没确认/, "接手方要看得到项目当前阶段");

  const sessionB = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "sessions", "sess-B.json"), "utf8"));
  assert.equal(sessionB.project, projectDir, "会话文件里要留项目指针");
  assert.equal(sessionB.phase, "spec", "阶段镜像与项目一致");

  // 会话 B 的 pre-step 应直接进入项目模式
  const handler = handlers.get("agent/pre-step");
  const messages = [userMessage("p7", "继续")];
  const decision = await handler({ agent: { id: "sess-B" }, messages }, async () => ({ kind: "continue", messages }));
  const injected = decision.messages.filter((message) => message.source?.kind !== "user");
  assert.deepEqual(injected.map((message) => message.source?.kind), ["capability-router-state"], "项目阶段要能跨会话生效");
}

// 场景五：关掉 project 就当没有状态——检查点回来
{
  const { ctx, handlers } = createFakeContext();
  plugin.apply(ctx, { project: false });
  const handler = handlers.get("agent/pre-step");
  const messages = [userMessage("p5", "帮我做视频监控系统")];
  const decision = await step(handler, "sess-2", messages);
  const kinds = decision.messages.map((message) => message.source?.kind);
  assert.ok(!kinds.includes("capability-router-state"));
  assert.ok(kinds.includes("capability-router-hint"));
}

// 场景八：长任务里宿主只给增量消息——找不到人话也要继续工作
// 2026-11-02 实测：子代理一个任务跑 139 步，`runs.jsonl` 只写了 1 行、状态卡一次没进。
// 根因是后续步的 messages 里不再带 `source.kind === "user"` 的消息，`lastUserPrompt()`
// 返回 undefined，插件在 `if (prompt === undefined) return decision;` 处整场下班。
{
  const { ctx, handlers } = createFakeContext();
  plugin.apply(ctx, {});
  const handler = handlers.get("agent/pre-step");
  const messages = [userMessage("p-long", "帮我做视频监控系统")];
  await handler({ agent: { id: "sess-long" }, messages }, async () => ({ kind: "continue", messages }));

  // 第二步：只剩工具日志，没有任何 kind === "user" 的消息
  const toolOnly = [
    {
      role: "user",
      id: "tool-1",
      content: [{ type: "text", text: "命令输出：OK" }],
      source: { kind: "tool-jobs" },
    },
  ];
  const second = await handler({ agent: { id: "sess-long" }, messages: toolOnly }, async () => ({
    kind: "continue",
    messages: toolOnly,
  }));
  assert.ok(Array.isArray(second.messages), "找不到人话也不该崩");

  const rows = fs
    .readFileSync(path.join(STATE_DIR, "runs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.session === "sess-long");
  assert.ok(rows.length >= 2, `长任务的后续步骤也要记账，实际 ${rows.length} 行`);
}

// 场景九：长任务里状态卡按步数补，不是只说一次
// 一条消息里模型连跑上百步，如果状态卡只在第一步贴一次，后面它早就忘了自己在哪个阶段。
// 期望：同一条人话内，阶段变化立刻再说一次，否则每 STATE_EVERY(10) 步补一次。
{
  const { ctx, handlers, tools } = createFakeContext();
  plugin.apply(ctx, {});
  const tool = tools.find((definition) => definition.name === "expert");
  const dir = fs.mkdtempSync(path.join(HOME, "long-"));
  await tool.execute({ name: "intake", project: dir }, { agent: { id: "sess-long2" } });

  const handler = handlers.get("agent/pre-step");
  const first = [userMessage("p-l2", "继续做")];
  let stateCount = 0;
  for (let index = 0; index < 12; index += 1) {
    // 第二步起 messages 里没有 kind === "user" 的消息——这正是宿主的增量形态
    const input =
      index === 0
        ? first
        : [{ role: "user", id: `tool-${index}`, content: [{ type: "text", text: "工具输出：OK" }], source: { kind: "tool-jobs" } }];
    const decision = await handler({ agent: { id: "sess-long2" }, messages: input }, async () => ({
      kind: "continue",
      messages: input,
    }));
    const kinds = (decision.messages ?? []).map((message) => message.source?.kind);
    if (kinds.includes("capability-router-state")) stateCount += 1;
  }
  assert.ok(stateCount >= 2, `12 步里状态卡至少要补一次，实际 ${stateCount} 次`);
}

// 场景十（A1–A6）：`expert()` 真的落盘——水平、确认、推进自动确认、撤销、闸门两句。
// 前面 state-level.mjs 测的是纯函数，这里走真实 lib/index.js 的 onOpen 链路：
// 参数 → setLevel/setApproved → advancePhase → gateNote → 写盘，中间任何一环漏了这里都会红。
{
  const { ctx, tools } = createFakeContext();
  plugin.apply(ctx, {});
  const tool = tools.find((definition) => definition.name === "expert");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-level-"));
  const statePath = path.join(projectDir, ".capability-router", "state.json");
  const readProjectState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));

  // A1：新项目接单 → approved: false；没人问过水平，就不该凭空写一个 level
  await tool.execute({ name: "intake", project: projectDir }, { agent: { id: "sess-10a" } });
  const fresh = readProjectState();
  assert.equal(fresh.approved, false, "新项目默认未确认");
  assert.equal(fresh.phase, "spec");
  assert.equal(Object.hasOwn(fresh, "level"), false, "没问过水平就不该写 level");

  // A2：问过水平 → 落盘
  await tool.execute({ name: "intake", project: projectDir, level: "novice" }, { agent: { id: "sess-10b" } });
  assert.equal(readProjectState().level, "novice", "level 要落盘");
  await tool.execute({ name: "intake", project: projectDir, level: "pro" }, { agent: { id: "sess-10b" } });
  assert.equal(readProjectState().level, "pro", "改水平要覆盖掉旧值");

  // A5：spec 阶段开 worker 要提醒；level 已判定就不再追问
  const dev = await tool.execute({ name: "backend", project: projectDir }, { agent: { id: "sess-10c" } });
  assert.match(dev.note ?? "", /先别开工/, "spec 阶段开领域专家要给闸门");
  assert.equal((dev.note ?? "").includes("先问一句用户想听多细"), false, "level 判定过就不该再问");

  // A3：推进到 build → 自动视为方案已确认
  await tool.execute({ name: "intake", project: projectDir, phase: "build" }, { agent: { id: "sess-10d" } });
  const built = readProjectState();
  assert.equal(built.phase, "build");
  assert.equal(built.approved, true, "推进到 build 且没显式传 approved 时自动确认");

  // A4：显式撤销
  await tool.execute({ name: "intake", project: projectDir, approved: false }, { agent: { id: "sess-10e" } });
  assert.equal(readProjectState().approved, false, "approved:false 要能撤销");

  // A5 的另一半 + A6：另一个还没判定水平的项目，开 worker 要多问一句，开 research 要 PRIOR-ART
  const youngDir = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-level2-"));
  await tool.execute({ name: "intake", project: youngDir }, { agent: { id: "sess-10f" } });
  const youngDev = await tool.execute({ name: "backend", project: youngDir }, { agent: { id: "sess-10g" } });
  assert.match(youngDev.note ?? "", /先问一句用户想听多细/, "level 未判定时要追问");

  const scout = await tool.execute({ name: "research", project: youngDir }, { agent: { id: "sess-10h" } });
  assert.equal(scout.kind, "scout", "research 的 kind 要活到工具返回里");
  assert.match(scout.note ?? "", /PRIOR-ART\.md/);
  assert.equal((scout.note ?? "").includes("先别开工"), false, "调研专家不说先别开工");
}

fs.rmSync(HOME, { recursive: true, force: true });

console.log("场景一 目录压制角色    ✓");
console.log("场景二 状态卡取代检查点 ✓");
console.log("场景三 runs 记账       ✓");
console.log("场景四 工具推进状态    ✓");
console.log("场景五 project 可关    ✓");
console.log("场景六 显式交卷        ✓");
console.log("场景七 项目级阶段      ✓");
console.log("场景八 长任务不早退    ✓");
console.log("场景九 长任务补状态卡  ✓");
console.log("场景十 水平与确认落盘  ✓");
console.log("项目模式测试通过");
