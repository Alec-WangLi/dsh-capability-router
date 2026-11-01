import assert from "node:assert/strict";
import { gapText, looksLikeTask } from "../lib/gap.js";

const catalog = {
  experts: [
    { id: "frontend", name: "前端工程师" },
    { id: "debug", name: "排障工程师" },
  ],
};

// 场景一：派活的说法认得出
{
  for (const text of ["帮我做视频监控系统", "做个报价单", "排查一下这个报错", "这个怎么改", "能不能支持导出"]) {
    assert.equal(looksLikeTask(text), true, `应判定为任务：${text}`);
  }
}

// 场景二：闲聊不算任务
{
  for (const text of ["今天中午吃什么", "嗯", "好的", "", "   "]) {
    assert.equal(looksLikeTask(text), false, `不应判定为任务：${text}`);
  }
}

// 场景三：命中时不插话
{
  assert.equal(gapText({ kind: "hit", expert: {} }, catalog, "帮我做个页面"), undefined);
}

// 场景四：没命中但只是闲聊 → 静默
{
  assert.equal(gapText({ kind: "miss", candidates: [] }, catalog, "今天中午吃什么"), undefined);
}

// 场景五：派活却没对口专家 → 列出已有的，并说清该说什么
{
  const note = gapText({ kind: "miss", candidates: [] }, catalog, "帮我做视频监控系统");
  assert.match(note, /没有对口的专家/);
  assert.match(note, /前端工程师、排障工程师/);
  assert.match(note, /不要拿相近的技能硬凑/);
}

// 场景六：分不清 → 说出是两个谁，并给一句可执行的建议
{
  const note = gapText(
    { kind: "ambiguous", candidates: [{ expert: { name: "前端工程师" } }, { expert: { name: "排障工程师" } }] },
    catalog,
    "帮我看看这个页面为什么这么慢",
  );
  assert.match(note, /分不清/);
  assert.match(note, /前端工程师/);
  assert.match(note, /排障工程师/);
  assert.match(note, /问一句/);
}

// 场景七：候选不足两个时不该冒充分不清
{
  assert.equal(gapText({ kind: "ambiguous", candidates: [{ expert: { name: "前端工程师" } }] }, catalog, "帮我做一个页面"), undefined);
}

// 场景八：一个专家包都没有时，提示也要说人话
{
  const note = gapText({ kind: "miss", candidates: [] }, { experts: [] }, "帮我做视频监控系统");
  assert.match(note, /一个专家包都没有/);
}

// 场景九：跨领域——指出涉及的专家，并指向接单专家
{
  const note = gapText(
    {
      kind: "multi",
      candidates: [
        { expert: { id: "backend", name: "后端工程师" }, score: 3.5 },
        { expert: { id: "frontend", name: "前端工程师" }, score: 3 },
        { expert: { id: "docs", name: "文档与写作" }, score: 2 },
      ],
    },
    { experts: [] },
    "做个系统，界面和接口都要，还要文档",
  );
  assert.match(note, /跨领域/);
  assert.match(note, /后端工程师\(3\.5\)/);
  assert.match(note, /expert\("intake"\)/);
  assert.match(note, /别自己一个领域一个领域串着硬扛/);
  assert.equal(gapText({ kind: "hit", expert: { id: "backend" } }, { experts: [] }, "x"), undefined, "命中仍然不说话");
}

console.log("场景一 任务判定      ✓");
console.log("场景二 闲聊不打扰    ✓");
console.log("场景三 命中不说话    ✓");
console.log("场景四 闲聊静默      ✓");
console.log("场景五 没人接        ✓");
console.log("场景六 分不清        ✓");
console.log("场景七 候选不足      ✓");
console.log("场景八 空目录        ✓");
console.log("场景九 跨领域        ✓");
console.log("缺口提示测试通过");
