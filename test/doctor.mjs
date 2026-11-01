import assert from "node:assert/strict";
import { checkSupply, doctorExitCode, renderReport } from "../lib/doctor.js";

/**
 * 供给检查的单元测试。这里不碰文件系统：`checkSupply` 收的是「专家列表 + 已装技能集合」，
 * 文件去哪读由 CLI 决定——这样测试可以只表达语义。
 */

function expert(id, deps, extra = {}) {
  return {
    id,
    name: extra.name ?? id,
    kind: extra.kind ?? "worker",
    handoff: extra.handoff ?? [],
    deliverables: extra.deliverables ?? [],
    ownSkills: extra.ownSkills ?? [],
    skillDeps: deps,
  };
}

// 场景一：必装齐 → 退出码 0
{
  const report = checkSupply(
    [expert("frontend", [{ name: "frontend-design", required: true, source: "host" }])],
    ["frontend-design"],
  );
  assert.deepEqual(report.missingRequired, []);
  assert.equal(doctorExitCode(report), 0);
}

// 场景二：必装缺席 → 退出码 1，且名字只在 missingRequired 里出现一次
{
  const report = checkSupply(
    [
      expert("docs", [{ name: "doc-coauthoring", required: true, source: "local" }]),
      expert("debug", [{ name: "doc-coauthoring", required: true, source: "local" }]),
    ],
    [],
  );
  assert.deepEqual(report.missingRequired, ["doc-coauthoring"], "两个专家缺同一个技能只报一次");
  assert.equal(doctorExitCode(report), 1);
}

// 场景三：source: host 的依赖不查——宿主自带的技能不该造出假红
{
  const report = checkSupply(
    [expert("data", [{ name: "office-xlsx", required: true, source: "host" }])],
    [],
  );
  assert.deepEqual(report.missingRequired, []);
  const dep = report.rows[0].deps[0];
  assert.equal(dep.unchecked, true);
  assert.equal(dep.present, true);
}

// 场景四：专家自带的 skills/ 算有着落，即使系统目录里没有
{
  const report = checkSupply(
    [expert("rtsp", [{ name: "rtsp-probe", required: true, source: "local" }], { ownSkills: ["rtsp-probe"] })],
    [],
  );
  assert.deepEqual(report.missingRequired, []);
  assert.equal(report.rows[0].deps[0].bundled, true);
}

// 场景五：可选缺只是提示，不改变退出码；文案里两类都点到
{
  const report = checkSupply(
    [
      expert("backend", [
        { name: "codebase-design", required: true, source: "local" },
        { name: "writing-plans", required: false, source: "local" },
      ], { handoff: ["frontend"], deliverables: ["接口定义"] }),
    ],
    ["codebase-design"],
  );
  assert.deepEqual(report.missingOptional, ["writing-plans"]);
  assert.equal(doctorExitCode(report), 0);

  const text = renderReport(report, { expertCount: 1, installedCount: 1 });
  assert.match(text, /技能供给检查：专家 1 个，已装技能 1 个/);
  assert.match(text, /✓ codebase-design/);
  assert.match(text, /· writing-plans/);
  assert.match(text, /常交给：frontend/);
  assert.match(text, /该产出：接口定义/);
  assert.match(text, /另有 1 个可选技能没装/);
  assert.match(text, /必装技能都有着落/);
}

// 场景六：缺必装时的文案要说清装法，而不是只报一个红叉
{
  const report = checkSupply([expert("docs", [{ name: "stop-slop", required: true, source: "local" }])], []);
  const text = renderReport(report, { expertCount: 1, installedCount: 0 });
  assert.match(text, /缺 1 个必装技能：stop-slop/);
  assert.match(text, /技能管理/);
}

console.log("场景一 必装齐全      ✓");
console.log("场景二 必装缺席      ✓");
console.log("场景三 宿主自带不查  ✓");
console.log("场景四 自带技能算数  ✓");
console.log("场景五 可选缺只提示  ✓");
console.log("场景六 文案交代装法  ✓");
console.log("供给体检测试通过");
