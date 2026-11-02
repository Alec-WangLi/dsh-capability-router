/**
 * 英文适配（v0.21.0）。
 *
 * 要守的两件事：
 *   1. 语言只影响「怎么说」，不影响「说不说」——判据全是语言无关的分数与词表，
 *      同一句话换个语言说，该不该开口必须一样。
 *   2. 判不出语言时沿用上一次，不能因为用户发了个「??」就把会话切成中文。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectLang, PHASE_LABEL_EN } from "../lib/i18n.js";
import { gapText, secondaryText } from "../lib/gap.js";
import { advancePhase, gateNote, newState, stateCardText } from "../lib/state.js";

const CATALOG = {
  experts: [
    { id: "intake", name: "接单专家", nameEn: "Intake", kind: "intake" },
    { id: "backend", name: "后端工程师", nameEn: "Backend", kind: "worker" },
    { id: "review", name: "审查专家", nameEn: "Reviewer", kind: "reviewer" },
  ],
};

// 场景一：detectLang 的四态
{
  assert.equal(detectLang("build me a tool"), "en");
  assert.equal(detectLang("帮我做个工具"), "zh");
  assert.equal(detectLang("中英 mixed 的句子"), "zh", "混排以汉字为准：读得懂中文的人不需要英文");
  assert.equal(detectLang("???"), undefined, "纯标点不判：一串问号不该把会话切成英文");
  assert.equal(detectLang("123"), undefined);
  assert.equal(detectLang(""), undefined);
  assert.equal(detectLang(undefined), undefined, "非字符串也不能炸");
}

// 场景二：gapText 英文——项目模式两条分支都不带汉字
{
  const project = { phase: "build", phaseLabel: "实现", lang: "en" };
  const miss = gapText({ kind: "miss", candidates: [] }, CATALOG, "add a delete button to the list", project);
  assert.match(miss, /\[capability-router · no specialist matched\]/);
  assert.match(miss, /the project is in build/, "阶段名也要英文：`the project is in 实现` 是半句中文");
  assert.doesNotMatch(miss, /[\u4e00-\u9fff]/, "英文分支里不该残留汉字");

  const notTask = gapText({ kind: "miss", candidates: [] }, CATALOG, "ok go ahead", project);
  assert.match(notTask, /\[capability-router · not a new task\]/);
  assert.doesNotMatch(notTask, /[\u4e00-\u9fff]/);
}

// 场景三：判据与语言无关——中英两句说同一件事，开不开口必须一样
{
  const zh = gapText({ kind: "miss", candidates: [] }, CATALOG, "把这个按钮改成蓝色", { phase: "build", phaseLabel: "实现" });
  const en = gapText({ kind: "miss", candidates: [] }, CATALOG, "change this button to blue", { phase: "build", phaseLabel: "实现", lang: "en" });
  assert.equal(zh !== undefined, en !== undefined, "同一件事换个语言说，该不该开口不能变");
}

// 场景四：新项目没对口——有接单专家时指向它，一个专家都没有时才说「没有对口的」
{
  const withIntake = gapText({ kind: "miss", candidates: [] }, CATALOG, "analyze this firmware image", { lang: "en" });
  assert.match(withIntake, /\[capability-router · no specialist matched\]/);
  assert.match(withIntake, /expert\("intake"\)/, "有接单专家就先让它收敛需求");
  assert.doesNotMatch(withIntake, /[一-鿿]/, "英文分支里不该残留汉字");

  const bare = gapText({ kind: "miss", candidates: [] }, { experts: [] }, "analyze this firmware image", { lang: "en" });
  assert.match(bare, /\[capability-router · no matching specialist\]/, "一个专家都没有时说的是「没有对口的」");
  assert.match(bare, /there are no expert packs at all/);
  assert.doesNotMatch(bare, /[一-鿿]/);
}

// 场景五：multi / ambiguous 的英文分支
{
  const verdict = {
    kind: "multi",
    expert: CATALOG.experts[1],
    secondary: { expert: CATALOG.experts[2], score: 1.5 },
    candidates: [CATALOG.experts[1], CATALOG.experts[2]],
  };
  const en = secondaryText(verdict, "en");
  assert.match(en, /\[capability-router/);
  assert.doesNotMatch(en, /[\u4e00-\u9fff]/, "英文分支里不该残留汉字");

  const zh = secondaryText(verdict, "zh");
  assert.match(zh, /【能力路由/, "中文分支不许被英文改动带走");
}

// 场景六：状态卡英文 ≤ 190 字符，且五个阶段都能渲染
for (const phase of ["idle", "spec", "build", "review", "deliver"]) {
  const state = { ...newState("s-i18n"), phase, level: "pro", experts: ["intake", "research", "backend", "frontend", "qa", "debug"] };
  const card = stateCardText(state, "en");
  assert.ok(card.length <= 190, `${phase} 的英文状态卡超长：${card.length}`);
  assert.match(card, new RegExp(`phase: ${phase}`), `${phase} 的阶段名要是英文`);
  assert.doesNotMatch(card, /[\u4e00-\u9fff]/, `${phase} 的英文状态卡里不该有汉字`);
}

// 场景七：闸门英文——每个分支都得说英文，且不能粘句
{
  const cases = [
    [{ ...newState("s1"), phase: "spec" }, { id: "backend", kind: "worker" }],
    [{ ...newState("s2"), phase: "idle" }, { id: "review", kind: "reviewer" }],
    [{ ...newState("s3"), phase: "review" }, { id: "backend", kind: "worker" }],
    [{ ...newState("s4"), phase: "deliver" }, { id: "backend", kind: "worker" }],
    [{ ...newState("s5"), phase: "deliver" }, { id: "review", kind: "reviewer" }],
    [{ ...newState("s6"), phase: "deliver" }, { id: "intake", kind: "intake" }],
    [{ ...newState("s7"), phase: "build" }, { id: "research", kind: "scout" }],
  ];
  for (const [state, expert] of cases) {
    const note = gateNote(state, expert, "en");
    assert.equal(typeof note, "string", `${state.phase} + ${expert.kind} 该有闸门文案`);
    assert.doesNotMatch(note, /[\u4e00-\u9fff]/, `${state.phase} + ${expert.kind} 的英文闸门里不该有汉字`);
    assert.doesNotMatch(note, /\.[A-Z]/, `${state.phase} + ${expert.kind}：英文句子粘在一起了`);
    // 英文按字符算，同样的信息量约是中文的 2.3 倍（实测 spec+worker：中文 181 字 / 英文 429 字符）。
    // 上限按「读得完」定，不按字符对齐——对着字符数把英文裁成电报，等于没写。
    assert.ok(note.length <= 460, `${state.phase} + ${expert.kind} 的英文闸门太长：${note.length}`);
  }
  assert.equal(PHASE_LABEL_EN.build, "build");
}

// 场景八：端到端——英文会话拿英文注入，中文紧跟着拿回中文
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-e2e-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = HOME;
  const plugin = await import(`../lib/index.js?i18n=${Date.now()}`);
  const handlers = new Map();
  let tool;
  plugin.apply(
    {
      logger: { warn() {}, info() {} },
      effect(f) {
        f();
      },
      on(e, h) {
        handlers.set(e, h);
        return () => {};
      },
      systemPrompt: { section() {} },
      skills: { register: () => () => {} },
      tools: {
        register(t) {
          tool = t;
        },
      },
    },
    {},
  );
  const step = handlers.get("agent/pre-step");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-proj-"));
  fs.writeFileSync(path.join(project, "REQUIREMENTS.md"), "# r\n");
  fs.writeFileSync(path.join(project, "TASKS.md"), "# t\n");
  const agentId = "sess-i18n";
  const say = async (text, id) => {
    const messages = [{ role: "user", id, content: [{ type: "text", text }], source: { kind: "user" } }];
    const result = await step({ agent: { id: agentId }, messages }, async () => ({ kind: "continue", messages }));
    return result.messages.slice(1).filter((m) => m.source?.kind?.startsWith("capability-router"));
  };

  const first = await say("build me a small tool that renames photos by date", "i-1");
  const hint = first.find((m) => m.source.kind === "capability-router-hint");
  assert.match(hint.content[0].text, /\[capability-router · this turn\]/, "英文会话要拿英文检查点");
  assert.doesNotMatch(hint.content[0].text, /【能力路由/, "英文会话不该拿中文检查点");

  const opened = await tool.execute({ name: "intake", project, level: "pro" }, { agent: { id: agentId } });
  assert.match(opened.role, /## Language/, "英文会话的 role 末尾要有语言段");
  assert.match(opened.role, /这次的读者是老手/, "语言段是追加，不是替换：中文的读者段还得在");

  const punct = await say("???", "i-2");
  const afterPunct = punct.find((m) => m.source.kind === "capability-router-hint");
  // `???` 是疑问形态，项目模式下走提问那一条；要验的是语言，不是走哪条。
  assert.match(afterPunct.content[0].text, /^\[capability-router/, "判不出语言时要沿用上一次，不能切回中文");
  assert.doesNotMatch(afterPunct.content[0].text, /【能力路由/, "判不出语言时不许擅自切回中文");

  await say("帮我加一个导出按钮", "i-3");
  const relang = await tool.execute({ name: "backend", project }, { agent: { id: agentId } });
  assert.doesNotMatch(relang.role, /## Language/, "换成中文说之后，语言段要消失");

  process.env.DSH_HOME = previous;
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
}


// 场景九：英文句子也要落到对的人头上——词表是中文的，英文句以前全落空
{
  const { scanExperts } = await import("../lib/experts.js");
  const { matchExpert } = await import("../lib/router.js");
  const list = Array.from(scanExperts({ dirs: ["experts"] }).experts);
  const cases = [
    ["add a delete button to the list", "frontend"],
    ["the API returns 500 when I upload a file", "backend"],
    ["fix the login bug", "debug"],
    ["export the table to xlsx", "data"],
    ["reverse this apk and find the license check", "reverse"],
    ["write a one-page proposal for the client", "docs"],
  ];
  for (const [sentence, expected] of cases) {
    const v = matchExpert(sentence, list);
    assert.equal(v.kind, "hit", `英文句要能落到人头上：${sentence}`);
    assert.equal(v.expert.id, expected, `英文句判错人：${sentence}`);
  }
  // `so` 曾用两字母同义词指 .so 库，结果 slow / also 全命中逆向——英文里这种词必须带上下文
  assert.equal(matchExpert("she also said it works", list).kind, "miss", "闲聊不该判给逆向");
}


// 场景十：expert() 的 note 也要跟语言走——闸门翻了、提醒没翻，等于半句话
{
  const fsx = await import("node:fs");
  const home = fsx.mkdtempSync(path.join(os.tmpdir(), "i18n-note-"));
  process.env.DSH_HOME = home;
  const proj = path.join(home, "proj");
  fsx.mkdirSync(proj, { recursive: true });
  const plugin = await import("../lib/index.js");
  const handlers = new Map();
  let tool;
  plugin.apply(
    {
      logger: { warn() {}, info() {} },
      effect(apply) { apply(); },
      on(name, handler) { handlers.set(name, handler); return () => {}; },
      systemPrompt: { section() {} },
      skills: { register: () => () => {} },
      tools: { register(definition) { tool = definition; } },
    },
    {},
  );
  const pre = handlers.get("agent/pre-step");
  const say = async (id, text) => {
    const messages = [{ role: "user", id: `n${Math.random().toString(16).slice(2, 8)}`, content: [{ type: "text", text }], source: { kind: "user" } }];
    await pre({ agent: { id }, messages }, async () => ({ kind: "continue", messages }));
  };

  await say("sess-en", "build me a small tool");
  const enExec = { agent: { id: "sess-en" } };
  const moved = await tool.execute({ name: "intake", project: proj, phase: "build" }, enExec);
  assert.doesNotMatch(moved.note, /[一-鿿]/, "英文会话的推进提醒不该出现汉字");
  assert.match(moved.note, /Stage note/, "英文会话要给自己看得懂的提醒");

  const badLevel = await tool.execute({ name: "intake", project: proj, level: "x" }, enExec);
  assert.doesNotMatch(badLevel.note, /[一-鿿]/, "英文会话的水平报错不该出现汉字");
  assert.match(badLevel.note, /Level not recorded/);

  const badReopen = await tool.execute({ name: "intake", project: proj, reopen: true }, enExec);
  assert.doesNotMatch(badReopen.note, /[一-鿿]/, "英文会话的重开报错不该出现汉字");
  assert.match(badReopen.note, /reopen only works/);

  // 对照：中文会话一个字都不该变成英文
  await say("sess-zh", "帮我做个小工具");
  const zhNote = await tool.execute({ name: "intake", project: path.join(home, "p2"), phase: "build" }, { agent: { id: "sess-zh" } });
  assert.match(zhNote.note, /阶段提醒/, "中文会话不该冒出英文");
}


// 场景十一：英文问句不一定有问号
{
  const { looksLikeQuestion } = await import("../lib/gap.js");
  const asks = [
    "why does the export fail",
    "how do I add a button",
    "what is the difference between these two",
    "is it supposed to look like this",
  ];
  for (const sentence of asks) {
    assert.equal(looksLikeQuestion(sentence), true, `英文问句要认得住（一个问号都没有）：${sentence}`);
  }
  const works = [
    "add a delete button to the list",
    "can you add a button",
    "fix the login bug please",
    "show me the file", // `show` 里有个 `how`，靠子串匹配会误判
  ];
  for (const sentence of works) {
    assert.equal(looksLikeQuestion(sentence), false, `这不是提问，是要东西：${sentence}`);
  }
  // 中文那边一个字都不许变
  assert.equal(looksLikeQuestion("这个按钮点下去为什么没反应？"), true);
  assert.equal(looksLikeQuestion("能不能把这个按钮改大一点"), false, "委婉请求是活，不是提问");
}

console.log("i18n: 11 场景 ok");
