import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogText, expertTool, findExpert, renderExpertHit } from "../lib/catalog.js";

/**
 * 专家目录与 expert(name) 工具的测试。
 * 这里不启动宿主：目录是纯函数，工具定义是纯对象，apply 用假 ctx 验注册。
 */

const EXPERTS = [
  {
    id: "backend",
    name: "后端工程师",
    kind: "worker",
    description: "接口、数据模型、并发与服务边界",
    role: "# 后端工程师\n\n先定接口再写实现。",
    skills: ["codebase-design", "domain-modeling"],
    skillDeps: [
      { name: "codebase-design", required: true, source: "local" },
      { name: "domain-modeling", required: true, source: "local" },
      { name: "research", required: false, source: "local" },
    ],
    handoff: ["frontend", "review"],
    deliverables: ["接口定义", "数据模型"],
    triggers: ["接口"],
  },
  {
    id: "intake",
    name: "接单专家",
    kind: "intake",
    description: "把模糊需求收敛成需求文档与任务卡",
    role: "# 接单专家\n\n没出 REQUIREMENTS.md 不许开工。",
    skills: [],
    skillDeps: [],
    handoff: ["backend"],
    deliverables: ["REQUIREMENTS.md", "TASKS.md"],
    triggers: ["做个"],
  },
];

// 场景一：目录进系统提示——每位专家、角色、必装与备用技能、产出、交接都在
{
  const text = catalogText(EXPERTS);
  assert.match(text, /## 可用专家（能力路由）/);
  assert.match(text, /\*\*后端工程师\*\*（backend，worker）：接口、数据模型、并发与服务边界/);
  assert.match(text, /主力技能：codebase-design、domain-modeling/);
  assert.match(text, /备用技能：research/);
  assert.match(text, /产出：接口定义、数据模型/);
  assert.match(text, /常交给：frontend、review/);
  assert.match(text, /\*\*接单专家\*\*（intake，intake）/);
  assert.match(text, /expert\(name\)/);
  assert.match(text, /大活先确认需求再挑人/);
  assert.equal(catalogText([]), "", "没有专家就不该往系统提示里塞空段");
}

// 场景二：按 id 与中文名都能找到；找不到就是 undefined
{
  assert.equal(findExpert(EXPERTS, "backend").id, "backend");
  assert.equal(findExpert(EXPERTS, "后端工程师").id, "backend");
  assert.equal(findExpert(EXPERTS, "BACKEND").id, "backend", "id 大小写不敏感");
  assert.equal(findExpert(EXPERTS, "  "), undefined);
  assert.equal(findExpert(EXPERTS, "法务"), undefined);
}

// 场景三：工具定义就是宿主 register 要的形状（不依赖 defineTool）
{
  const tool = expertTool(EXPERTS);
  assert.equal(tool.name, "expert");
  assert.ok(tool.description.includes("role.md"));
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["name"]);
  assert.equal(tool.parameters.properties.name.type, "string");
  assert.equal(tool.output.schema.type, "object", "output.schema 必须是对象根");
  assert.ok(Array.isArray(tool.output.schema.required), "required 是数组（标准 JSON Schema，不是宿主 spec 那种属性内写法）");
  assert.equal(typeof tool.output.render, "function");
}

// 场景四：执行返回结构化结果；未知名字给出可选清单
{
  const tool = expertTool(EXPERTS);
  const hit = await tool.execute({ name: "backend" });
  assert.equal(hit.found, true);
  assert.equal(hit.kind, "worker");
  assert.match(hit.role, /先定接口再写实现/);
  assert.deepEqual(hit.deliverables, ["接口定义", "数据模型"]);

  const missing = await tool.execute({ name: "法务" });
  assert.equal(missing.found, false);
  assert.deepEqual(missing.available, ["backend", "intake"]);
}

// 场景五：渲染——命中给身份卡，未命中给清单
{
  const tool = expertTool(EXPERTS);
  const blocks = tool.output.render({ name: "接单专家" }, await tool.execute({ name: "接单专家" }));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /# 接单专家（intake，intake）/);
  assert.match(blocks[0].text, /REQUIREMENTS.md/);
  assert.match(blocks[0].text, /没出 REQUIREMENTS.md 不许开工/);

  assert.match(renderExpertHit({ found: false, available: ["backend"] }), /没有这个专家。现有：backend/);
  assert.match(renderExpertHit({ found: false }), /现有：无/);
  assert.match(renderExpertHit({ found: true, id: "x", name: "X", kind: "worker" }), /没有 role\.md/);
}

// 场景六：apply 真的注册——带 tools 的假 ctx 拿到 expert；关掉开关就不注册
{
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-catalog-"));
  const plugin = await import("../lib/index.js");

  function fakeCtx() {
    const sections = [];
    const tools = [];
    const ctx = {
      logger: { warn: () => {} },
      effect(factory) {
        factory();
      },
      on() {
        return () => {};
      },
      systemPrompt: { section: (section) => sections.push(section) },
      skills: { register: () => () => {} },
      tools: { register: (definition) => tools.push(definition) },
    };
    return { ctx, sections, tools };
  }

  const on = fakeCtx();
  plugin.apply(on.ctx, { hint: false, role: false, gap: false, gapLog: false });
  assert.equal(on.tools.length, 1, "应注册一个工具");
  assert.equal(on.tools[0].name, "expert");
  assert.ok(
    on.sections.some((section) => section.name === "capability-experts"),
    "应注册专家目录段",
  );

  const off = fakeCtx();
  plugin.apply(off.ctx, { hint: false, role: false, gap: false, gapLog: false, catalog: false, expertTool: false });
  assert.equal(off.tools.length, 0, "expertTool:false 时不该注册工具");
  assert.ok(!off.sections.some((section) => section.name === "capability-experts"), "catalog:false 时不该注册目录");
}

console.log("场景一 目录文案      ✓");
console.log("场景二 查找专家      ✓");
console.log("场景三 工具定义形状  ✓");
console.log("场景四 执行结果      ✓");
console.log("场景五 渲染          ✓");
console.log("场景六 apply 注册    ✓");
console.log("专家目录测试通过");
