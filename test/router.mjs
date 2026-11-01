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
console.log("匹配器测试通过");
