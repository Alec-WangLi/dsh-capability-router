import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 假 ctx：只实现 apply() 真正用到的那几个面。
 * pre-step 的 handler 会被捕获下来，供下面手动触发。
 */
function createFakeContext() {
  const handlers = new Map();
  const effects = [];
  const sections = [];
  const skills = [];
  const logs = [];

  const ctx = {
    logger: {
      warn: (message) => logs.push(message),
      info: () => {},
    },
    effect(factory, label) {
      const disposer = factory();
      effects.push({ label, disposer });
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    systemPrompt: {
      section(options) {
        sections.push(options);
        return () => {};
      },
    },
    skills: {
      register(skill) {
        skills.push(skill);
        return () => {};
      },
    },
  };

  return { ctx, handlers, effects, sections, skills, logs };
}

/** 构造一条真人消息，形状与宿主一致。 */
function userMessage(id, text) {
  return { role: "user", id, content: [{ type: "text", text }], source: { kind: "user" } };
}

/** 构造一条系统注入的 user 角色消息。 */
function injectedMessage(id, kind) {
  return { role: "user", id, content: [{ type: "text", text: kind }], source: { kind } };
}

/** 调一次 pre-step，返回 decision。 */
async function runPreStep(handler, messages) {
  return handler({ messages }, async () => ({ kind: "continue", messages }));
}

// 测试不碰真实状态目录
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-test-"));
process.env.DSH_HOME = TEST_HOME;

const plugin = await import("../lib/index.js");
const { ctx, handlers, sections, skills, logs } = createFakeContext();

// 本文件只测检查点，关掉角色注入让断言数与文案保持稳定；角色注入单独在场景十测。
plugin.apply(ctx, { role: false, gap: false });
assert.deepEqual(logs, [], `挂载过程不应有告警：${logs.join(" | ")}`);
assert.equal(sections.length, 2, "应注册原则段与专家目录两段系统提示");
assert.equal(sections[0].name, "capability-intake");
assert.ok(sections[0].text.includes("能力路由"), "原则段应包含标题");
assert.equal(sections[1].name, "capability-experts");
assert.ok(sections[1].text.includes("可用专家"), "专家目录应包含标题");
assert.ok(sections[1].order > sections[0].order, "目录排在原则段之后");
assert.equal(skills.length, 1, "应注册一个自检技能");
assert.equal(skills[0].name, "capability-router");

const preStep = handlers.get("agent/pre-step");
assert.ok(typeof preStep === "function", "应挂钩 agent/pre-step");

// 场景一：用户刚说完一句，历史里只有它 → 应注入一条检查点
const promptId = "prompt-1";
const first = await runPreStep(preStep, [
  injectedMessage("a1", "agent-instructions"),
  userMessage(promptId, "这个功能为什么不生效？"),
  injectedMessage("a2", "time-context"),
]);
assert.equal(first.kind, "continue");
assert.equal(first.messages.length, 4, "应追加一条消息");
const hint = first.messages[3];
assert.equal(hint.role, "user");
assert.equal(hint.source.kind, "capability-router-hint");
assert.equal(hint.source.forPrompt, promptId);
assert.ok(hint.content[0].text.includes("提问"), "检查点应含归类提示");
assert.ok(Object.isFrozen(hint), "注入的消息应被冻结");

// 场景二：同一条用户消息再跑一步（工具调用后）→ 不应重复注入
const second = await runPreStep(preStep, first.messages);
assert.equal(second.messages.length, 4, "同一句话只注入一次");

// 场景三：用户说了新的一句 → 应再注入一条
const third = await runPreStep(preStep, [
  ...first.messages,
  userMessage("prompt-2", "那就改成 pre-step 注入"),
]);
assert.equal(third.messages.length, 6, "新的用户消息应再注入一条");
const hints = third.messages.filter((m) => m.source?.kind === "capability-router-hint");
assert.equal(hints.length, 2);
assert.deepEqual(
  hints.map((m) => m.source.forPrompt),
  ["prompt-1", "prompt-2"],
);

// 场景四：历史里没有真人消息（比如子代理上下文）→ 不动
const fourth = await runPreStep(preStep, [injectedMessage("b1", "agent-instructions")]);
assert.equal(fourth.messages.length, 1, "没有用户消息时不注入");

// 场景五：上游拒绝 → 原样透传，不追加
const rejected = await preStep({ messages: [] }, async () => ({
  kind: "reject",
  reason: "stop",
}));
assert.equal(rejected.kind, "reject");
assert.equal(rejected.messages, undefined, "reject 分支不应带 messages");

// 场景六：关掉 hint → 不再挂钩
const off = createFakeContext();
plugin.apply(off.ctx, { hint: false, role: false, gap: false });
assert.equal(off.handlers.has("agent/pre-step"), false, "hint:false 时不应挂钩");
assert.equal(off.sections.length, 2, "原则段与专家目录仍应注册");

// 场景七：总开关关掉 → 什么都不做
const disabled = createFakeContext();
plugin.apply(disabled.ctx, { enabled: false });
assert.equal(disabled.sections.length, 0);
assert.equal(disabled.skills.length, 0);
assert.equal(disabled.handlers.size, 0);

// 场景九：messages 里看不到历史注入（agent loop 每步重建上下文时的常见情形），
// 同一个 agent 连跑五步也只应注入一次——靠 WeakMap 兜底，不靠 messages 内容
const loopRun = createFakeContext();
plugin.apply(loopRun.ctx, { role: false, gap: false });
const loopHandler = loopRun.handlers.get("agent/pre-step");
const agent = { id: "agent-9" };
const stable = [userMessage("prompt-9", "换个思路再做一遍")];
let injectedSteps = 0;
for (let step = 0; step < 5; step += 1) {
  const decision = await loopHandler({ agent, messages: stable }, async () => ({
    kind: "continue",
    messages: stable,
  }));
  if (decision.messages.length > stable.length) injectedSteps += 1;
}
assert.equal(injectedSteps, 1, "同一 agent 的同一条消息只应注入一次");

// 同一条消息换 agent 也不重复（消息 id 全局唯一，一条用户输入只对应一次检查点）
const otherAgent = { id: "agent-10" };
const otherDecision = await loopHandler({ agent: otherAgent, messages: stable }, async () => ({
  kind: "continue",
  messages: stable,
}));
assert.equal(otherDecision.messages.length, 1, "同一条消息不因换 agent 而重复注入");

// 换一条用户消息就该注入
const freshDecision = await loopHandler(
  { agent: otherAgent, messages: [userMessage("prompt-10", "新的一句话")] },
  async () => ({ kind: "continue", messages: [userMessage("prompt-10", "新的一句话")] }),
);
assert.equal(freshDecision.messages.length, 2, "新的用户消息应注入");

// 场景八：saveConfig 原子写回
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-"));
process.env.DSH_HOME = tmpHome;
const fresh = await import(`../lib/index.js?fresh=${Date.now()}`);
fresh.saveConfig({ intake: false });
const written = JSON.parse(fs.readFileSync(path.join(tmpHome, "capability-router", "config.json"), "utf8"));
assert.equal(written.intake, false);
assert.equal(written.hint, true, "未指定的字段应落到默认值");
fs.rmSync(tmpHome, { recursive: true, force: true });

// 场景十：命中专家后注入 role.md，只注入一次
const roleRun = createFakeContext();
plugin.apply(roleRun.ctx, { hint: false, role: true, gap: false, catalog: false });
const roleHandler = roleRun.handlers.get("agent/pre-step");
const frontendPrompt = [userMessage("prompt-role", "登录页的样式在窄屏下全乱了")];
const roleDecision = await roleHandler({ messages: frontendPrompt }, async () => ({ kind: "continue", messages: frontendPrompt }));
assert.equal(roleDecision.messages.length, 2, "命中专家应追加一条角色消息");
const roleMsg = roleDecision.messages[1];
assert.equal(roleMsg.source.kind, "capability-router-role");
assert.equal(roleMsg.source.expert, "frontend");
assert.ok(roleMsg.content[0].text.includes("前端工程师"));
const roleAgain = await roleHandler({ messages: roleDecision.messages }, async () => ({ kind: "continue", messages: roleDecision.messages }));
assert.equal(roleAgain.messages.length, 2, "同一条用户消息不重复注入角色");
const missDecision = await roleHandler({ messages: [userMessage("prompt-miss", "今天中午吃什么")] }, async () => ({ kind: "continue", messages: [userMessage("prompt-miss", "今天中午吃什么")] }));
assert.equal(missDecision.messages.length, 1, "没命中不注入角色");

// 场景十一：缺口提示——派活才开口，闲聊不打扰
const gapRun = createFakeContext();
plugin.apply(gapRun.ctx, { hint: false, role: false, gap: true });
const gapHandler = gapRun.handlers.get("agent/pre-step");

const noExpert = [userMessage("prompt-gap1", "帮我做视频监控系统")];
const gapDecision = await gapHandler({ messages: noExpert }, async () => ({ kind: "continue", messages: noExpert }));
assert.equal(gapDecision.messages.length, 2, "派活但没对口专家应提示一句");
assert.equal(gapDecision.messages[1].source.kind, "capability-router-gap");
assert.ok(gapDecision.messages[1].content[0].text.includes("没有对口的专家"));

const chitchat = [userMessage("prompt-gap2", "今天中午吃什么")];
const chatDecision = await gapHandler({ messages: chitchat }, async () => ({ kind: "continue", messages: chitchat }));
assert.equal(chatDecision.messages.length, 1, "闲聊不该被提示打扰");

const fuzzy = [userMessage("prompt-gap3", "帮我写一下这个接口的文档")];
const fuzzyDecision = await gapHandler({ messages: fuzzy }, async () => ({ kind: "continue", messages: fuzzy }));
assert.ok(fuzzyDecision.messages[1].content[0].text.includes("分不清"), "分不清要给结论里的前两名");

const hitPrompt = [userMessage("prompt-gap4", "登录页的样式在窄屏下全乱了")];
const hitDecision = await gapHandler({ messages: hitPrompt }, async () => ({ kind: "continue", messages: hitPrompt }));
assert.equal(hitDecision.messages.length, 1, "命中时不该再插缺口提示");

const againGap = await gapHandler({ messages: gapDecision.messages }, async () => ({ kind: "continue", messages: gapDecision.messages }));
assert.equal(againGap.messages.length, 2, "同一条消息只提示一次");

// 场景十二：落空的句子要记账，闲聊不记——它是「该先造哪个专家」的依据
// 注意用 TEST_HOME：STATE_DIR 在模块加载时就定了，场景八之后的环境变量已经指向别处。
{
  const ledger = path.join(TEST_HOME, "capability-router", "gaps.jsonl");
  assert.ok(fs.existsSync(ledger), "应写出 gaps.jsonl");
  const rows = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(rows.some((row) => row.text === "帮我做视频监控系统" && row.kind === "miss"), "派活落空应记账");
  assert.ok(rows.some((row) => row.text === "帮我写一下这个接口的文档" && row.kind === "ambiguous"), "分不清也记，但 kind 不同");
  assert.ok(!rows.some((row) => row.text === "今天中午吃什么"), "闲聊不记账");
}

console.log("场景一 首次注入      ✓");
console.log("场景二 同句去重      ✓");
console.log("场景三 新句再注入    ✓");
console.log("场景四 无真人消息    ✓");
console.log("场景五 reject 透传   ✓");
console.log("场景六 hint:false    ✓");
console.log("场景七 enabled:false ✓");
console.log("场景八 配置写回      ✓");
console.log("场景九 跨步去重      ✓");
console.log("场景十 角色注入      ✓");
console.log("场景十一 缺口提示    ✓");
console.log("场景十二 缺口记账    ✓");
console.log("冒烟测试通过");
