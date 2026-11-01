import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 集成测试：真实 lib/index.js × 假宿主服务。
 * 验的是「一句话进来之后，模型看到的东西变没变」——角色消息有没有、目录有没有收窄。
 */

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-route-"));

const CATALOG = [
  { name: "frontend-design", description: "界面设计" },
  { name: "playwright", description: "浏览器自动化" },
  { name: "office-xlsx", description: "表格" },
  { name: "pdf", description: "PDF" },
  { name: "systematic-debugging", description: "排障" },
];

function createFakeSkills(catalog) {
  const providers = [];
  let cache;
  const base = catalog.map((skill) => ({
    ...skill,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "filesystem",
    provider: "dsh-skill-filesystem",
    rank: 0,
  }));
  providers.push({
    provider: { name: "dsh-skill-filesystem", list: async () => base.map((skill) => ({ ...skill })), get: async (name) => base.find((skill) => skill.name === name) },
    order: 0,
  });

  const service = {
    registerProvider(create) {
      const provider = create({ invalidate: () => {} });
      providers.push({ provider, order: providers.length });
      cache = undefined;
      return () => {};
    },
    invalidateCache() {
      cache = undefined;
    },
    async collect() {
      if (cache !== undefined) return cache;
      const rows = [];
      for (const { provider, order } of providers) {
        (await provider.list({})).forEach((candidate, localOrder) => rows.push({ candidate, provider, order, localOrder }));
      }
      rows.sort((left, right) => left.candidate.rank - right.candidate.rank || left.order - right.order || left.localOrder - right.localOrder);
      const win = new Map();
      for (const row of rows) if (!win.has(row.candidate.name)) win.set(row.candidate.name, row);
      cache = win;
      return win;
    },
    async list() {
      return [...(await this.collect()).values()].map((row) => ({ ...row.candidate }));
    },
    async get(name) {
      const row = (await this.collect()).get(name);
      if (row === undefined) return undefined;
      return row.provider.get?.(name) ?? row.candidate;
    },
  };
  return service;
}

function createFakeContext() {
  const handlers = new Map();
  const registered = [];
  const skills = createFakeSkills(CATALOG);
  const service = {
    ...skills,
    register(skill) {
      registered.push(skill);
      return () => {};
    },
  };
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect(factory) {
      factory();
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    systemPrompt: { section: () => () => {} },
    skills: service,
  };
  return { ctx, handlers, skills, registered };
}

const plugin = await import("../lib/index.js");

function userMessage(id, text) {
  return { role: "user", id, content: [{ type: "text", text }], source: { kind: "user" } };
}

// 场景一：命中前端 → 注入角色 + 收起其他领域的技能
{
  const { ctx, handlers, skills } = createFakeContext();
  plugin.apply(ctx, { hint: false, role: true, narrow: true, alwaysVisible: [] });
  const handler = handlers.get("agent/pre-step");
  const messages = [userMessage("p1", "登录页的样式在窄屏下全乱了")];
  const decision = await handler({ messages }, async () => ({ kind: "continue", messages }));

  assert.equal(decision.messages.length, 2, "应追加一条角色消息");
  assert.equal(decision.messages[1].source.kind, "capability-router-role");

  const list = await skills.list();
  const visible = list.filter((skill) => skill.invocation.modelInvocable).map((skill) => skill.name).sort();
  assert.deepEqual(visible, ["frontend-design", "playwright"], "只该留下该专家用到的技能");
  assert.ok(!list.some((skill) => skill.name === "capability-router"), "自检技能不在假目录里");
}

// 场景二：换成另一个专家 → 目录跟着换，且不重复注入角色
{
  const { ctx, handlers, skills } = createFakeContext();
  plugin.apply(ctx, { hint: false, role: true, narrow: true });
  const handler = handlers.get("agent/pre-step");

  const first = [userMessage("p2", "这个页面的样式不对")];
  await handler({ messages: first }, async () => ({ kind: "continue", messages: first }));

  const second = [userMessage("p3", "帮我把这个 Excel 汇总一下")];
  const decision = await handler({ messages: second }, async () => ({ kind: "continue", messages: second }));
  assert.equal(decision.messages.length, 2);
  assert.equal(decision.messages[1].source.expert, "data");

  const visible = (await skills.list()).filter((skill) => skill.invocation.modelInvocable).map((skill) => skill.name).sort();
  assert.deepEqual(visible, ["office-xlsx", "pdf"], "换专家后目录应换成新专家那份（data 的 skills 含 pdf）");
}

// 场景三：匹配不到时不硬选，目录恢复完整
{
  const { ctx, handlers, skills } = createFakeContext();
  plugin.apply(ctx, { hint: false, role: true, narrow: true });
  const handler = handlers.get("agent/pre-step");

  const hit = [userMessage("p4", "内存一直涨，怀疑泄漏")];
  await handler({ messages: hit }, async () => ({ kind: "continue", messages: hit }));
  assert.ok((await skills.list()).some((skill) => skill.invocation.modelInvocable === false), "先确认已收窄");

  const miss = [userMessage("p5", "今天中午吃什么")];
  const decision = await handler({ messages: miss }, async () => ({ kind: "continue", messages: miss }));
  assert.equal(decision.messages.length, 1, "没命中不注入任何消息");
  const all = (await skills.list()).filter((skill) => skill.invocation.modelInvocable);
  assert.equal(all.length, CATALOG.length, "应该有救生索：目录恢复完整");
}

// 场景四：narrow 关闭时一行都不碰宿主目录
{
  const { ctx, handlers, skills } = createFakeContext();
  plugin.apply(ctx, { hint: false, role: false, gap: false, narrow: false });
  const handler = handlers.get("agent/pre-step");
  assert.equal(handler, undefined, "全关就不该挂钩");
  const list = await skills.list();
  assert.ok(list.every((skill) => skill.provider === "dsh-skill-filesystem"));
}

// 场景五：缺口提示接在同一条链路上——派活没命中会多说一句，闲聊不会
{
  const { ctx, handlers } = createFakeContext();
  plugin.apply(ctx, { hint: false, role: false, gap: true, narrow: false });
  const handler = handlers.get("agent/pre-step");

  const task = [userMessage("p6", "帮我做视频监控系统")];
  const gapDecision = await handler({ messages: task }, async () => ({ kind: "continue", messages: task }));
  assert.equal(gapDecision.messages.length, 2);
  assert.equal(gapDecision.messages[1].source.kind, "capability-router-gap");

  const chat = [userMessage("p7", "今天中午吃什么")];
  const chatDecision = await handler({ messages: chat }, async () => ({ kind: "continue", messages: chat }));
  assert.equal(chatDecision.messages.length, 1, "闲聊不打扰");
}

console.log("场景一 命中即收窄    ✓");
console.log("场景二 换专家换目录  ✓");
console.log("场景三 落空即恢复    ✓");
console.log("场景四 narrow 关闭   ✓");
console.log("场景五 缺口提示      ✓");
console.log("路由集成测试通过");
