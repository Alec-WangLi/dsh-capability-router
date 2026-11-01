import assert from "node:assert/strict";
import { NARROW_PROVIDER, createNarrower, planHidden } from "../lib/narrow.js";

/**
 * 假技能服务：只实现本插件用到的那几个面，排序语义照抄宿主
 * （`dsh-skill/lib/index.js:520` compareIndexedCandidates + 同名丢弃并告警）。
 */
function createFakeSkills(initial) {
  const providers = [];
  const warnings = [];
  let cache;
  const snapshotOf = (skill) => ({
    name: skill.name,
    description: skill.description,
    invocation: { ...skill.invocation },
    source: skill.source,
    provider: skill.provider,
  });

  const service = {
    get cache() {
      return cache;
    },
    registerProvider(create) {
      const provider = create({ signal: undefined, invalidate: () => {} });
      providers.push({ provider, order: providers.length });
      cache = undefined;
      return () => {
        providers.splice(providers.indexOf(provider), 1);
        cache = undefined;
      };
    },
    invalidateCache() {
      cache = undefined;
    },
    async collect() {
      if (cache !== undefined) return cache;
      const rows = [];
      for (const { provider, order } of providers) {
        const list = await provider.list({});
        list.forEach((candidate, localOrder) => rows.push({ candidate, provider, order, localOrder }));
      }
      rows.sort((left, right) => left.candidate.rank - right.candidate.rank || left.order - right.order || left.localOrder - right.localOrder);
      const seen = new Set();
      const win = new Map();
      for (const row of rows) {
        if (seen.has(row.candidate.name)) {
          warnings.push(`skill "${row.candidate.name}" ignored because a higher-priority skill already exists`);
          continue;
        }
        seen.add(row.candidate.name);
        win.set(row.candidate.name, row);
      }
      cache = win;
      return win;
    },
    async list() {
      const win = await this.collect();
      return [...win.values()].map((row) => snapshotOf(row.candidate));
    },
    async get(name) {
      const win = await this.collect();
      const row = win.get(name);
      if (row === undefined) return undefined;
      return row.provider.get?.(name) ?? row.candidate;
    },
  };

  const base = initial.map((skill) => ({
    ...skill,
    invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
    source: "filesystem",
    provider: "dsh-skill-filesystem",
    rank: 0,
  }));
  providers.push({
    provider: {
      name: "dsh-skill-filesystem",
      async list() {
        return base.map((skill) => ({ ...skill }));
      },
      async get(name) {
        const found = base.find((skill) => skill.name === name);
        return found === undefined ? undefined : { ...found, content: `# ${name}\n正文` };
      },
    },
    order: 0,
  });
  return { service, warnings };
}

const CATALOG = [
  { name: "frontend-design", description: "界面设计" },
  { name: "playwright", description: "浏览器自动化" },
  { name: "office", description: "办公文档" },
  { name: "pdf", description: "PDF 处理" },
  { name: "grilling", description: "追问" },
];

// 场景一：planHidden 保留该专家技能、常驻技能与自身技能
{
  const hidden = planHidden(
    CATALOG.map((skill) => ({ name: skill.name })),
    { keep: ["frontend-design", "playwright"], alwaysVisible: ["office"] },
  );
  assert.deepEqual(hidden.sort(), ["grilling", "pdf"]);
}

// 场景二：收窄后 modelInvocable 变 false，且压过原 provider
{
  const { service } = createFakeSkills(CATALOG);
  const narrower = createNarrower({ skills: service });
  await narrower.refreshCatalog();
  assert.equal(narrower.setHidden(["pdf"]), true);
  const list = await service.list();
  const pdf = list.find((skill) => skill.name === "pdf");
  assert.equal(pdf.invocation.modelInvocable, false);
  assert.equal(pdf.provider, NARROW_PROVIDER);
  assert.equal(list.find((skill) => skill.name === "office").provider, "dsh-skill-filesystem", "没收的技能应原样保留");
}

// 场景三：没定的技能不进目录，也不报错
{
  const { service } = createFakeSkills(CATALOG);
  const narrower = createNarrower({ skills: service });
  await narrower.refreshCatalog();
  narrower.setHidden(["不存在的技能"]);
  const list = await service.list();
  assert.equal(list.length, CATALOG.length);
  assert.ok(list.every((skill) => skill.provider === "dsh-skill-filesystem"));
}

// 场景四：不封锁——被收起的技能仍能按名字加载出正文
{
  const { service } = createFakeSkills(CATALOG);
  const narrower = createNarrower({ skills: service });
  await narrower.refreshCatalog();
  narrower.setHidden(["pdf"]);
  await service.list(); // 让缓存里是收窄后的目录
  const loaded = await service.get("pdf");
  assert.match(loaded.content, /正文/, "应回落到原 provider 拿到正文");
}

// 场景五：同一集合重复设置不触发目录变更
{
  const { service } = createFakeSkills(CATALOG);
  const narrower = createNarrower({ skills: service });
  await narrower.refreshCatalog();
  assert.equal(narrower.setHidden(["pdf"]), true);
  assert.equal(narrower.setHidden(["pdf"]), false, "同样的集合不该让宿主重发目录");
  assert.equal(narrower.setHidden([]), true);
}

// 场景六：自身技能永远不收
{
  const { service } = createFakeSkills([...CATALOG, { name: "capability-router", description: "自检" }]);
  const narrower = createNarrower({ skills: service });
  await narrower.refreshCatalog();
  narrower.setHidden(["capability-router", "pdf"]);
  const list = await service.list();
  assert.equal(list.find((skill) => skill.name === "capability-router").provider, "dsh-skill-filesystem");
}

// 场景七：宿主重名告警只在覆盖时出现，且只针对被收的技能
{
  const { service, warnings } = createFakeSkills(CATALOG);
  const narrower = createNarrower({ skills: service });
  await narrower.refreshCatalog();
  narrower.setHidden(["pdf", "office"]);
  await service.list();
  assert.equal(warnings.length, 2, `应有 2 条重名告警，实际 ${warnings.length}`);
}

// 场景八：provider 注册失败不影响主流程
{
  const broken = { registerProvider() { throw new Error("boom"); } };
  const warnings = [];
  const narrower = createNarrower({ skills: broken, warn: (message) => warnings.push(message) });
  assert.deepEqual(warnings.length, 1);
  assert.equal(narrower.setHidden(["pdf"]), true, "没有 provider 也应记录状态，只是不生效");
}

console.log("场景一 planHidden     ✓");
console.log("场景二 收窄生效       ✓");
console.log("场景三 未知技能忽略   ✓");
console.log("场景四 仍可按名加载   ✓");
console.log("场景五 幂等不重发     ✓");
console.log("场景六 自身不收       ✓");
console.log("场景七 告警只覆盖时   ✓");
console.log("场景八 注册失败兜底   ✓");
console.log("收窄测试通过");
