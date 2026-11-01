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
  assert.equal(idle.note, undefined, "空闲会话没有闸门提醒");
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

  const back = await tool.execute({ name: "intake", phase: "spec" }, { agent: { id: "sess-4" } });
  assert.match(back.note ?? "", /只能往前走/);
  const after = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "sessions", "sess-4.json"), "utf8"));
  assert.equal(after.phase, "build", "被拒绝的推进不该改状态");
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

fs.rmSync(HOME, { recursive: true, force: true });

console.log("场景一 目录压制角色    ✓");
console.log("场景二 状态卡取代检查点 ✓");
console.log("场景三 runs 记账       ✓");
console.log("场景四 工具推进状态    ✓");
console.log("场景五 project 可关    ✓");
console.log("场景六 显式交卷        ✓");
console.log("项目模式测试通过");
