import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * L1 回归：项目模式里的缺口提示与记账。
 *
 * 背景：`lib/index.js` 的缺口块原来被 `!projectMode` 整段门控，phase 一旦从 idle 推进到
 * spec，提示和 `gaps.jsonl` 就一起断了——真实会话里最后一条记录停在接单那一刻。
 * 现在只门控「注入」：状态卡优先，同一轮最多一条话；记账照常。
 *
 * 这一套走完整的 pre-step 链（真实 lib/index.js × 假宿主），不是纯函数：
 * 「谁先说话」「记了几行」这类问题只有在链路里才看得见。
 * 只用临时目录（DSH_HOME 指向 mkdtemp），绝不碰 ~/.dsh/capability-router。
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-gap-project-"));
process.env.DSH_HOME = HOME;
const STATE_DIR = path.join(HOME, "capability-router");
const GAPS_FILE = path.join(STATE_DIR, "gaps.jsonl");

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

/** 只看插件自己注入的消息，宿主原本的消息不算。 */
function injectedKinds(decision) {
  return (decision.messages ?? [])
    .map((message) => message.source?.kind)
    .filter((kind) => typeof kind === "string" && kind.startsWith("capability-router-"));
}

function gapRows(text) {
  let raw;
  try {
    raw = fs.readFileSync(GAPS_FILE, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((row) => row.text === text);
}

const MISS_TEXT = "帮我做视频监控系统";

// 场景一（L1）：项目模式 spec 阶段落空——状态卡优先，缺口只记账不插话
{
  const { ctx, tools, handlers } = createFakeContext();
  plugin.apply(ctx, {});
  const tool = tools.find((definition) => definition.name === "expert");
  const projectDir = fs.mkdtempSync(path.join(HOME, "proj-spec-"));
  await tool.execute({ name: "intake", project: projectDir }, { agent: { id: "gap-a" } });

  const handler = handlers.get("agent/pre-step");
  const messages = [userMessage("p-gap-a", MISS_TEXT)];
  const decision = await handler({ agent: { id: "gap-a" }, messages }, async () => ({ kind: "continue", messages }));
  const kinds = injectedKinds(decision);

  assert.ok(kinds.includes("capability-router-state"), "第一步要贴状态卡");
  assert.equal(kinds.includes("capability-router-gap"), false, "同一轮已经贴了状态卡，就不再插一段缺口提示——注意力只有一份");

  const rows = gapRows(MISS_TEXT);
  assert.equal(rows.length, 1, `gaps.jsonl 要新增且只新增一行，实际 ${rows.length} 行`);
  assert.equal(rows[0].phase, "spec", "项目模式写的行要带 phase，不然读的人不知道当时在哪个阶段");
  assert.equal(rows[0].kind, "miss");
  assert.ok(typeof rows[0].at === "string" && rows[0].at !== "", "记账仍要带时间");
}

// 场景二（L1）：同一条人话的后续步骤——状态卡不再贴，缺口提示顶上；且不许重复记账
{
  const { ctx, handlers } = createFakeContext();
  plugin.apply(ctx, {});
  const handler = handlers.get("agent/pre-step");
  const messages = [userMessage("p-gap-a", MISS_TEXT)];

  // 同一个 agent、同一个 prompt id：步差 1 < STATE_EVERY，状态卡这一轮不该再说
  const decision = await handler({ agent: { id: "gap-a" }, messages }, async () => ({ kind: "continue", messages }));
  const kinds = injectedKinds(decision);
  assert.equal(kinds.includes("capability-router-state"), false, "同一 prompt 步差不够，不再重复贴状态卡");
  assert.ok(kinds.includes("capability-router-gap"), "状态卡这一轮不贴了，缺口提示要顶上");

  const gapMessage = decision.messages.find((message) => message.source?.kind === "capability-router-gap");
  const note = gapMessage.content[0].text;
  assert.match(note, /需求确认/, "项目模式的提示要说清阶段中文名");
  assert.doesNotMatch(note, /intake/, "已经接过单了，别再劝人去接单");
  assert.doesNotMatch(note, /接单/, "同上");

  assert.equal(gapRows(MISS_TEXT).length, 1, "同一句话只记一次账，别每步都写一行——状态卡压住的那轮也已经记过");

  // 再走一步：同一句只补说一次，说过了就不再重复
  const third = await handler({ agent: { id: "gap-a" }, messages }, async () => ({ kind: "continue", messages }));
  const thirdKinds = injectedKinds(third);
  assert.equal(thirdKinds.includes("capability-router-gap"), false, "同一句已经补说过一次，不该每步都念叨");
  assert.equal(gapRows(MISS_TEXT).length, 1, "补说那一轮也不许再记账（记账集合与注入集合分开）");
}

// 场景三（L1）：非项目模式照旧——提示照插，但行里不许出现 phase 键
{
  const { ctx, handlers } = createFakeContext();
  plugin.apply(ctx, {});
  const handler = handlers.get("agent/pre-step");
  const text = "帮我做一套库存管理系统";
  const messages = [userMessage("p-gap-b", text)];
  const decision = await handler({ agent: { id: "gap-b" }, messages }, async () => ({ kind: "continue", messages }));

  assert.ok(injectedKinds(decision).includes("capability-router-gap"), "没有项目状态时照旧插缺口提示");

  const rows = gapRows(text);
  assert.equal(rows.length, 1, "非项目模式也要记账");
  assert.equal(Object.hasOwn(rows[0], "phase"), false, "非项目模式的行不该有 phase 键（不是 null，是根本没有）");
}

// 场景四（L1）：只记账不提示（gap=false + gapLog=true）——账本是数据，提示是策略
{
  const { ctx, tools, handlers } = createFakeContext();
  plugin.apply(ctx, { gap: false, gapLog: true });
  const tool = tools.find((definition) => definition.name === "expert");
  const projectDir = fs.mkdtempSync(path.join(HOME, "proj-logonly-"));
  await tool.execute({ name: "intake", project: projectDir }, { agent: { id: "gap-d" } });

  const handler = handlers.get("agent/pre-step");
  const text = "帮我做一套门禁系统";
  const messages = [userMessage("p-gap-d", text)];
  const decision = await handler({ agent: { id: "gap-d" }, messages }, async () => ({ kind: "continue", messages }));
  const kinds = injectedKinds(decision);

  assert.equal(kinds.includes("capability-router-gap"), false, "关掉缺口提示就不许插话——哪怕是项目模式");
  assert.ok(kinds.includes("capability-router-state"), "状态卡不受 gap 开关影响，该贴还贴");

  // 第二步状态卡不再占位：这一步才是「开关真的关着」的检验点，
  // 否则第一格是被 wantState 压住的，看不出 gap 开关有没有被读。
  const second = await handler({ agent: { id: "gap-d" }, messages }, async () => ({ kind: "continue", messages }));
  assert.equal(injectedKinds(second).includes("capability-router-gap"), false, "状态卡不占位了也不许补说——gap 关着就是关着");

  const rows = gapRows(text);
  assert.equal(rows.length, 1, `关掉提示不等于关掉账本，gaps.jsonl 要 +1 行，实际 ${rows.length} 行`);
  assert.equal(rows[0].phase, "spec", "只记账这一格也要带 phase");
}

// 场景五（L1）：只提示不记账（gap=true + gapLog=false）——防「记账顺手塞进注入分支」
{
  const { ctx, tools, handlers } = createFakeContext();
  plugin.apply(ctx, { gap: true, gapLog: false });
  const tool = tools.find((definition) => definition.name === "expert");
  const projectDir = fs.mkdtempSync(path.join(HOME, "proj-sayonly-"));
  await tool.execute({ name: "intake", project: projectDir }, { agent: { id: "gap-e" } });

  const handler = handlers.get("agent/pre-step");
  const text = "帮我做一套访客登记系统";
  const messages = [userMessage("p-gap-e", text)];

  // 第一步被状态卡占着，第二步缺口提示顶上——正好能看见「说」与「记」分家
  await handler({ agent: { id: "gap-e" }, messages }, async () => ({ kind: "continue", messages }));
  const decision = await handler({ agent: { id: "gap-e" }, messages }, async () => ({ kind: "continue", messages }));

  assert.ok(injectedKinds(decision).includes("capability-router-gap"), "开着提示就该说这句");
  assert.equal(gapRows(text).length, 0, "关掉记账就一行都不许写——说不等于记");
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log("场景一 状态卡优先、只记账 ✓");
console.log("场景二 后续步骤顶缺口   ✓");
console.log("场景三 非项目模式无 phase ✓");
console.log("场景四 只记账不提示     ✓");
console.log("场景五 只提示不记账     ✓");
console.log("项目模式缺口测试通过");
