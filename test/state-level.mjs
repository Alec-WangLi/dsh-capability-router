import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as stateApi from "../lib/state.js";

/**
 * v0.20.0 状态机的新字段：`level`（用户水平）与 `approved`（方案确认）。
 *
 * 断言来源：REQUIREMENTS.md 的 A1–A6、A12 与「附：接口契约」。
 *
 * 两条写法上的选择，先说清楚：
 *
 * 1. **用命名空间导入 + `need()` 取值**，而不是 `import { setLevel }`。
 *    具名导入在链接期就会因为缺导出整份文件崩掉，红的时候只会看到一行
 *    SyntaxError，看不出还差什么；这里改成「先断言导出在不在」，红灯带原因。
 *
 * 2. **用 `check()` 包一层，跑完所有场景再收口**，而不是像 `test/state.mjs` 那样
 *    平铺断言。理由很实际：T4 同时卡着 T1（state.js）、T2（catalog+index）、
 *    T3（专家包）三条线的落地进度，断言一挂就停的话一次只能看到第一处红；
 *    这里每个场景独立跑，一次能拿到完整清单，方便分辨「等实现」和「写错了」。
 *
 * 只用临时目录：绝不碰 `~/.dsh/capability-router`（DESIGN 坑 4：测试污染真实状态，
 * 害过我们一次——本地状态被测试写坏，模型看到的状态卡和项目实际阶段对不上）。
 */

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * 这套测试不覆盖什么（六条，来自 T4 自验时的诚实清点，交给 review 时原样带上）
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. A8 的**真实效果**测不到。`tools/match.mjs` 只证明「匹配器把写死的那几句判成
 *    reverse / qa / research」，不证明模型真的会去调那位专家；换一种说法还能不能命中，
 *    c 集不回答（b 集也只覆盖旧的八位专家）。c 集是回归护栏，不是泛化度量。
 *
 * 2. A11 的**退出码语义**由 `test/doctor.mjs` 覆盖（场景一必装齐 → 0、场景二必装缺席 → 1、
 *    场景五可选缺不改变退出码），但那套喂的是构造出来的 report，不是真实专家包。
 *    真实包里 `required` 标记只有 qa 那两条有断言（`test/experts-v3.mjs` 场景四）；
 *    intake / review 等其余专家的必装技能只在 `npm run doctor` 的输出里体现，没有测试守。
 *
 * 3. A14（`enabled:false` 不注入、不扫描、不挂钩）靠现有 `test/smoke.mjs` 场景保绿，
 *    本套没有加强它，也没有反向验证「关掉之后真的什么都没发生」。
 *
 * 4. A15（文档同步）纯人工核对，测不了。`test/experts-v3.mjs` 只保证「包里有 10 个、
 *    role 非空」；README / FEATURES / DESIGN 里字段名有没有抄错，测试看不见。
 *
 * 5. 「闸门是软提示、不拦截」只能测文案（note 含不含某句话）。因为实现里本来就没有
 *    拦截路径，「不拦截」这件事没有可断言的对象——文案对了不代表行为对了。
 *
 * 6. 状态卡的 120 字上限现在按「真实 id × 全阶段 × 全水平 × 全场人数」饱和遍历（330 组），
 *    能守住字数与「砍对段」，但测不到「用户真的读得下去」——文案质量本身没有断言守。
 *
 * 另有一条不属于验收标准、但踩过坑的经验，留给下一个人：
 * `lib/experts.js` 的 `KINDS` 是白名单，包里写了它不认识的 `kind`（v0.20.0 的 `scout`）
 * 只出一条**告警**并把专家静默降级成 `worker`——门牌还是那个专家，行为却变了。
 * 这类坑比报错难发现得多：以后再加 `kind` 取值，`lib/experts.js` 必须同步进写范围。
 * 现在 `test/experts-v3.mjs` 场景一用「0 条告警」把这条卡住，别再退化。
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-state-level-"));

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

/** 取一个应当已导出的函数；没有就给出「等 backend T1」级别的明确原因。 */
function need(name) {
  const value = stateApi[name];
  assert.equal(typeof value, "function", `lib/state.js 还没导出 ${name}（等 backend T1 落地）`);
  return value;
}

const SPEC = { sessionId: "gate", phase: "spec", experts: ["intake"] };

// 场景一（A12）：v0.19 形状的旧文件读入不抛，两个新字段取默认值
check("场景一 旧 state 兼容（A12）", () => {
  const legacy = {
    sessionId: "old",
    phase: "build",
    experts: ["intake", "backend"],
    since: "2026-11-01T00:00:00.000Z",
  };

  let next;
  assert.doesNotThrow(() => {
    next = stateApi.normalizeState(legacy);
  }, "旧形状不该抛");

  assert.equal(next.level, undefined, "旧文件没有 level，应视为未判定");
  assert.equal(next.approved, false, "旧文件没有 approved，应视为未确认");
  assert.equal(next.phase, "build", "缺新字段不该把 phase 一起回落");
  assert.deepEqual(next.experts, ["intake", "backend"]);
  assert.equal(next.since, "2026-11-01T00:00:00.000Z");
});

// 场景二（A12 反面）：非法 level 只回落自己，其余字段一个都不能丢
check("场景二 非法 level 不牵连同族字段", () => {
  const next = stateApi.normalizeState({
    sessionId: "bad-level",
    phase: "spec",
    experts: ["intake"],
    level: "expert",
    approved: true,
    project: "/tmp/some-project",
    since: "2026-10-31T12:00:00.000Z",
  });

  assert.equal(next.level, undefined, "非法 level 应回落 undefined，而不是丢弃整个 state");
  assert.equal(next.phase, "spec");
  assert.deepEqual(next.experts, ["intake"]);
  assert.equal(next.approved, true, "level 非法不该把 approved 一起清掉");
  assert.equal(next.project, "/tmp/some-project", "project 也不能丢");
  assert.equal(next.since, "2026-10-31T12:00:00.000Z");
});

// 场景三：approved 只认严格 true——状态文件是外部输入，字符串 "true" 不算确认
check("场景三 approved 只认严格 true", () => {
  assert.equal(stateApi.normalizeState({ approved: "true" }).approved, false, "字符串 \"true\" 不是确认");
  assert.equal(stateApi.normalizeState({ approved: 1 }).approved, false, "数字 1 不是确认");
  assert.equal(stateApi.normalizeState({ approved: "yes" }).approved, false);
  assert.equal(stateApi.normalizeState({ approved: true }).approved, true);
  assert.equal(stateApi.normalizeState({ approved: false }).approved, false);
});

// 场景四：setLevel——合法值落盘、非法值给 error 且不动 state、不改原对象
check("场景四 setLevel", () => {
  const setLevel = need("setLevel");
  assert.ok(Array.isArray(stateApi.LEVELS), "lib/state.js 还没导出 LEVELS");
  assert.deepEqual(stateApi.LEVELS, ["novice", "pro"]);

  const base = stateApi.normalizeState({ sessionId: "lvl", phase: "spec", experts: ["intake"] });
  assert.equal(base.level, undefined);

  const novice = setLevel(base, "novice");
  assert.equal(novice.error, undefined, "合法 level 不该报错");
  assert.equal(novice.state.level, "novice");
  assert.equal(base.level, undefined, "setLevel 不该改原对象");

  const pro = setLevel(base, "pro");
  assert.equal(pro.state.level, "pro");

  const bad = setLevel(pro.state, "expert");
  assert.ok(bad.error, "非法 level 要给 error");
  assert.equal(bad.state.level, "pro", "非法 level 不改 state");
});

// 场景五：setApproved——确认、撤销、幂等，且不改原对象
check("场景五 setApproved", () => {
  const setApproved = need("setApproved");

  const base = stateApi.normalizeState({ sessionId: "apr", phase: "spec" });
  assert.equal(base.approved, false, "默认未确认");

  const on = setApproved(base, true);
  assert.equal(on.state.approved, true);
  assert.equal(on.changed, true, "真变了就该说变了");
  assert.equal(typeof on.state, "object");
  assert.equal(base.approved, false, "setApproved 不该改原对象");

  const off = setApproved(on.state, false);
  assert.equal(off.state.approved, false, "撤销要能回到未确认");
  assert.equal(off.changed, true);

  const again = setApproved(off.state, false);
  assert.equal(again.state.approved, false);
  assert.equal(again.changed, false, "值没变时 changed 应为 false（幂等）");
  assert.equal(again.error, undefined, "重复设置同一值不是错误");
});

// 场景六（A1）：未确认 + 未判定 → 状态卡同时含两段
check("场景六 状态卡：待确认 + 未判定（A1）", () => {
  const text = stateApi.stateCardText({ sessionId: "card", phase: "spec", experts: ["intake"] });
  assert.match(text, /方案：待确认/);
  assert.match(text, /用户水平：未判定/);
  assert.equal(text.includes("\n"), false, "状态卡仍是一行");
});

// 场景七（A2）：两档水平的中文说法
check("场景七 状态卡：新手 / 老手（A2）", () => {
  assert.match(stateApi.stateCardText({ phase: "spec", level: "novice" }), /用户水平：新手/);
  assert.match(stateApi.stateCardText({ phase: "spec", level: "pro" }), /用户水平：老手/);
});

// 场景八（A3 / A4）：已确认时不占字，撤销后重新出现「待确认」
check("场景八 状态卡：确认后不显示方案段（A3 / A4）", () => {
  const confirmed = stateApi.stateCardText({ phase: "build", approved: true });
  assert.equal(confirmed.includes("方案"), false, "approved === true 时不显示「方案」段");

  const revoked = stateApi.stateCardText({ phase: "spec", approved: false });
  assert.match(revoked, /方案：待确认/, "撤销后要重新出现待确认");
});

// 场景九（A5 + F9）：spec 阶段开 worker —— 先别开工；level 未判定时还要多问一句；
// 方案未确认时要把「用户说『直接做』也算确认」这个口径说出来。
check("场景九 gateNote：worker 在 spec（A5 / F9）", () => {
  const note = stateApi.gateNote(SPEC, { id: "backend", kind: "worker" });
  assert.match(note, /先别开工/, "spec 阶段开领域专家要先泼冷水");
  assert.match(note, /先问一句用户想听多细/, "level 未判定时要追加这一问");

  // F9：`gateNote` 的 spec+worker 分支在方案未确认时必须把「直接做也算确认」告诉模型。
  // 它没有对应的状态可断言（approved 只由模型显式调用改变），所以只能测文案存在性——
  // 这条断言的薄弱之处正是它存在的理由：没有它，删掉那句话连红都不会红。
  // 实测四种组合的字数（这套文案的实际上限）：
  //   未判定 + 未确认 = 181 字（最长，每轮注入一次）
  //   已判定 + 未确认 = 112 字
  //   未判定 + 已确认 = 133 字
  //   已判定 + 已确认 =  64 字
  // 上下文预算吃紧要砍时，优先级与 `lib/state.js:242-243` 的注释一致：
  // 「先别开工」与「直接做也算确认」是行为约束，必须留；问水平那句是礼貌，先砍。
  assert.match(note, /直接做/);
  assert.match(note, /也算确认/);
  assert.match(note, /先别开工/, "砍文案时行为约束要留");

  const known = stateApi.gateNote({ ...SPEC, level: "novice" }, { id: "backend", kind: "worker" });
  assert.match(known, /先别开工/);
  assert.equal(known.includes("先问一句用户想听多细"), false, "level 判定过就不该再问");

  // 已确认时整段消失：已经在 spec 且已确认，不必再劝
  const confirmed = stateApi.gateNote({ phase: "spec", approved: true, level: "pro" }, { id: "backend", kind: "worker" });
  assert.doesNotMatch(confirmed, /直接做/);
  assert.match(confirmed, /先别开工/, "方案确认了但需求文档还没产出，先别开工这句仍然有效");

  // 文案总长上限 200：四种组合各断一次。
  // 为什么是 200 而不是 181（今天最长的形态）：
  //   181 + 19 字余量，够一次小改，不够无限堆；
  //   写成「刚好等于今天」的断言，会在第一次善意改文案时爆掉，然后被人顺手调大，护栏就废了——
  //   留余量的阈值才会被当成规矩。
  // 超过 200 说明有人在往同一段里持续加东西：那时候该做的是**拆**（比如把「问水平」与
  // 「确认口径」拆成两条只在需要时出现的文案），不是继续加。别把数字直接调大。
  // 注意这只是上限，不是等值断言：今天实测 181 / 112 / 133 / 64，缩文案不该红。
  const combos = [
    ["未判定 + 未确认", { phase: "spec", approved: false, level: undefined }, 181],
    ["已判定 + 未确认", { phase: "spec", approved: false, level: "novice" }, 112],
    ["未判定 + 已确认", { phase: "spec", approved: true, level: undefined }, 133],
    ["已判定 + 已确认", { phase: "spec", approved: true, level: "pro" }, 64],
  ];
  for (const [label, state, measured] of combos) {
    const text = stateApi.gateNote(state, { id: "backend", kind: "worker" });
    assert.ok(
      text.length <= 200,
      `${label} 已经 ${text.length} 字（今天 ${measured} 字）。超过 200 就拆文案，别继续加，也别调大这个数`,
    );
  }
});

// 场景十（A6）：idle / spec 是 PRIOR-ART 的出口；build 之后只提醒别回头（F5）。
// 契约原文写的是「不论阶段」，review 判 F5：deliver 阶段需求早写完，再劝人
// 「再决定需求怎么写」是错的，所以实现改成按阶段分叉。这是 review 收紧的契约，
// 按 TASKS.md 的规矩改测试不改实现——我只动断言，没动 lib/。
check("场景十 gateNote：scout 只在需求阶段要 PRIOR-ART（A6）", () => {
  const note = stateApi.gateNote(SPEC, { id: "research", kind: "scout" });
  assert.match(note, /PRIOR-ART\.md/);
  assert.equal(note.includes("先别开工"), false, "调研专家的 note 不该说先别开工");

  const inIdle = stateApi.gateNote(stateApi.newState("idle-scout"), { id: "research", kind: "scout" });
  assert.match(inIdle, /PRIOR-ART\.md/, "idle 也是调研的出口（还没接单时先查现成的）");

  // 需求定稿之后：不许再劝人重做主选型，但也不能没话说、更不能滑进 worker 分支。
  for (const phase of ["build", "review", "deliver"]) {
    const later = stateApi.gateNote({ ...SPEC, phase }, { id: "research", kind: "scout" });
    assert.ok(later !== undefined, `${phase} 阶段开调研专家也要有一句`);
    assert.doesNotMatch(later, /PRIOR-ART\.md/, `${phase} 之后别再劝人重做主选型`);
    assert.match(later, /别再回到选型上/, `${phase} 的提醒要说清「别回头」`);
    assert.equal(later.includes("先别开工"), false, `${phase} 的调研 note 不该说先别开工`);
  }
});

// 场景十一：落盘往返——两个新字段真的存得住、读得回（只用临时目录）
check("场景十一 落盘往返保留新字段", () => {
  const file = stateApi.stateFile(tmp, "lvl-1");
  const written = stateApi.writeState(file, {
    sessionId: "lvl-1",
    phase: "spec",
    experts: ["intake"],
    level: "pro",
    approved: true,
  });
  assert.equal(written.state.level, "pro", "writeState 的返回值要带 level");
  assert.equal(written.state.approved, true);

  const back = stateApi.readState(file);
  assert.equal(back.level, "pro", "读回来 level 还在");
  assert.equal(back.approved, true, "读回来 approved 还在");
  assert.equal(back.phase, "spec");

  const legacyFile = path.join(tmp, "sessions", "legacy-disk.json");
  fs.writeFileSync(legacyFile, JSON.stringify({ sessionId: "legacy-disk", phase: "build", experts: ["intake"] }), "utf8");
  const legacy = stateApi.readState(legacyFile);
  assert.equal(legacy.level, undefined);
  assert.equal(legacy.approved, false, "磁盘上的旧文件读成未确认");
});

// 场景十二：状态卡 120 字上限——真实 id × 全阶段 × 全水平 × 全场人数，一格都不许超。
// 为什么必须用真实 id：`worker-00` 这种短 id 砍完只剩 54 字，看着「没超」其实离边界还远，
// 等于没测（review 判 F7 的原话）。真实 id 里最长的是 frontend / research，实测两格零余量：
//   build / 已确认 / pro       + 9 个真实 id = 正好 120 字（未砍），10 个就砍；
//   deliver / 未确认 / 未判定  + 3 个真实 id = 正好 120 字（未砍）。
// 将来谁给 `nextStep` 加一个字，这两格先超限被砍，下面「被砍了就红」的断言就会响——
// 这是有意为之的护栏，不是脆弱：上限本来就没有余量，得有人守着。
check("场景十二 状态卡不超 120 字（真实 id 饱和遍历）", () => {
  const IDS = ["backend", "frontend", "intake", "qa", "research", "reverse", "review", "docs", "data", "debug"];
  const LEVEL_VARIANTS = [undefined, ...stateApi.LEVELS];
  let checked = 0;

  for (const phase of stateApi.PHASES) {
    for (const approved of [true, false]) {
      for (const level of LEVEL_VARIANTS) {
        for (let count = 0; count <= IDS.length; count += 1) {
          const state = { phase, approved, level, experts: IDS.slice(0, count) };
          const text = stateApi.stateCardText(state);
          const where = `${phase}/approved:${approved}/level:${level ?? "未判定"}/${count} 人`;
          assert.ok(text.length <= 120, `${where} 超上限：${text.length} 字`);
          // 超长只准砍「在场专家」这一段，水平与下一步必须留下。
          assert.ok(text.includes("用户水平"), `${where} 丢了用户水平`);
          assert.ok(text.includes("下一步"), `${where} 丢了下一步`);
          checked += 1;
        }
      }
    }
  }

  const expected = stateApi.PHASES.length * 2 * LEVEL_VARIANTS.length * (IDS.length + 1);
  assert.equal(checked, expected, `遍历覆盖面变了：实际 ${checked} 组，应有 ${expected} 组`);

  // 零余量第一格：9 个真实 id 没被砍，10 个必须被砍
  const tight = stateApi.stateCardText({ phase: "build", approved: true, level: "pro", experts: IDS.slice(0, 9) });
  assert.ok(tight.length <= 120, `9 个真实 id 已经 ${tight.length} 字`);
  assert.ok(tight.includes("在场专家"), "9 个真实 id 是上限内的最后一档，这一格被砍了就说明上限没用满");
  assert.ok(tight.includes("用户水平") && tight.includes("下一步"));

  const spilled = stateApi.stateCardText({ phase: "build", approved: true, level: "pro", experts: IDS.slice(0, 10) });
  assert.equal(spilled.includes("在场专家"), false, "10 个真实 id 必须砍掉在场专家");
  assert.ok(spilled.length < tight.length, "砍完必须更短");

  // 零余量第二格：deliver / 未确认 / 未判定 + 3 个真实 id
  const deliverTight = stateApi.stateCardText({ phase: "deliver", approved: false, level: undefined, experts: IDS.slice(0, 3) });
  assert.ok(deliverTight.length <= 120, `deliver 这格已经 ${deliverTight.length} 字`);
  assert.ok(deliverTight.includes("在场专家"), "deliver 这格是另一处零余量，被砍了就说明下一步文案变长了");
  assert.ok(deliverTight.includes("方案：待确认"), "未确认在 deliver 阶段也要显示");
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n失败 ${failures.length}/${total} 项：`);
  for (const [name, error] of failures) {
    const message = String(error?.message ?? error).split("\n")[0];
    console.error(`- ${name}：${message}`);
  }
  process.exitCode = 1;
} else {
  console.log("状态机新字段测试通过");
}
