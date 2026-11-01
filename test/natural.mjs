/**
 * 真人说法回归：十五句原话，锁住「归谁」这件事。
 *
 * 这十五句来自 2026-11-02 的真实用例复盘（docs/REAL-TEST-2026-11-02.md）：
 * 同一句「我想做一款Windows记账软件，整体看起来简约大方。」在装插件的情况下
 * 整场 0 次 expert()，因为匹配器给它的分数是 0——落空且静默，连「先接单」都没说。
 *
 * 断言写的不是「必须命中谁」，而是**四种该有的反应**：
 *   hit 命中的必须是对的专家（错判是这套东西最贵的失败）
 *   ambiguous 必须给出两个候选（模型才有东西可问）
 *   miss 必须静默，或者在有接单专家时指向接单
 * 判错的代价是整段活白做，漏判的代价只是少一句提示——所以这里宁可宽，也要把错判钉死。
 */
import assert from "node:assert/strict";
import { expertDirs } from "../lib/experts.js";
import { scanExperts } from "../lib/experts.js";
import { gapText, looksLikeTask } from "../lib/gap.js";
import { matchExpert } from "../lib/router.js";

// 只扫包内自带的专家：用户目录里可能有自造的包，那会让断言随机器漂移。
const catalog = {
  experts: scanExperts({ dirs: expertDirs("<unused>").slice(0, 1) }).experts,
};
assert.ok(catalog.experts.length >= 7, `内置专家包应至少 7 个，实际 ${catalog.experts.length}`);

/** 断言这句命中某位专家。 */
function expectHit(text, id) {
  const verdict = matchExpert(text, catalog.experts);
  assert.equal(verdict.kind, "hit", `「${text}」应命中 ${id}，实际 ${verdict.kind}`);
  assert.equal(verdict.expert.id, id, `「${text}」应命中 ${id}，实际 ${verdict.expert.id}`);
  assert.equal(gapText(verdict, catalog, text), undefined, "命中时不该再插缺口提示");
}

/** 断言这句分不清，且候选里确实有这两个人。 */
function expectAmbiguous(text, ids) {
  const verdict = matchExpert(text, catalog.experts);
  assert.equal(verdict.kind, "ambiguous", `「${text}」应判分不清，实际 ${verdict.kind}`);
  const got = verdict.candidates.map((row) => row.expert.id).sort();
  assert.deepEqual(got, [...ids].sort(), `「${text}」的候选不对：${got.join("、")}`);
  const note = gapText(verdict, catalog, text);
  assert.match(note ?? "", /分不清/);
  assert.match(note ?? "", /先问用户一句/);
}

// 场景一：真实首句——整场 0 次 expert() 的那一句，必须从接单专家进门
// 旧词表没有「做一款」，这句分数是 0；现在它落到的不是「没人接」，是入口。
{
  const text = "我想做一款Windows记账软件，整体看起来简约大方。";
  const verdict = matchExpert(text, catalog.experts);
  assert.equal(verdict.kind, "hit", "首句应当命中接单专家，不是落空");
  assert.equal(verdict.expert.kind, "intake", "首句应当从接单专家进门");
  assert.equal(looksLikeTask(text), true, "首句是派活，不是闲聊");
}

// 场景二：明确的领域活，必须落到对的人
{
  expectHit("整理一下这份Excel", "data");
  expectHit("这个bug修一下", "debug");
  expectHit("接着做一个能记账的PPT", "data");
  expectHit("部署一下到服务器", "backend");
  expectHit("接口太慢了，看看怎么回事", "backend");
  // 头名明确时副领域要露头，不能悄悄吃掉另一半活
  const mixed = matchExpert("帮我做个记账软件和一份说明PPT", catalog.experts);
  assert.equal(mixed.kind, "hit");
  assert.equal(mixed.expert.id, "data");
  assert.equal(mixed.secondary?.expert.id, "docs", "说明文档那一半要有主");
}

// 场景三：入口专家让位——文档的活不该被接单专家接走（旧版实测错判）
{
  expectHit("把这个需求文档改成给老板看的版本", "docs");
}

// 场景四：真的分不清的，给两个候选让模型去问，别硬选
{
  expectAmbiguous("帮我做份季度汇报的PPT", ["data", "docs"]);
  expectAmbiguous("帮我写个脚本，把日志归一下类", ["backend", "debug"]);
}

// 场景五：闲聊不打扰
{
  const text = "我有个想法，你听听";
  assert.equal(looksLikeTask(text), false);
  assert.equal(gapText(matchExpert(text, catalog.experts), catalog, text), undefined);
}

// 场景六：说不清的活，有接单专家就先接单，不是先说「没人干这个」
{
  const text = "下周要交个东西";
  const verdict = matchExpert(text, catalog.experts);
  assert.equal(verdict.kind, "miss");
  const note = gapText(verdict, catalog, text);
  assert.match(note ?? "", /没命中具体专家/);
  assert.match(note ?? "", /expert\("intake"\)/);
}

console.log("场景一 真实首句进接单  ✓");
console.log("场景二 明确领域不跑偏  ✓");
console.log("场景三 入口让位       ✓");
console.log("场景四 分不清给候选    ✓");
console.log("场景五 闲聊不打扰     ✓");
console.log("场景六 落空先接单     ✓");
console.log("真人说法回归测试通过");
