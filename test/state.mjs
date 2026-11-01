import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advancePhase, gateNote, newState, normalizeState, openExpert, readState, stateCardText, stateFile, writeState } from "../lib/state.js";

/**
 * 会话状态的单元测试：推进规则、闸门提示、状态卡文案、文件的读与写。
 * 阶段是「只读事实」的产物，所以这里测的都是纯函数，除了最后两个读写场景。
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-state-"));

// 场景一：会话 id 会被规整成安全文件名
{
  const file = stateFile(tmp, "a/b:c d");
  assert.ok(file.startsWith(path.join(tmp, "sessions")), "落盘在 sessions/ 下");
  assert.ok(!/[\\/:*?"<>|]/.test(path.basename(file)), "文件名里不该有非法字符");
  assert.equal(stateFile(tmp, ""), path.join(tmp, "sessions", "unknown.json"));
}

// 场景二：读写往返；坏 JSON 当作「没有状态」
{
  const file = stateFile(tmp, "s1");
  const written = writeState(file, { sessionId: "s1", phase: "spec", experts: ["intake"] });
  assert.equal(written.phase, "spec");
  assert.equal(readState(file).experts[0], "intake");
  assert.ok(fs.existsSync(file), "应该真的落盘了");

  const broken = path.join(tmp, "sessions", "broken.json");
  fs.writeFileSync(broken, "{not json", "utf8");
  assert.equal(readState(broken), undefined, "坏文件不该让调用方炸");
  assert.equal(readState(path.join(tmp, "sessions", "missing.json")), undefined);
}

// 场景三：打开专家推进阶段——接单进 spec、审查在 build 时接棒、重复打开不重复记名
{
  let state = newState("s2");
  assert.equal(state.phase, "idle");

  state = openExpert(state, { id: "intake", kind: "intake" });
  assert.equal(state.phase, "spec");
  state = openExpert(state, { id: "intake", kind: "intake" });
  assert.deepEqual(state.experts, ["intake"], "重复打开不该记两遍");

  state = openExpert(state, { id: "backend", kind: "worker" });
  assert.equal(state.phase, "spec", "worker 不推进阶段");

  const review = openExpert(state, { id: "review", kind: "reviewer" });
  assert.equal(review.phase, "spec", "build 之前审查不该抢阶段");

  const built = openExpert({ ...state, phase: "build" }, { id: "review", kind: "reviewer" });
  assert.equal(built.phase, "review", "build 之后审查接管");
}

// 场景四：闸门是提示——spec 阶段开 worker 会提醒先出文档，开 intake 不打扰
{
  const spec = { sessionId: "s3", phase: "spec", experts: ["intake"] };
  assert.match(gateNote(spec, { id: "backend", kind: "worker" }), /需求还没确认/);
  assert.equal(gateNote(spec, { id: "intake", kind: "intake" }), undefined, "接单专家自己在 spec 阶段是正常的");
  assert.equal(gateNote(spec, { id: "backend", kind: "worker", }, ) !== undefined, true);
  assert.match(gateNote(newState("s4"), { id: "review", kind: "reviewer" }), /还没有可审的东西/);
  assert.equal(gateNote({ ...spec, phase: "build" }, { id: "backend", kind: "worker" }), undefined);
}

// 场景五：状态卡一行，含阶段中文名与下一步
{
  const text = stateCardText({ sessionId: "s5", phase: "spec", experts: ["intake"] });
  assert.match(text, /项目模式/);
  assert.match(text, /需求确认（spec）/);
  assert.match(text, /在场专家：intake/);
  assert.match(text, /REQUIREMENTS\.md/);
  assert.match(stateCardText(newState("s6")), /空闲（idle）/);
}

// 场景六：外部读进来的怪状态会被规整，而不是把未知阶段带到下游
{
  assert.equal(normalizeState({ phase: "whatever" }).phase, "idle");
  assert.deepEqual(normalizeState({ phase: "build", experts: [1, "backend", null] }).experts, ["backend"]);
  assert.equal(normalizeState(null).phase, "idle");
}

// 场景七：显式推进——只能往前走一格，回退与跳级都拒绝并给出原因
{
  const spec = { sessionId: "s7", phase: "spec", experts: ["intake"] };
  const built = advancePhase(spec, "build");
  assert.equal(built.changed, true);
  assert.equal(built.state.phase, "build");
  assert.equal(advancePhase(built.state, "review").state.phase, "review");

  const back = advancePhase(built.state, "spec");
  assert.equal(back.changed, false);
  assert.match(back.error, /只能往前走/);

  const skip = advancePhase(spec, "review");
  assert.equal(skip.changed, false);
  assert.match(skip.error, /不能跳着走/);

  const bogus = advancePhase(spec, "shipping");
  assert.equal(bogus.changed, false);
  assert.match(bogus.error, /未知阶段/);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("场景一 文件名规整      ✓");
console.log("场景二 读写与坏文件    ✓");
console.log("场景三 打开即推进      ✓");
console.log("场景四 闸门只提示      ✓");
console.log("场景五 状态卡文案      ✓");
console.log("场景六 怪状态规整      ✓");
console.log("场景七 显式推进        ✓");
console.log("会话状态测试通过");
