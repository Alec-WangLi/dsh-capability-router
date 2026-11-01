import assert from "node:assert/strict";
import { describeMatch, matchExpert, scoreExpert, termWeight } from "../lib/router.js";

const expert = (id, extra) => ({
  id,
  name: id,
  description: "",
  triggers: [],
  synonyms: [],
  skills: [],
  tools: [],
  role: "",
  hasRole: true,
  ownSkills: [],
  dir: "",
  ...extra,
});

// 场景一：长词更值钱，权重有上限
{
  assert.equal(termWeight("慢"), 1);
  assert.equal(termWeight("缓存"), 1.5);
  assert.equal(termWeight("数据库"), 2);
  assert.equal(termWeight("playwright"), 2.5);
}

// 场景二：英文按词边界匹配，不误伤同前缀词
{
  const e = expert("fe", { triggers: ["react"] });
  assert.equal(scoreExpert("用 REACT 写一个页面", e).score, 2.5);
  assert.equal(scoreExpert("reactive 流式编程", e).score, 0, "reactive 不应命中 react");
}

// 场景三：中文按子串匹配
{
  const e = expert("fe", { triggers: ["样式"] });
  assert.ok(scoreExpert("这个样式不对", e).score > 0);
}

// 场景四：同义词不重复计分（同一个词既写进 triggers 又写进 synonyms）
{
  const e = expert("dbg", { triggers: ["慢"], synonyms: ["慢", "卡"] });
  assert.equal(scoreExpert("太慢了", e).score, 1, "慢只算一次触发词");
  assert.equal(scoreExpert("太卡了", e).score, 1, "同义词只有 1.0");
}

// 场景五：同义词总量封顶 2.0
{
  const e = expert("dbg", { synonyms: ["卡", "慢", "顿", "堵"] });
  assert.equal(scoreExpert("又卡又慢还顿还堵", e).score, 2);
}

// 场景六：具体词压过笼统词
{
  const data = expert("data", { triggers: ["数据"] });
  const backend = expert("backend", { triggers: ["数据库"] });
  const result = matchExpert("数据库索引怎么加", [data, backend]);
  assert.equal(result.kind, "hit");
  assert.equal(result.expert.id, "backend");
}

// 场景七：分差太小判 ambiguous，不硬选
{
  const left = expert("a", { triggers: ["接口"] });
  const right = expert("b", { triggers: ["文档"] });
  const result = matchExpert("这个接口的文档", [left, right]);
  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(result.candidates.map((row) => row.expert.id), ["a", "b"]);
  assert.match(describeMatch(result), /分不清/);
}

// 场景八：没有任何命中判 miss
{
  const only = expert("a", { triggers: ["接口"] });
  assert.equal(matchExpert("今天吃什么", [only]).kind, "miss");
  assert.equal(matchExpert("今天吃什么", []).kind, "miss");
}

// 场景九：描述只做兜底，单独一个词不足以定案
{
  const e = expert("docs", { description: "文档、方案、汇报" });
  assert.equal(scoreExpert("给我个方案", e).score, 0.5);
  assert.equal(matchExpert("给我个方案", [e]).kind, "miss", "0.5 低于阈值");
}

// 场景十：跨领域——三个以上专家都明显过线，判 multi 而不是硬选一个
{
  const experts = [
    expert("backend", { triggers: ["接口", "数据库"], description: "接口、数据模型" }),
    expert("frontend", { triggers: ["界面", "页面"], description: "界面、交互" }),
    expert("docs", { triggers: ["文档"], description: "文档、方案" }),
    expert("data", { triggers: ["报表"], description: "表格、报表" }),
  ];
  const cross = matchExpert("做个系统，要界面、要接口、还要文档", experts);
  assert.equal(cross.kind, "multi");
  assert.ok(cross.candidates.length >= 3, "multi 要列出涉及的专家");
  assert.equal(cross.expert, undefined, "multi 不该指定唯一个专家");

  // 头名压倒性领先时仍判 hit：其它只是词面噪音
  const dominant = matchExpert("接口和数据库的接口设计", experts);
  assert.equal(dominant.kind, "hit");
  assert.equal(dominant.expert.id, "backend");

  // 只有两位明显过线时不判 multi：第三位只是描述里沾了个词（0.5，够不上阈值）
  const weak = matchExpert("接口、界面、文档", [
    expert("backend", { triggers: [], description: "接口" }),
    expert("frontend", { triggers: ["界面"], description: "" }),
    expert("docs", { triggers: ["文档"], description: "" }),
  ]);
  assert.notEqual(weak.kind, "multi", "第三位没到线就不该算跨领域");
}

// 场景十一：入口专家让位——有别的专家过线时，接单专家不抢活
// 2026-11-02 实测：「把这个需求文档改成给老板看的版本」被判成接单专家（4.0 > 文档 3.5），
// 于是文档的活被接单专家接走了。入口专家是入口，不是竞争选手。
{
  const intake = expert("intake", { kind: "intake", triggers: ["需求", "需求文档", "做一款"] });
  const docs = expert("docs", { triggers: ["需求文档", "改成"] });
  const result = matchExpert("把这个需求文档改成给老板看的版本", [intake, docs]);
  assert.equal(result.kind, "hit");
  assert.equal(result.expert.id, "docs", "接单专家不该抢文档的活");

  // 没有别人过线时，入口专家仍然该赢——全新项目就是从它开始的
  const alone = matchExpert("我想做一款Windows记账软件", [expert("intake", { kind: "intake", triggers: ["做一款"] })]);
  assert.equal(alone.expert.id, "intake");
}

// 场景十二：主次——头名明确，但副的那部分也得有人管
{
  const data = expert("data", { triggers: ["PPT", "记账"] });
  const docs = expert("docs", { triggers: ["说明"] });
  const result = matchExpert("帮我做个记账软件和一份说明PPT", [data, docs]);
  assert.equal(result.kind, "hit");
  assert.equal(result.expert.id, "data");
  assert.equal(result.secondary?.expert.id, "docs", "被压掉的副领域要露头，不能悄悄消失");
  assert.match(describeMatch(result), /副：docs/);

  // 词面包含不算副领域：「数据」落在「数据库」里只是噪音。
  const nested = matchExpert("数据库索引怎么加", [
    expert("data", { triggers: ["数据"] }),
    expert("backend", { triggers: ["数据库"] }),
  ]);
  assert.equal(nested.expert.id, "backend");
  assert.equal(nested.secondary, undefined, "被头名词面包含的命中不算副领域");
}

console.log("场景一 权重上限      ✓");
console.log("场景二 英文词边界    ✓");
console.log("场景三 中文子串      ✓");
console.log("场景四 同义词去重    ✓");
console.log("场景五 同义词封顶    ✓");
console.log("场景六 长词优先      ✓");
console.log("场景七 ambiguous     ✓");
console.log("场景八 miss          ✓");
console.log("场景九 描述兜底      ✓");
console.log("场景十 multi         ✓");
console.log("场景十一 入口让位    ✓");
console.log("场景十二 主次        ✓");
console.log("匹配器测试通过");
