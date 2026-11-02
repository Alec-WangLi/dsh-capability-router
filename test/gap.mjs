import assert from "node:assert/strict";
import { explicitExpert, gapText, looksLikeQuestion, looksLikeTask, secondaryText } from "../lib/gap.js";

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
  assert.match(note, /先问用户一句/);
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
    { experts: [{ id: "intake", name: "接单专家", kind: "intake" }] },
    "做个系统，界面和接口都要，还要文档",
  );
  assert.match(note, /跨领域/);
  assert.match(note, /主：后端工程师（3\.5）/);
  assert.match(note, /expert\("intake"\)/);
  assert.match(note, /别自己一个领域一个领域串着硬扛/);
  assert.equal(gapText({ kind: "hit", expert: { id: "backend" } }, { experts: [] }, "x"), undefined, "命中仍然不说话");
}

// 场景十：有新项目但没命中具体专家 → 先说「先接单」，不是「没人干这个」
// 2026-11-02 真实用例：首句「我想做一款Windows记账软件」整场静默，因为落空时
// 旧逻辑先说「没有干这个的人」——而全新项目几乎必然落空，最常见的场景被说错了。
{
  const note = gapText(
    { kind: "miss", candidates: [] },
    { experts: [{ id: "intake", name: "接单专家", kind: "intake" }] },
    "帮我做视频监控系统",
  );
  assert.match(note, /没命中具体专家/);
  assert.match(note, /expert\("intake"\)/);
  assert.doesNotMatch(note, /没有对口的专家/);
}

// 场景十一：主次——一句话压到两个领域时，副的那部分也得有人管
{
  assert.equal(secondaryText({ expert: { name: "数据与办公" } }), undefined, "没有副领域不说话");
  const note = secondaryText({
    expert: { name: "数据与办公" },
    secondary: { expert: { name: "文档与写作" } },
  });
  assert.match(note, /主次/);
  assert.match(note, /数据与办公/);
  assert.match(note, /文档与写作/);
}

// 场景十二（L1）：项目模式的落空提示要带阶段，且不再劝「先接单」。
// 原来 gap 块被 `!projectMode` 整段门控，接单之后 gaps.jsonl 断流；现在提示与记账分开：
// 提示改成「你在哪个阶段、缺什么」，不再说「先 expert("intake")」——单早就接了。
{
  const withIntake = {
    experts: [
      { id: "intake", name: "接单专家", kind: "intake" },
      { id: "frontend", name: "前端工程师" },
    ],
  };
  const note = gapText({ kind: "miss", candidates: [] }, withIntake, "帮我做视频监控系统", {
    phase: "build",
    phaseLabel: "实现",
  });
  assert.ok(note !== undefined, "项目模式里落空也要开口");
  assert.match(note, /实现/, "要说清现在处在哪个阶段");
  assert.doesNotMatch(note, /intake/, "已经接过单了，别再让人去接单");
  assert.doesNotMatch(note, /接单/, "同上：项目模式不该出现「接单」二字");
}

// 场景十三（L1 向后兼容）：phase: "idle" 与不传 options 必须逐字相同。
// 非项目模式的文案是稳定契约，面板与老用户都按它读；多传一个 idle 不能改一个字。
{
  const miss = { kind: "miss", candidates: [] };
  const withIntake = { experts: [{ id: "intake", name: "接单专家", kind: "intake" }] };
  for (const [label, source] of [
    ["有接单专家", withIntake],
    ["没有接单专家", catalog],
  ]) {
    const bare = gapText(miss, source, "帮我做视频监控系统");
    const idle = gapText(miss, source, "帮我做视频监控系统", { phase: "idle" });
    assert.equal(idle, bare, `${label}：phase:"idle" 的文案必须与不传 options 完全一致`);
  }
}

// 场景十四（L1）：项目模式下闲聊仍然静默——克制这条不能因为改了门控就丢
{
  const withIntake = { experts: [{ id: "intake", name: "接单专家", kind: "intake" }] };
  assert.equal(gapText({ kind: "miss", candidates: [] }, withIntake, "今天中午吃什么", { phase: "build" }), undefined);
  assert.equal(gapText({ kind: "miss", candidates: [] }, withIntake, "嗯", { phase: "spec", phaseLabel: "需求确认" }), undefined);
}

// 场景十五（L1）：multi / ambiguous 的文案不受 options 影响（逐字相同）
// 跨领域与分不清说的是「怎么分工」，跟阶段无关；带阶段只在 miss 上生效。
{
  const withIntake = { experts: [{ id: "intake", name: "接单专家", kind: "intake" }] };
  const multi = {
    kind: "multi",
    candidates: [
      { expert: { id: "backend", name: "后端工程师" }, score: 3.5 },
      { expert: { id: "frontend", name: "前端工程师" }, score: 3 },
    ],
  };
  const ambiguous = {
    kind: "ambiguous",
    candidates: [{ expert: { name: "前端工程师" } }, { expert: { name: "排障工程师" } }],
  };
  const text = "做个系统，界面和接口都要";
  assert.equal(gapText(multi, withIntake, text, { phase: "build", phaseLabel: "实现" }), gapText(multi, withIntake, text), "multi 不该被阶段改写");
  assert.equal(gapText(ambiguous, withIntake, text, { phase: "spec", phaseLabel: "需求确认" }), gapText(ambiguous, withIntake, text), "ambiguous 不该被阶段改写");
}

// 场景十六：提问与派活是两个问题。
// 「这个按钮为什么没反应」里有「为什么」，`looksLikeTask` 判它是活（对缺口提示是对的：
// 「怎么实现 X」确实要人干）；但要的是答案还是改动，这句是前者。
{
  const asks = [
    "这个按钮点下去为什么没反应？",
    "你觉得现在的方案还有什么风险？",
    "这样改会不会影响旧数据？",
  ];
  for (const text of asks) assert.equal(looksLikeQuestion(text), true, `应判定为提问：${text}`);

  const commands = [
    "帮我加一个导出 CSV 的按钮",
    "这个参数校验写错了，帮我改成 1",
    "导出为什么失败？帮我修一下",
    "这个页面加载太慢了，优化一下",
  ];
  for (const text of commands) assert.equal(looksLikeQuestion(text), false, `不该判定为提问：${text}`);

  // 委婉请求：句式是疑问，要的是改动。差别在「有没有一个要变的量」——
  // 处置式（把…改/换/删）、改变动作（做成/调成/变）、程度补语（一点/大点/淡点）。
  // 这几句第一版全被判成提问，注入会劝它「别改代码」，该干的活就停在那儿了。
  const polite = [
    "能不能把这个按钮改大一点",
    "这个可以做成深色主题吗？",
    "界面配色能不能再淡一点",
    "能不能把日志级别调成 debug",
  ];
  for (const text of polite) assert.equal(looksLikeQuestion(text), false, `委婉请求不是提问：${text}`);

  // 同样挂着「能不能 / 吗」，问的是能力与支持，那是真提问——不能靠疑问词一刀切。
  const askAbility = [
    "能不能离线用？",
    "这个功能支持多语言吗？",
    "这套流程谁来管？",
  ];
  for (const text of askAbility.slice(0, 2)) assert.equal(looksLikeQuestion(text), true, `问能力仍是提问：${text}`);

  // 有问号没疑问词也是提问；没有问号也没有疑问词，一律当活。
  assert.equal(looksLikeQuestion("这个报错什么意思？"), true);
  assert.equal(looksLikeQuestion("今天中午吃什么"), false);
  assert.equal(looksLikeQuestion(""), false);
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
// 场景十七：派单书自己点了人，就别再选一次。
// 真实缺口账本里 5 条 `multi` 全是派单书——它们提到前端、测试、审查，按词面算跨领域没错，
// 按语义算错：选人这一步已经做完了。注入「按主领域开工、副的一起交」等于让后端顺手把前端也做了。
{
  const fake = [
    { id: "backend", name: "后端工程师", kind: "worker", triggers: [], synonyms: [] },
    { id: "review", name: "审查专家", kind: "reviewer", triggers: [], synonyms: [] },
    { id: "frontend", name: "前端工程师", kind: "worker", triggers: [], synonyms: [] },
  ];

  // `expert("…")` 是最常见的样子
  assert.equal(
    explicitExpert('你现在的身份是**后端工程师**（用 `expert("backend")` 取完整工作方式）', fake)?.id,
    "backend",
  );
  // 中文身份声明，且带 markdown 加粗——不去标记就一条都认不出来
  assert.equal(explicitExpert("身份：**审查专家**。项目目录 x", fake)?.id, "review");
  assert.equal(explicitExpert("你是后端工程师，把接口补上", fake)?.id, "backend");
  // 反例：只是提到这个领域，没有点名让谁干
  assert.equal(explicitExpert("帮我把接口补上，前端也要改", fake), undefined);
  assert.equal(explicitExpert("作为一个审查专家，我觉得还行", fake), undefined);
  assert.equal(explicitExpert("", fake), undefined);
  // 点到不在目录里的 id：不算派单
  assert.equal(explicitExpert('用 `expert("nobody")` 取', fake), undefined);

  // 上限：账本里记 explicit 不是命中，但也不能落进缺口提示
  assert.equal(
    gapText({ kind: "explicit", expert: fake[0], candidates: [] }, { experts: fake }, "身份：后端工程师"),
    undefined,
  );
  // 对照：没有身份声明时，跨领域提示照旧
  assert.match(
    gapText(
      { kind: "multi", candidates: [{ expert: fake[2], score: 3 }, { expert: fake[0], score: 2 }] },
      { experts: fake },
      "登录页样式乱了，顺便把接口也改一下",
    ),
    /跨领域/,
  );
}

console.log("场景十七 派单书不再选人 ✓");
console.log("场景十六 提问与派活   ✓");
console.log("场景十二 项目模式文案 ✓");
console.log("场景十三 idle 逐字相同 ✓");
console.log("场景十四 闲聊仍静默  ✓");
console.log("场景十五 跨领域不受影响 ✓");
console.log("缺口提示测试通过");
