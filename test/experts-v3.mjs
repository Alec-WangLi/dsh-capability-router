import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogText } from "../lib/catalog.js";
import { scanExperts } from "../lib/experts.js";
import { matchExpert } from "../lib/router.js";

/**
 * v0.20.0 的三位新专家包 + 目录标签（A7）。
 *
 * 断言来源：REQUIREMENTS.md 的 A7、TASKS.md 的 T3 要点。
 * 只读 `experts/`，不建临时包——这里验的是仓库自带的真实产物，
 * 包写坏了就该红，不能靠测试自造的替身糊过去。
 *
 * 用 `check()` 收集而不是一挂就停：T3 由 docs 并行写，包可能只落地一半，
 * 一次跑完能直接看出「缺哪几个包 / 哪几个字段」。
 *
 * 盲区清单（A8 只测匹配器、A11 退出码、A14 靠旧套、A15 人工核对等六条）见
 * `test/state-level.mjs` 顶部「这套测试不覆盖什么」——别以为这里的 ✓ 覆盖了那张表。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);

const failures = [];
let total = 0;

function check(name, fn) {
  total += 1;
  try {
    fn();
    console.log(`${name} ✓`);
  } catch (error) {
    failures.push([name, error]);
    console.log(`${name} ✗`);
  }
}

const scanned = scanExperts({ dirs: [path.join(REPO_ROOT, "experts")] });
const experts = scanned.experts;

function find(id) {
  const expert = experts.find((row) => row.id === id);
  assert.ok(expert, `没有扫到专家 ${id}（现有：${experts.map((row) => row.id).join("、") || "无"}）`);
  return expert;
}

// 场景一（A7 / A10）：十个专家、零错误、每个都带 role 与触发词
check("场景一 十个专家零错误", () => {
  assert.equal(scanned.errors.length, 0, `不应有错误：${scanned.errors.join("; ")}`);
  // 仓库自带的包不该有告警：`kind 只能是 …，按 worker 处理` 这类告警说明包里写的值
  // 没人认识，专家会被静默降级——比报错更难发现，所以在这里一并卡住。
  assert.equal(scanned.warnings.length, 0, `不应有告警：${scanned.warnings.join("; ")}`);
  assert.equal(experts.length, 10, `应扫出 10 个专家，实际 ${experts.length}（${experts.map((row) => row.id).join("、")}）`);
  for (const expert of experts) {
    assert.equal(expert.hasRole, true, `${expert.id} 缺 role.md`);
    assert.ok(expert.role.trim().length > 0, `${expert.id} 的 role.md 是空的`);
    assert.ok(expert.triggers.length > 0, `${expert.id} 没有触发词`);
    assert.ok(expert.description.length > 0, `${expert.id} 没有 description`);
  }
  const ids = experts.map((row) => row.id).sort();
  assert.deepEqual(ids, ["backend", "data", "debug", "docs", "frontend", "intake", "qa", "research", "reverse", "review"]);
});

// 场景二（A7）：research 是 scout，产出 PRIOR-ART.md，交接从接单起
check("场景二 research 是调研专家", () => {
  const research = find("research");
  assert.equal(research.kind, "scout", `research 的 kind 应为 scout，实际 ${research.kind}`);
  assert.equal(research.hasRole, true, "research 要有 role.md");
  assert.ok(research.role.trim().length > 0, "research 的 role.md 不能是空文件");
  assert.ok(
    research.deliverables.includes("PRIOR-ART.md"),
    `research 的产出要含 PRIOR-ART.md，实际 ${JSON.stringify(research.deliverables)}`,
  );
  assert.ok(
    research.handoff.includes("intake"),
    `research 的交接首位应是接单（T3 要点 2），实际 ${JSON.stringify(research.handoff)}`,
  );
});

// 场景三（A7）：reverse / qa 都是 worker，role 非空
check("场景三 reverse / qa 是 worker", () => {
  const reverse = find("reverse");
  assert.equal(reverse.kind, "worker", `reverse 的 kind 应为 worker，实际 ${reverse.kind}`);
  assert.equal(reverse.hasRole, true, "reverse 要有 role.md");
  assert.ok(reverse.role.trim().length > 0, "reverse 的 role.md 不能是空文件");

  const qa = find("qa");
  assert.equal(qa.kind, "worker", `qa 的 kind 应为 worker，实际 ${qa.kind}`);
  assert.equal(qa.hasRole, true, "qa 要有 role.md");
  assert.ok(qa.role.trim().length > 0, "qa 的 role.md 不能是空文件");
});

// 场景四（A7 / A11）：qa 的两门必装技能写在包里，doctor 才有得查
check("场景四 qa 的必装技能", () => {
  const qa = find("qa");
  const names = qa.skills ?? [];
  assert.ok(names.includes("test-driven-development"), `qa 缺 test-driven-development，实际 ${JSON.stringify(names)}`);
  assert.ok(
    names.includes("verification-before-completion"),
    `qa 缺 verification-before-completion，实际 ${JSON.stringify(names)}`,
  );
  const deps = Object.fromEntries((qa.skillDeps ?? []).map((dep) => [dep.name, dep]));
  assert.equal(deps["test-driven-development"]?.required, true, "test-driven-development 标为必装");
  assert.equal(deps["verification-before-completion"]?.required, true, "verification-before-completion 标为必装");
});

// 场景五（A7）：目录给 scout 一个独立标签，且不冒充入口/收口
check("场景五 目录标签：调研", () => {
  const text = catalogText(experts);
  assert.match(text, /【调研】/, "目录里要有【调研】标签");

  const lines = text.split("\n");
  const head = (id) => {
    const line = lines.find((row) => row.includes(`（${id}，`));
    assert.ok(line, `目录里定位不到 ${id} 那一行`);
    return line;
  };

  const researchLine = head("research");
  assert.match(researchLine, /【调研】/, "research 要标【调研】");
  assert.equal(researchLine.includes("【入口】"), false, "research 不是入口");
  assert.equal(researchLine.includes("【收口】"), false, "research 不是收口");

  assert.match(head("intake"), /【入口】/, "入口标签不能因为新增 scout 掉了");
  assert.match(head("review"), /【收口】/, "收口标签不能因为新增 scout 掉了");
});

// 场景六（A8 的回归护栏）：三句新探针直接走 matchExpert，不靠 CLI。
// 为什么要有这一条：`npm test` 的链里没有 `tools/match.mjs`（那是 `npm run accept`），
// 词表被改坏时 `npm test` 照样全绿——而词表恰恰是这一版最会变的东西。
// 句子与 `tools/match.mjs` 的 SET_C 三句保持一致（那边是 CLI 验收，这边是单测护栏）。
check("场景六 三句探针命中新专家（A8）", () => {
  const probes = [
    ["这 exe 怎么校验激活码的", "reverse"],
    ["写一套回归用例把登录流程盖住", "qa"],
    ["先查查市面上有没有现成的记账软件", "research"],
  ];
  for (const [text, expected] of probes) {
    const result = matchExpert(text, experts);
    assert.equal(result.kind, "hit", `「${text}」应命中 ${expected}，实际 ${result.kind}`);
    assert.equal(result.expert.id, expected, `「${text}」应命中 ${expected}，实际 ${result.expert?.id}`);
  }
});

// 场景七（v0.21.5）：英文召回。十二句真实英文需求各归各位。
// 为什么要有这一条：v0.21.0 给十位专家补了英文触发词，但没人验过「十二句里落得中几句」——
// 补词不等于接得住。第一版实测 12 句里 4 句 miss、1 句 ambiguous，全都补完之后才 12/12。
check("场景七 英文需求落到对的人（v0.21.5）", () => {
  const probes = [
    ["build me a small tool that renames photos by date", "intake"],
    ["the login page breaks on narrow screens", "frontend"],
    ["add a delete button to the list", "frontend"],
    ["the api returns 500 when saving the form", "backend"],
    ["why does the export fail", "debug"],
    ["this csv has duplicate rows", "data"],
    ["the app crashes on start", "debug"],
    ["crack the license check in this binary", "reverse"],
    ["unpack this apk and find the api key", "reverse"],
    ["write a proposal for the new dashboard", "docs"],
    ["the tests are flaky on ci", "qa"],
    ["summarize this spreadsheet into a report", "data"],
  ];
  for (const [text, expected] of probes) {
    const result = matchExpert(text, experts);
    assert.equal(result.kind, "hit", `「${text}」应命中 ${expected}，实际 ${result.kind}`);
    assert.equal(result.expert.id, expected, `「${text}」应命中 ${expected}，实际 ${result.expert?.id}`);
  }
});

// 场景八（v0.21.5）：英文有词形变化，词边界要放行屈折尾巴。
// `crashes` 里 `crash` 后面跟着字母，严格词边界会判成「不认识」——英文需求一半是这种句子。
// 但也不能退回子串匹配，否则 `so` 会命中 `slow`（十六·5 栽过一次）。
check("场景八 词形变化认得，子串误配不认得（v0.21.5）", () => {
  assert.equal(matchExpert("the app crashes on start", experts).expert?.id, "debug", "crashes 要认得 crash");
  assert.equal(matchExpert("the build fails on ci", experts).kind, "hit", "fails 要认得 fail");
  assert.notEqual(matchExpert("this is also slow but fine", experts).expert?.id, "reverse", "slow 里没有 so 这个专家");
});

if (failures.length > 0) {
  console.error(`\n失败 ${failures.length}/${total} 项：`);
  for (const [name, error] of failures) {
    const message = String(error?.message ?? error).split("\n")[0];
    console.error(`- ${name}：${message}`);
  }
  process.exitCode = 1;
} else {
  console.log("三位新专家与目录标签测试通过");
}
