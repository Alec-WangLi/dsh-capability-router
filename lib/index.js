import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogText, expertTool } from "./catalog.js";
import { expertDirs, renderExpertList, scanExperts } from "./experts.js";
import { explicitExpert, gapText, looksLikeQuestion, looksLikeTask, secondaryText } from "./gap.js";
import { PHASE_LABEL_EN, detectLang, t } from "./i18n.js";
import { matchExpert } from "./router.js";
import {
  advancePhase,
  gateNote,
  newState,
  openExpert,
  PHASE_LABEL,
  projectStateFile,
  readState,
  setApproved,
  setLevel,
  stateCardText,
  stateFile,
  writeState,
} from "./state.js";
import { attachWebPanel } from "./web.js";

/** 插件标识，必须与 package.json 的 name 一致。 */
export const name = "dsh-capability-router";

/**
 * 依赖的宿主服务。
 * systemPrompt 用来注入「能力路由」的长期原则与专家目录；skills 用来注册自检技能；
 * tools 用来注册 expert(name)——按需取某位专家的完整工作方式。
 */
export const inject = ["systemPrompt", "skills", "tools"];

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const STATE_DIR = path.join(DSH_HOME, "capability-router");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const RUNS_FILE = path.join(STATE_DIR, "runs.jsonl");

/** 本插件注入消息的 source.kind，用来做去重与辨识。 */
const HINT_KIND = "capability-router-hint";
/** 专家角色提示词注入的 source.kind。 */
const ROLE_KIND = "capability-router-role";
/** 缺口提示（分不清 / 没人接）注入的 source.kind。 */
const GAP_KIND = "capability-router-gap";
/** 项目模式的状态卡注入的 source.kind。 */
const STATE_KIND = "capability-router-state";
/** 主次提示（一句话里有两个领域）注入的 source.kind。 */
const SECONDARY_KIND = "capability-router-secondary";
/** 接单提醒（命中接单专家时说明「接单之后还要分派」）注入的 source.kind。 */
const INTAKE_KIND = "capability-router-intake";

const DEFAULTS = {
  /** 总开关。关掉后不注入任何东西，行为与未安装完全一致。 */
  enabled: true,
  /** 是否注入系统提示里的长期原则段。 */
  intake: true,
  /** 是否在每条用户消息后追加一次当轮检查点。 */
  hint: true,
  /** 是否扫描专家包。关掉后自检技能不再列专家，匹配器也不会启用。 */
  experts: true,
  /** 是否把专家目录写进系统提示（稳定前缀，可被 prefix cache 命中）。 */
  catalog: true,
  /** 是否注册 expert(name) 工具，按需取 role.md 全文。 */
  expertTool: true,
  /**
   * 项目模式：打开接单专家后写会话状态，之后每步注入一行状态卡，
   * 并把当轮检查点降级（两条协议同时喊话会撕注意力，见 ARCHITECTURE 第三节）。
   */
  project: true,
  /** 把每次 pre-step 的结论记进 runs.jsonl（会话、阶段、命中、注入类型）。 */
  runs: true,
  /**
   * 把只读面板挂到宿主 Web 服务上（`/capability-router/panel` 与 `/api/state`）。
   * 同源、同端口：远程访问时地址天然正确，client 半边 iframe 直接吃。
   */
  web: true,
  /** 命中专家后注入它的 role.md。 */
  role: true,
  /** 匹配落空（分不清 / 没人接）时提示一句；闲聊不触发。 */
  gap: true,
  /** 把落空的句子记到 gaps.jsonl，用来决定先造哪个专家。 */
  gapLog: true,
  /** 提示词段的排序位；dsh-purge 的尾段在 5100，这里排在它前面。 */
  order: 5000,
  /** 打开后在 <STATE_DIR>/trace.jsonl 记每次 pre-step 的现场，排查挂钩用。 */
  debug: false,
};

/**
 * 常驻在系统提示里的长期原则。
 * 它离用户那句话很远，作用只是「背景设定」；真正起作用的是 HINT_TEXT。
 */
const INTAKE_TEXT = `## 能力路由

两件事：需求有空白先问清楚，能力对不上先说出来。

**问清楚**：遇到会改变实现方向的空白，一次只问一个问题，附上你的推荐答案。需求已经明确就直接做，不为走流程反复确认。

**说清楚**：技能目录只是摘要，要按某个技能的指令做事，先用 skill 工具把它加载出来。手上没有对应能力就直说「我手上没有对应能力」，并指出缺什么——不要拿相近的技能硬凑，也不要假装做过。`;

/**
 * 每条用户消息后面紧跟的一次性检查点。
 * 这段话的作用不是「告诉模型一条规则」，而是在它即将开口的那一刻，
 * 把「这句话是提问还是命令」摆到眼前。
 *
 * 2026-11-02 真实用例复盘：原版只有三分法，其中「命令」那一行写的是
 * 「有一个会改变实现方向的黑洞就问……没有就开工」——它直接授权了单人作业。
 * 实测模型原话照做（「能力路由说：问一个黑洞，附推荐答案」），然后一个人从零做到尾，
 * 全程没调过一次 expert()，交付没有审查。所以这里必须多两个出口：接单、收口。
 */
const HINT_TEXT = `【能力路由 · 当轮检查】

先归类用户这句话，再决定动作：

- **提问**（要答案）：直接答。不要顺手改代码，不要先跑一堆命令验证。
- **命令 · 新活**（新项目 / 新功能 / 新交付物，不是在修一个既有毛病）：先 \`expert("intake")\` 把需求收敛成 \`REQUIREMENTS.md\` + \`TASKS.md\`，再按任务卡分派给领域专家。**别自己一个人从头做到尾。** 接单第一问：用户想听细节还是直接上？问完用 \`expert("intake",{level:"novice"|"pro"})\` 记下。
- **命令 · 修**（既有东西坏了 / 要改一处）：\`expert("debug")\` 或对应领域的专家，先定位再动手。
- **报告**（是继续）：接着做，别重新评估已经定下的事。
- **收口**（这轮要交付，要说「做完了 / 可以用了」）：先 \`expert("review")\` 按验收标准逐条核对。**没真正跑起来的东西别写「完成」**——用户拿去用不了，比晚交半小时贵得多。
- **拿不准归哪类**：问用户一句，给 2~3 个具体选项（点一下就行），一次问完。别连环问。

开工前扫一眼技能目录：对口就加载完整指令再动手；不对口就说「我手上没有对应能力」并说缺什么。`;

/**
 * `HINT_TEXT` 的英文版。逐条对应，不逐句直译——中文里「别自己一个人从头做到尾」
 * 直译成 `do not do it from head to tail alone` 没人看得懂。
 */
const HINT_TEXT_EN = `[capability-router · this turn]

Classify what the user just said before deciding what to do:

- **Question** (wants an answer): answer it. Do not also change code, and do not run a pile of commands to "verify" first.
- **Command · new work** (a new project / feature / deliverable, not a fix to something that exists): run \`expert("intake")\` first to settle it into \`REQUIREMENTS.md\` + \`TASKS.md\`, then dispatch by task card. **Do not do the whole thing yourself end to end.** First question at intake: does the user want the detail, or want to get on with it? Record it with \`expert("intake",{level:"novice"|"pro"})\`.
- **Command · fix** (something existing is broken, or one place to change): \`expert("debug")\` or the specialist for that area — locate it first, then act.
- **Report** (this is a continuation): keep going, do not re-litigate decisions already made.
- **Closing** (this round delivers something and you are about to say "done / ready to use"): \`expert("review")\` first and check line by line against the acceptance criteria. **Do not write "done" for something you have not actually run** — the user finding it broken costs far more than half an hour late.
- **Not sure which**: ask the user once, with two or three concrete options (one tap each), all in one go. Do not chain questions.

Before starting, glance at the skill catalog: if something fits, load its full instructions first; if nothing fits, say "I do not have that capability" and name what is missing.`;

/** `ASK_TEXT` 的英文版。 */
const ASK_TEXT_EN = `[capability-router · this is a question]

The user wants an answer, not a change. Answer the thing they asked; do not also edit code, and do not run a pile of commands before answering.
If answering turns up a real gap in the requirement, say so — do not quietly fill it in yourself.`;

/** 读配置；文件缺失或损坏时回落到默认值。 */
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* 首次运行没有配置文件属正常情况 */
  }
  return {};
}

/** 合并写回配置，返回合并后的完整对象。 */
export function saveConfig(patch) {
  const next = { ...DEFAULTS, ...readConfig(), ...patch };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * 找出最后一条「真人说的话」。
 * 系统注入的 agent-instructions / runtime-context / skill-catalog / time-context
 * 也是 user 角色，靠 source.kind 区分。
 */
function lastUserPrompt(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.source?.kind === "user") return message;
  }
  return undefined;
}

/**
 * 只对「人说的那一句」判专家。
 *
 * 子代理的第一条 user 消息不是人写的，是父代理写的任务书（常常上千字，还带着
 * 编号步骤和引号）。把它当原话判，会命中一堆词然后给出完全不相干的提示——
 * 2026-11-02 实测：一句「帮我做个员工报销审批的小工具」在子代理里被判成
 * `hit docs（副：review）`，因为被判的其实是任务书全文。
 *
 * 所以加一道长度闸：一句话的需求到不了 400 字；超过就只注入检查点，不做点名。
 * 粘一长段文档进来时同样不点名——长文的词面密度必然高，判谁都是运气。
 */
const MAX_ROUTE_CHARS = 400;

/** 这一条用户消息是否已经注入过检查点。 */
function hasHintFor(messages, promptId) {
  return messages.some(
    (message) =>
      message?.source?.kind === HINT_KIND && message.source.forPrompt === promptId,
  );
}

/**
 * 已注入过检查点的用户消息 id。
 * 只靠 messages 去重不够稳：注入的消息不一定出现在下一步的 messages 里，
 * 那种情况下每跑一步都会再追加一条，一轮能堆出几十条。
 * 消息 id 是 UUID，跨会话不会撞，所以这里直接按 id 记账，不需要按 agent 分桶。
 */
const hintedPrompts = new Set();
const HINT_LEDGER_LIMIT = 500;

function markHinted(promptId) {
  hintedPrompts.add(promptId);
  if (hintedPrompts.size > HINT_LEDGER_LIMIT) {
    const keep = [...hintedPrompts].slice(-Math.floor(HINT_LEDGER_LIMIT / 2));
    hintedPrompts.clear();
    for (const id of keep) hintedPrompts.add(id);
  }
}

/** 已经注入过角色提示词的用户消息 id。 */
const rolePrompts = new Set();

function markRole(promptId) {
  rolePrompts.add(promptId);
  if (rolePrompts.size > HINT_LEDGER_LIMIT) {
    const keep = [...rolePrompts].slice(-Math.floor(HINT_LEDGER_LIMIT / 2));
    rolePrompts.clear();
    for (const id of keep) rolePrompts.add(id);
  }
}

/**
 * 每个 agent 最后一次见到的那句「人话」。
 *
 * 宿主的 `decision.messages` 在长任务里常常只带增量——一个任务书跑 139 步，后面的步里
 * 未必还带着那条 `source.kind === "user"` 的消息，`lastUserPrompt()` 就返回 undefined，
 * 而它在 `if (prompt === undefined) return decision;` 处直接返回，**后面什么都不会做**。
 *
 * 2026-11-02 实测代价：子代理跑 23 分钟 139 步，`runs.jsonl` 只写了 1 行、状态卡一次没进、
 * 路由信号只在头几步出现过。整场像是「插件说了一句话就下班了」。
 * 所以记住上一次的人话，找不到就复用——它仍然是那一轮的 promptId，去重逻辑不受影响。
 */
const lastPromptByAgent = new Map();

/**
 * 每个 agent 上一次判出来的语言。
 *
 * `detectLang` 对一串标点、一个数字、一张表情返回 `undefined`——那不该把会话
 * 从中文切回英文。所以这里记住上一次的真判定，判不出来就沿用。
 */
const langByAgent = new Map();

/**
 * 状态卡的重新注入节奏。
 *
 * 状态卡的设计意图是「一步一行」，但一个任务跑上百步时，每步都贴一遍是在烧上下文。
 * 折中：同一条人话内，**阶段变了立刻再说一次**（这是真信息），否则每 10 步补一次
 * （防止模型在长任务里忘了自己在哪个阶段）。
 */
const STATE_EVERY = 10;

/** 备忘表（步数 / 状态卡标记 / 上次人话）的条目上限，超过就整表清空。 */
const MEMO_LIMIT = 500;

/** agentId → 该 agent 已经跑了多少步。 */
const stepCounts = new Map();

/** agentId → 上一次注入状态卡时的 {promptId, phase, step}。 */
const stateMarks = new Map();
/** `stateMarks` 的条目上限（FIFO 淘汰，见 shouldInjectState）。 */
const STATE_MARK_LIMIT = 256;

/**
 * 这一轮这一步要不要再说一次状态卡。
 * @returns {boolean}
 */
function shouldInjectState(agentId, promptId, phase, step) {
  const mark = stateMarks.get(agentId);
  if (
    mark === undefined ||
    mark.promptId !== promptId ||
    mark.phase !== phase ||
    // 用绝对差：计数表被清过之后 step 会从头数，直接相减会得到负数而永远不再补。
    Math.abs(step - mark.step) >= STATE_EVERY
  ) {
    stateMarks.set(agentId, { promptId, phase, step });
    // 键是 agentId，随会话数增长（一天十个会话、一年三千六），不是随消息数。
    // 裁掉一条的代价只是那个会话下一步再贴一次状态卡——一句话，无害；
    // 不裁的代价是这份 Map 只涨不落。留着上限比留着「反正涨得慢」的假设省心。
    if (stateMarks.size > STATE_MARK_LIMIT) stateMarks.delete(stateMarks.keys().next().value);
    return true;
  }
  return false;
}

/** 构造一条缺口提示消息。 */
function gapMessage(text, promptId) {
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text }],
    source: { kind: GAP_KIND, form: "notice", forPrompt: promptId },
  });
}

/** 已经注入过缺口提示的用户消息 id。 */
const gapPrompts = new Set();

function markGap(promptId) {
  gapPrompts.add(promptId);
  if (gapPrompts.size > HINT_LEDGER_LIMIT) {
    const keep = [...gapPrompts].slice(-Math.floor(HINT_LEDGER_LIMIT / 2));
    gapPrompts.clear();
    for (const id of keep) gapPrompts.add(id);
  }
}

/**
 * 已经记过账的用户消息 id。与 gapPrompts 分开、互不相干，别合并：
 *   - 记账（gapLogged）：一句一次，不管这句最后说没说出口——账本是数据，不该被提示策略影响；
 *   - 注入（gapPrompts）：一句一次，但被状态卡压住的那轮不标记，下一步补说。
 * 共用一个标记时，两种语义会互相污染：要么同一句按步数刷行（账被稀释），
 * 要么「压住那轮不吞提示」的收益一起消失。
 */
const gapLogged = new Set();

/**
 * 记账去重不做裁剪，与 markGap 的两处差别是有意的。
 *
 * 提示类集合裁掉老 id 的代价是「同一句再提示一次」，无害；记账类集合裁掉老 id
 * 的代价是「同一句再记一行账」，账本被同一句话稀释，而且是长期累积、事后看不出来的。
 * 一个 prompt id 是 UUID（36 字节），几千条也就几十 KB——省这个内存不值当。
 */
function markGapLogged(promptId) {
  gapLogged.add(promptId);
}

/**
 * 已经注入过补充提示（主次 / 接单）的用户消息 id。
 * 这两类提示比检查点更窄：只在「这句话同时压到两个领域」和「刚打开接单专家」时出现，
 * 一旦出现就必须只出现一次，否则每跑一步都追加一条，一轮能堆出几十条。
 */
const notePrompts = new Set();

function markNote(promptId) {
  notePrompts.add(promptId);
  if (notePrompts.size > HINT_LEDGER_LIMIT) {
    const keep = [...notePrompts].slice(-Math.floor(HINT_LEDGER_LIMIT / 2));
    notePrompts.clear();
    for (const id of keep) notePrompts.add(id);
  }
}

/** 构造一条补充提示消息（主次 / 接单共用）。 */
function noteMessage(text, promptId, kind) {
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text }],
    source: { kind, form: "notice", forPrompt: promptId },
  });
}

/**
 * 打开接单专家时紧跟一句：接单不是终点。
 * 2026-11-02 真实用例里模型一次都没打开过接单专家，所以这条没被验证过；
 * 但它防的是另一个已知失败模式——接完单自己全做了，团队仍然只有一个人。
 */
const INTAKE_NUDGE_START = `【能力路由 · 这句话还没接单】

先别开工。\`expert("intake")\` 把这句话收敛成 \`REQUIREMENTS.md\` + \`TASKS.md\`：需求有空白就先问清楚，一次一个问题，附上你的推荐答案；没有空白就直接写，别为走流程反复确认。

接完单再按任务卡分派给各领域专家——接单不是终点，一个人从零做到尾仍然是一个人的活。`;

const INTAKE_NUDGE = `【能力路由 · 接单之后还要分派】

接单不是终点。\`REQUIREMENTS.md\` + \`TASKS.md\` 只是把活说清楚，活还得有人干：
按任务卡逐条 \`expert("backend" / "frontend" / "data" / "docs" …)\`，让每个领域由它自己的专家来做。
**不要接完单自己一个人全做了**——那样接单只多写了两份文档，团队还是一个人。

分派完、交付前，再 \`expert("review")\` 按验收标准逐条核对，核对过了才说「可以用了」。`;

/**
 * 项目模式下唯一保留的检查点变体：用户这句话不是活，是要答案。
 *
 * 状态卡讲「这个阶段该干什么」，不讲「用户这句话是提问还是命令」。实测同一阶段下
 * 「这个按钮为什么没反应」「帮我加个按钮」「你觉得还有什么风险」三种句子拿到的注入
 * 一字不差——模型看到「按任务卡推进」，就会把提问也当成开工信号。
 * 不整个恢复三分法：任务句仍然只有状态卡，撕注意力的问题只出现在本来就该干活的那一半。
 */
const ASK_TEXT = `【能力路由 · 这句是提问】

用户要的是答案，不是改动。直接回答它问的那件事；别顺手改代码，也别先跑一堆命令再答。
答完如果发现需求本身有缺口，说出来，别自己补上。`;

/** 构造一条检查点消息，形状与宿主 createUserMessage 的产物一致。 */
function hintMessage(promptId, text = HINT_TEXT) {
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text }],
    source: { kind: HINT_KIND, form: "notice", forPrompt: promptId },
  });
}

/** 项目模式的状态卡。 */
function stateMessage(promptId, state, lang = "zh") {
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text: stateCardText(state, lang) }],
    source: { kind: STATE_KIND, form: "notice", forPrompt: promptId, phase: state.phase },
  });
}

/** 从用户消息里取出纯文本。 */
function promptText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** 构造一条专家角色消息。角色是背景，不是命令，所以只用一段普通正文。 */
function roleMessage(expert, promptId) {
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text: `【能力路由 · 当前专家：${expert.name}】\n\n${expert.role.trim()}` }],
    source: { kind: ROLE_KIND, form: "notice", forPrompt: promptId, expert: expert.id },
  });
}

/**
 * 把每次注入记到 hints.jsonl。
 * pre-step 注入的消息不进会话历史，光看会话文件证明不了它跑过，所以留一份落地记录；文件超过 64 KB 时只保留最近一半。
 */
function recordHint(promptId) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, "hints.jsonl");
    fs.appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), promptId })}\n`,
      "utf8",
    );
    if (fs.statSync(file).size > 64 * 1024) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`, "utf8");
    }
  } catch {
    /* 记账失败不影响注入 */
  }
}

/** 追加一行到状态目录下的 jsonl，超过 64 KB 时只保留最近一半。 */
function appendLedger(file, line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(file, `${line}\n`, "utf8");
    if (fs.statSync(file).size > 64 * 1024) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`, "utf8");
    }
  } catch {
    /* 记账失败不影响注入 */
  }
}

/**
 * 记一次 pre-step 的结论：会话、阶段、命中、注入了什么。
 * 只记判断不记原话——原话在 gaps.jsonl 里，两件事分开看。
 */
function recordRun(info) {
  appendLedger(RUNS_FILE, JSON.stringify(info));
}

/**
 * 记一次「没人接」的句子，用来回答「该先造哪个专家」。
 * 只记原话与结论，不记上下文——gaps.jsonl 是要被人拿去看的。
 */

/**
 * 记一条落空。有阶段时带上 phase，旧行（非项目模式）的格式保持不变。
 * @param {object} verdict
 * @param {string} text
 * @param {string} [phase]
 * @param {string} [lang]
 */
function recordGap(verdict, text, phase, lang) {
  const row = {
    at: new Date().toISOString(),
    kind: verdict.kind,
    text: text.slice(0, 200),
    candidates: (verdict.candidates ?? []).map((entry) => entry.expert.id),
  };
  // 没有阶段就不加这个键：读的人不必处理「存在但为 null」的字段。
  if (typeof phase === "string" && phase !== "") row.phase = phase;
  // 非中文才记：中文是基线，旧行没有这个键就按中文读。
  // 缺了这个键就没法回答「英文语料落空率是多少」——而那是补不补英文词表的唯一依据。
  if (typeof lang === "string" && lang !== "" && lang !== "zh") row.lang = lang;
  appendLedger(path.join(STATE_DIR, "gaps.jsonl"), JSON.stringify(row));
}

/** 打开 debug 时记每次 pre-step 的现场，用来判断挂钩有没有跑起来。 */
function recordTrace(info) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, "trace.jsonl");
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...info })}\n`, "utf8");
    if (fs.statSync(file).size > 64 * 1024) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`, "utf8");
    }
  } catch {
    /* 诊断失败不影响注入 */
  }
}

function describeState(config, catalog) {
  const onOff = (value) => (value ? "开" : "关");
  const expertCount = catalog?.experts.length ?? 0;
  return [
    `- 长期原则段：${onOff(config.intake)}`,
    `- 当轮检查点：${onOff(config.hint)}`,
    `- 专家角色注入：${onOff(config.role)}`,
    `- 缺口提示：${onOff(config.gap)}（记账 ${onOff(config.gapLog)} → gaps.jsonl）`,
    `- 专家包：${onOff(config.experts)}（${expertCount} 个：${catalog?.experts.map((expert) => expert.id).join("、") || "无"}）`,
    `- 专家目录（系统提示）：${onOff(config.catalog)}`,
    `- expert(name) 工具：${onOff(config.expertTool)}`,
    `- 项目模式：${onOff(config.project)}（状态卡 + 闸门 + sessions/*.json）`,
    `- 运行记录：${onOff(config.runs)}（runs.jsonl）`,
    `- 面板路由：${onOff(config.web)}（/capability-router/panel）`,
    `- 调试记录：${onOff(config.debug)}（trace.jsonl）`,
    `- 配置文件：\`${CONFIG_FILE}\``,
  ].join("\n");
}

function selfSkillContent(config, catalog) {
  const problems = [...(catalog?.errors ?? []), ...(catalog?.warnings ?? [])];
  const problemBlock =
    problems.length === 0
      ? ""
      : `\n### 专家包告警\n\n${problems.map((line) => `- ${line}`).join("\n")}\n`;
  return `# capability-router

本机自研的能力路由插件。当前状态：

${describeState(config, catalog)}

## 它现在做什么

五处动作，分工不同：

1. **长期原则段**（系统提示）——背景设定，讲「需求有空白先问、能力对不上先说」。位置靠后，容易被大段项目规则淹没。
2. **当轮检查点**（\`agent/pre-step\`）——每条用户消息后面紧跟一段，把「这句话是提问还是命令」摆到模型眼前。这一处才是真正会改变行为的地方。
3. **专家路由**（\`agent/pre-step\`）——拿用户那句原话做规则匹配：命中就注入该专家的 \`role.md\`。分不清或没人接时不硬选。
4. **缺口提示**（\`agent/pre-step\`）——分不清就点出是哪两个专家在抢；一个都没命中且这句话像在派活，就说「没有干这个的人」。判断「像不像一件活」也是规则，闲聊不打扰。
5. **专家目录 + \`expert(name)\` 工具**（系统提示 + 工具）——v0.9 的入口：目录常驻、详情按需。它跟前面四条不是一回事：前四条是插件替模型判断，这一条是把判断权交回去。

外加一个自检技能：你能读到这段文字，说明 \`ctx.skills.register()\` 链路是通的。

专家声明的技能装没装，跑 \`npm run doctor\` 就知道（\`source: host\` 的依赖不查，那是跟着 DSH 一起装的）。

## 已识别的专家

${renderExpertList(catalog?.experts ?? [])}

专家包放在两处，同名 id 以内层（用户目录）为准：

\`\`\`text
<包内>/experts/<id>/        随插件发布，改它要动源码
${STATE_DIR}\\experts\\<id>/   用户自建或覆盖，改这里即时生效
  expert.yml   name / description / triggers / skills / tools
  role.md      命中后注入的角色提示词
  skills/      可选，专家自带的技能
\`\`\`
${problemBlock}
## 它之后要做什么

已经能记账了：每次没人接（或分不清）的原话写进 \`gaps.jsonl\`，\`node tools/gaps.mjs\` 聚合出「哪个领域反复没人接」，据此决定先造哪个专家。之后的方向是把「造专家」也变成一条命令能跑完的闭环——现在已经有一半（\`tools/forge.mjs\` 生成骨架 + 当场校验），缺的是从缺口记录直接起草 \`expert.yml\`。


## 怎么调整

改 \`${CONFIG_FILE}\`，下一次会话生效：

\`\`\`json
{
  "intake": true,
  "hint": true,
  "role": true,
  "experts": true,
  "gap": true,
  "gapLog": true,
  "catalog": true,
  "expertTool": true,
  "project": true,
  "runs": true
}
\`\`\`

- \`intake\`：关掉就不再注入系统提示里的原则段。
- \`hint\`：关掉就不再追加当轮检查点。两者都关等于插件隐身。
- \`role\`：命中专家后注入 \`role.md\`。
- \`gap\`：分不清 / 没人接时提示一句；闲聊不触发。
- \`gapLog\`：把落空的原话记进 \`gaps.jsonl\`，用 \`node tools/gaps.mjs\` 看哪个领域最缺人。
- \`catalog\` / \`expertTool\`：专家目录进系统提示、注册 \`expert(name)\` 工具。两者都关等于回到「插件替模型选人」。
- \`project\`：项目模式下状态卡取代检查点，缺口闭嘴。
- \`runs\`：把每次 pre-step 的判断记进 \`runs.jsonl\`。

## 造一个专家

匹配落空且这活会反复出现时，用工具生成骨架：

\`\`\`bash
node tools/forge.mjs rtsp --name 流媒体工程师 \\
  --description "摄像头接入、推流、回放与存储" \\
  --triggers 摄像头,推流,RTSP,回放,目标检测 --skills pdf
\`\`\`

它会写进 \`<状态目录>/experts/<id>/\`，写完当场用同一个扫描器校验，不通过就不落盘。必填参数缺一个就报错退出——不猜触发词、不编描述，猜出来的措辞会被直接接受，那比生成失败更糟。

落地顺序：改 \`role.md\`（骨架只是占位）→ 人审 → 重启 DSH（专家包在挂载时扫描）。

## 排查

目录里看不到 \`capability-router\` 这个技能，说明插件没挂上。先去 profile 的 \`cordis.patch.yml\` 确认挂载项用的是 \`insert\`——不带 \`insert\` 的 patch 只能改已有条目，新 id 会被静默跳过。
`;
}

function selfSkill(config, catalog) {
  return {
    name: "capability-router",
    description:
      "能力路由插件自身的说明与开关：当前注入状态、已识别的专家包、怎么调整开关。当用户问「你怎么选的技能」「某个技能为什么没出现」「有哪些专家」「怎么让技能按需加载」时加载。",
    content: selfSkillContent(config, catalog),
    source: "capability-router",
    provider: "capability-router",
    invocation: { modelInvocable: true, userInvocable: true },
  };
}

/**
 * 挂载插件。任何一步失败都只记告警，不向上抛——插件挂载异常会拖垮宿主启动。
 */
export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULTS, ...readConfig(), ...config };
  if (!resolved.enabled) return;

  /** 专家包在挂载时扫一次：它是磁盘状态，不随对话变化，每次会话重扫就够。 */
  const catalog = resolved.experts
    ? scanExperts({ dirs: expertDirs(STATE_DIR) })
    : { experts: [], warnings: [], errors: [] };

  if (resolved.debug) {
    recordTrace({
      event: "apply",
      inject: resolved.hint ? "hint" : "no-hint",
      experts: catalog.experts.map((expert) => expert.id),
      expertProblems: catalog.errors.length + catalog.warnings.length,
    });
  }

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`capability-router: ${message}`);
    } catch {
      /* 日志自身失败不影响挂载 */
    }
  };

  if (resolved.intake) {
    try {
      ctx.effect(
        () =>
          ctx.systemPrompt.section({
            name: "capability-intake",
            order: resolved.order,
            interpolate: false,
            text: INTAKE_TEXT,
          }),
        "capability-router: 能力路由原则",
      );
    } catch (error) {
      warn(`原则段注册失败 ${error?.message ?? error}`);
    }
  }

  const catalogSection = resolved.catalog && catalog.experts.length > 0 ? catalogText(catalog.experts) : "";
  if (catalogSection !== "") {
    try {
      ctx.effect(
        () =>
          ctx.systemPrompt.section({
            name: "capability-experts",
            order: resolved.order + 1,
            interpolate: false,
            text: catalogSection,
          }),
        "capability-router: 专家目录",
      );
    } catch (error) {
      warn(`专家目录注册失败 ${error?.message ?? error}`);
    }
  }

  if (resolved.expertTool && catalog.experts.length > 0 && ctx.tools !== undefined) {
    try {
      const definition = expertTool(catalog.experts, {
        onOpen: (expert, exec, args) => {
          if (!resolved.project) return undefined;
          const sessionId = exec?.agent?.id;
          // 语言要在算 note 的第一句就定下来：闸门、重开、提醒、落盘错误全按它选文案。
          const openLang = langByAgent.get(sessionId) ?? "zh";
          // 相对路径以前被**静默丢掉**（只认 isAbsolute），于是状态悄悄落到会话文件里，
          // 模型看到的 found:true 一切正常，项目状态其实一个字节都没写进项目。
          // 现在一律按宿主 cwd 解析成绝对路径，并在 note 里回显落点。
          const rawProject = typeof args?.project === "string" && args.project !== "" ? args.project : undefined;
          const projectIsRelative = rawProject !== undefined && !path.isAbsolute(rawProject);
          const explicitProject = rawProject === undefined ? undefined : path.resolve(rawProject);
          const sessionState = typeof sessionId === "string" && sessionId !== "" ? readState(stateFile(STATE_DIR, sessionId)) : undefined;
          // 项目优先：同一项目的多个会话共用一份阶段（多代理协作时这是常态）。
          const projectDir = explicitProject ?? sessionState?.project;
          // 相对路径一律按宿主 cwd 解析后落盘：状态文件里存相对路径，换个 cwd 就找不到自己了。
          const projectAbs = projectDir === undefined ? undefined : path.resolve(projectDir);
          const file = projectDir === undefined ? (sessionId === undefined ? undefined : stateFile(STATE_DIR, sessionId)) : projectStateFile(projectDir);
          if (file === undefined) return undefined;
          const before = readState(file) ?? newState(sessionId ?? projectDir);

          // 顺序固定：先记在场，再记显式参数（level / approved），再推进阶段，
          // 最后按**推进之后**的状态算闸门——顺序错了会出现「已经开工还说先别开工」。
          let after = openExpert(before, expert);
          let levelError;
          const level = typeof args?.level === "string" ? args.level : undefined;
          if (level !== undefined) {
            const applied = setLevel(after, level, openLang);
            after = applied.state;
            levelError = applied.error;
          }
          // approved 先记显式值：显式传 false 是撤销。
          // 顺序仍然重要——撤销必须在后面那些推断**之前**落定，否则「传了 false 但同时推进了阶段」
          // 会被推断出来的提醒说成「你还没确认」（状态是对的，只是提醒的语气读起来像在劝反悔）。
          const explicitApproved = typeof args?.approved === "boolean" ? args.approved : undefined;
          if (explicitApproved !== undefined) {
            after = setApproved(after, explicitApproved).state;
          }

          // 显式推进：模型交卷时说一声（expert("intake", { phase: "build" })）。
          // 不这么做的话 spec 之后没有出口——没有谁能在文件系统层面替它判「需求确认完了」。
          // 重开：交付之后想回头改，需要一次显式的动作。
          // 不放开 advancePhase 的后退——阶段是闸门的主语，能随手拨回就等于没有闸门；
          // 但「只能另建项目目录」也确实别扭。折中是留一个必须说出口、且会留痕的入口。
          let reopenNote;
          if (args?.reopen === true) {
            if (after.phase === "deliver") {
              after = { ...after, phase: "build", reopenedAt: new Date().toISOString() };
              reopenNote = t(
                openLang,
                "已重开：项目从「交付」退回「实现」（状态里记了 reopenedAt）。改完要走一遍审查再交付——这次的改动不在上一轮的验收范围里。",
                "Reopened: the project is back in build (reopenedAt recorded). Run it past the reviewer before calling it delivered again — these changes are not covered by the last acceptance.",
              );
            } else {
              reopenNote = t(
                openLang,
                `⚠️ reopen 只对已交付的项目有效：当前在「${PHASE_LABEL[after.phase] ?? after.phase}」阶段，没有重开。`,
                `⚠️ reopen only works on a delivered project: it is currently in ${PHASE_LABEL_EN[after.phase] ?? after.phase}, nothing was reopened.`,
              );
            }
          }
          let phaseError;
          const target = typeof args?.phase === "string" ? args.phase : undefined;
          if (target !== undefined) {
            const moved = advancePhase(after, target, openLang);
            after = moved.state;
            phaseError = moved.error;
          }
          // 不再「推进到 build 即视为用户拍板」。
          // 原来那条把**模型的判断**和**用户的动作**混成了同一个信号：模型只要挪一下阶段，
          // 状态卡上「方案：待确认」就消失了，而用户可能一句话都没说过；review 拿到的状态里
          // 写着已确认，于是按「已确认的需求」去审，谁也不会觉得自己漏了什么。
          // 现在 approved 只认显式 {approved:true}。漏记的代价是状态卡一直显示「待确认」——
          // 看得见、能纠正；假装确认的代价是看不见的。
          //
          // 判据是「阶段真的变了」，不是「传了 phase」：openExpert 自己就会在 build 上叫审查专家时
          // 推进到 review，而那正是最常走的一步——按 `target !== undefined` 判，这条路会全程静默。
          const forgotApproval =
            after.phase !== before.phase &&
            ["build", "review", "deliver"].includes(after.phase) &&
            after.approved !== true;
          // 写盘条件含 level / approved：只改了「用户水平」时前两项都没变，漏掉就等于没记。
          const dirty =
            after.phase !== before.phase ||
            after.experts.length !== before.experts.length ||
            after.level !== before.level ||
            after.approved !== before.approved;
          // 写不进去要说话：`project` 指到文件上、或目录没权限时，状态每轮都丢，
          // 而模型看到的 found:true 一切正常——这种静默比不记更贵。
          let writeError;
          if (dirty) {
            // 项目文件的 sessionId 没有意义（它是会话字段），写一个固定标签，免得看起来像「只有某个会话拥有这个项目」。
            writeError = writeState(file, projectAbs === undefined ? after : { ...after, project: projectAbs, sessionId: "project" }).error;
          }
          // 会话文件永远留一份指针（+ 阶段镜像），pre-step 才能知道这个会话属于哪个项目。
          if (typeof sessionId === "string" && sessionId !== "") {
            writeError ??= writeState(stateFile(STATE_DIR, sessionId), {
              ...(sessionState ?? newState(sessionId)),
              phase: after.phase,
              approved: after.approved,
              ...after.level === undefined ? {} : { level: after.level },
              experts: after.experts,
              ...projectAbs === undefined ? {} : { project: projectAbs },
            }).error;
          }
          // 闸门要按「推进之后」的状态判：需求确认完、阶段已进 build 时再说「先别开工」就是自相矛盾。
          // 提醒与闸门同时成立时**拼接而不是互相覆盖**：闸门讲「这个阶段该干什么」，
          // 提醒讲「刚推进的这一步少了什么」，两件事。用 ?? 短路会正好吞掉
          // 「叫了审查专家、阶段隐式进了 review、而方案还没确认」这种最该被说到的情况。
          // deliver 那一版单独一句话：它已经不是「回去确认」了（活都干完了），
          // 而是「这一版交付时缺了一次确认，补记一次，别让下一版也这样」。
          // 和 deliver + intake 的「已经交付了，不用重新接单」并排时不打架：一条说往后，一条说这次。
          const approvalNote = forgotApproval
            ? after.phase === "deliver"
              ? t(
                  openLang,
                  "阶段提醒：这一版是在方案还没记为确认的情况下交付的。补记一次（`expert(\"intake\", { approved: true })`），别让下一次交付也这样。",
                  "Stage note: this delivery happened while the plan was still not marked as confirmed. Record it once (`expert(\"intake\", { approved: true })`) so the next delivery does not inherit the same gap.",
                )
              : t(
                openLang,
                `阶段提醒：阶段已推进到${PHASE_LABEL[after.phase] ?? after.phase}，但方案还没记为确认。用户说过「直接做」或明确点头，就调一次 \`expert("intake", { approved: true })\` 记下；还没敲定就先回去确认——推阶段不等于用户拍板。`,
                `Stage note: the phase moved to ${PHASE_LABEL_EN[after.phase] ?? after.phase}, but the plan is still not marked as confirmed. If the user said "just do it" or clearly agreed, call \`expert("intake", { approved: true })\` to record it; if it is not settled yet, go back and settle it — moving the phase is not the same as the user signing off.`,
              )
            : undefined;
          // 用户水平以前只在接单专家的 role.md 里生效（L3），其余九位拿到的是一份静态角色提示词，
          // 新手问细节、老手要命令，它们一概不知。折中：每次打开专家时在 note 里带一句。
          // 不去改 role.md 是刻意的——按 level 改写角色提示词会破前缀缓存，省下的那点上下文
          // 要用「每个 level 一套缓存键」来换。
          // 推进到 build 的那一刻要核对产物：状态说「按任务卡推进」，而项目目录里可能一份都没有。
          // 状态是插件记的，文档是模型自己写的，两边谁都不管谁——这是唯一能对账的地方，
          // 因为只有这里同时握着项目路径和新旧阶段。只在「阶段真的变了」时说，免得每步都提。
          let docsNote;
          if (after.phase === "build" && after.phase !== before.phase && projectAbs !== undefined) {
            const missing = ["REQUIREMENTS.md", "TASKS.md"].filter((name) => {
              try {
                return !fs.existsSync(path.join(projectAbs, name));
              } catch {
                return false;
              }
            });
            if (missing.length > 0) {
              docsNote = t(
                openLang,
                `⚠️ 项目目录里没有 ${missing.join(" / ")}：状态已经进「实现」，但没有任务卡可推。接单的产物就是这两份，先补上再往下走——如果你们用了别的文件名，忽略这句。`,
                `⚠️ ${missing.join(" / ")} is not in the project directory: the state says build, but there are no task cards to work. Those two files are what intake produces — write them before going further. If you use different filenames, ignore this.`,
              );
            }
          }
          // 用户水平（L3）：以前只在 note 里丢一句话，九位专家的角色提示词一概不知。
          // 现在两处都写——note 里一句指路（当轮就看见），role 末尾一整段（换了专家也带着）。
          // 追加而不是替换：role.md 的静态部分不动，缓存前缀仍然是同一份文本。
          const levelHint =
            after.level === "novice" || after.level === "pro"
              ? t(
                  openLang,
                  `用户水平：${after.level === "novice" ? "新手" : "老手"}——具体怎么调整表达，写在 role 末尾「这次的读者」那一段里。`,
                  `User level: ${after.level === "novice" ? "novice" : "experienced"} — how to adjust is spelled out in the "the reader this time" section at the end of the role.`,
                )
              : undefined;
          const levelAddendum =
            after.level === "novice"
              ? `## 这次的读者是新手

- 先说这个做法解决什么问题，再给命令；术语第一次出现时用一句白话解释。
- 不要默认它知道技术栈、目录结构、工具名——它可能只知道「我想要个东西」。
- 每做完一步说一句「现在能看到什么」，让它自己能确认。
- 它说「不对」的时候先问一句哪里不对，别直接换方案。`
              : after.level === "pro"
                ? `## 这次的读者是老手

- 直接给结论、命令、diff；不要铺垫背景，不要「首先我们需要」。
- 基础概念不解释；它问什么答什么。
- 有几个方案时给一句话取舍，别展开三页对比。
- 它说「不对」就按技术判断处理，别重复确认。`
                : undefined;
          // 语言：role.md 一律中文（模型读中文提示词照样能用英文干活），真正要说的是
          // 「这一次给人看的部分用哪种语言」。所以不维护十份英文 role，只追加一段。
          const langAddendum =
            openLang === "en"
              ? `## Language\n\nThe user writes in English. Everything they will read — explanations, the questions you ask them, notes you produce — goes in English. Code identifiers, commands and file contents stay exactly as they are.`
              : undefined;
          const addendum =
            [levelAddendum, langAddendum].filter((part) => part !== undefined).join(`\n\n---\n\n`) || undefined;

          const parts = [];
          if (phaseError !== undefined) parts.push(t(openLang, `⚠️ 阶段没有推进：${phaseError}`, `⚠️ Stage did not move: ${phaseError}`));
          else if (levelError !== undefined) parts.push(t(openLang, `⚠️ 用户水平没有记录：${levelError}`, `⚠️ Level not recorded: ${levelError}`));
          else {
            // 闸门跟着用户的语言走：会话是英文的，闸门用中文说等于没说。
            const lang = openLang;
            const gate = gateNote(after, expert, lang);
            if (gate !== undefined) parts.push(gate);
            if (reopenNote !== undefined) parts.push(reopenNote);
            if (approvalNote !== undefined) parts.push(approvalNote);
            if (docsNote !== undefined) parts.push(docsNote);
          }
          if (levelHint !== undefined) parts.push(levelHint);
          if (projectIsRelative) {
            parts.push(`项目状态按 ${projectAbs} 记下了。project 收到的是相对路径——宿主的 cwd 不一定是你以为的那个目录，拿不准就传绝对路径。`);
          }
          // 写盘失败放在最后：它讲的是「前面那些话都没记下来」，比任何一条提醒都严重。
          if (writeError !== undefined) {
            parts.push(`⚠️ 状态没能落盘（${writeError.code ?? writeError.message}）：${file}。这一轮的推进只在本轮有效，下一轮会退回旧状态——project 要指到真实存在的目录上，不能是文件。`);
          }
          if (addendum === undefined) return parts.length === 0 ? undefined : { note: parts.join(String.fromCharCode(10)) };
          return {
            ...parts.length === 0 ? {} : { note: parts.join(String.fromCharCode(10)) },
            addendum,
          };
        },
      });
      ctx.effect(() => ctx.tools.register(definition), "capability-router: expert 工具");
    } catch (error) {
      warn(`expert 工具注册失败 ${error?.message ?? error}`);
    }
  }

  // 面板路由：挂在宿主 Web 服务上，与插件同版本、同源。
  if (resolved.web) {
    const options = { stateDir: STATE_DIR, dshHome: DSH_HOME };
    try {
      if (typeof ctx.inject === "function") {
        ctx.inject(["webServer"], (sub) => attachWebPanel(sub, options, warn));
      } else if (ctx.webServer !== undefined) {
        attachWebPanel(ctx, options, warn);
      }
    } catch (error) {
      warn(`面板挂载失败 ${error?.message ?? error}`);
    }
  }

  if (resolved.hint || resolved.role || resolved.gap) {
    try {
      ctx.on("agent/pre-step", async (payload, next) => {
        const decision = await next();
        if (decision.kind === "reject") return decision;
        try {
          const fromPayload = Array.isArray(payload?.messages) ? payload.messages : [];
          const fromDecision = Array.isArray(decision?.messages) ? decision.messages : [];
          const messages = fromDecision.length > 0 ? fromDecision : fromPayload;
          const agentId = typeof payload?.agent?.id === "string" ? payload.agent.id : "unknown";
          // 长任务里宿主只给增量消息，找不到人话就复用上一次的（见 lastPromptByAgent 注释）。
          let prompt = lastUserPrompt(messages);
          if (prompt !== undefined) lastPromptByAgent.set(agentId, prompt);
          else prompt = lastPromptByAgent.get(agentId);

          // 只对「真人那句话」判一次专家：系统注入的消息不参与路由。
          const text = prompt === undefined ? "" : promptText(prompt);
          let verdict = { kind: "miss", candidates: [] };
          if (resolved.experts && catalog.experts.length > 0 && text !== "" && text.length <= MAX_ROUTE_CHARS) {
            verdict = matchExpert(text, catalog.experts);
          }
          // 派单书（「身份：后端工程师」「用 expert("backend") 取完整工作方式」）自己点了人。
          // 它通常也会提到前端、测试、审查——按词面判「跨领域」是对的，按语义是错的：
          // 选人这一步已经做完了，再说一次「按主领域开工、副的一起交」等于让它去干别人的活。
          // 不受 MAX_ROUTE_CHARS 限制：这里是确定性匹配，长派单书一样认得出。
          const named = text === "" ? undefined : explicitExpert(text, catalog.experts);
          if (named !== undefined) verdict = { kind: "explicit", expert: named, candidates: [] };

          if (resolved.debug) {
            recordTrace({
              p: fromPayload.length,
              d: fromDecision.length,
              keys: Object.keys(decision ?? {}).join("|"),
              pkeys: Object.keys(payload ?? {}).join("|"),
              lastKind: messages[messages.length - 1]?.source?.kind ?? null,
              promptId: prompt?.id ?? null,
              rout: verdict.kind,
              expert: verdict.expert?.id ?? null,
            });
          }

          if (prompt === undefined) return decision;

          // 项目模式：会话有状态就从文件读。插件不猜阶段，只读事实。
          const sessionId = typeof payload?.agent?.id === "string" ? payload.agent.id : undefined;
          // 步数只用来决定「状态卡该不该再说一次」，不参与任何判断。
          // 三张备忘表都按 agent 记，长期开着会慢慢变大；超过上限就整表清掉——
          // 清掉最坏的结果是「同一句人话再补说一次」，没有正确性问题。
          if (stepCounts.size > MEMO_LIMIT) {
            stepCounts.clear();
            stateMarks.clear();
            lastPromptByAgent.clear();
          }
          const step = (stepCounts.get(agentId) ?? 0) + 1;
          stepCounts.set(agentId, step);
          const sessionState =
            resolved.project && sessionId !== undefined ? readState(stateFile(STATE_DIR, sessionId)) : undefined;
          const projectState =
            sessionState?.project !== undefined
              ? readState(projectStateFile(sessionState.project)) ?? sessionState
              : sessionState;
          const projectMode = projectState !== undefined && projectState.phase !== "idle";

          // 这一轮用哪种话说。判据只看用户这句话，不看配置：同一个会话里用户
          // 换语言是很自然的事，插件跟着换就行。判不出来（纯标点/纯数字）沿用上一次。
          const detected = detectLang(text);
          if (detected !== undefined) langByAgent.set(agentId, detected);
          const lang = detected ?? langByAgent.get(agentId) ?? "zh";

          const additions = [];
          // 目录（v2）在场时不再做规则角色注入：选人交给模型，再注入一次是在唱反调。
          if (resolved.role && !resolved.catalog && verdict.kind === "hit" && verdict.expert.hasRole && !rolePrompts.has(prompt.id)) {
            markRole(prompt.id);
            additions.push(roleMessage(verdict.expert, prompt.id));
          }
          // 缺口提示与缺口记账共用同一个判据：先算出「这句该不该有人接」的结论，
          // 不开口的句子（闲聊天）也不记账——否则记录里全是「今天吃什么」。
          // L1：项目模式不再门控这一段。原来 `!projectMode` 把「提示」和「记账」一起关掉了，
          // 结果是接单之后 gaps.jsonl 彻底断流，面板和 tools/gaps.mjs 只看得见 idle 的语料。
          // 现在只门控「注入」：状态卡优先，同一轮最多一条话；记账照样进行。
          // 「这句是提问」先算出来：它决定这一轮**只**说这一句。
          // 状态卡说「按任务卡推进」，提问提示说「别顺手改代码」——同一轮一起贴，
          // 两条指令方向相反；再叠一条主次提示（「按主领域开工」），一条用户消息就收到三段
          // 互相拉扯的话。代码里那条「一条消息最多补一条」的规矩，对这条也适用。
          const isAsk =
            resolved.hint &&
            projectMode &&
            looksLikeQuestion(text) &&
            !hintedPrompts.has(prompt.id) &&
            !hasHintFor(messages, prompt.id);
          // 提问轮不给状态卡让位额度：不调 shouldInjectState 就不会写 stateMarks，
          // 下一句不是提问时状态卡照常出现。让位一轮，不是取消。
          const wantState = projectMode && !isAsk && shouldInjectState(agentId, prompt.id, projectState.phase, step);
          if ((resolved.gap || resolved.gapLog) && verdict.kind !== "hit") {
            const phase = projectMode ? projectState.phase : undefined;
            const note = gapText(
              verdict,
              catalog,
              text,
              phase === undefined ? { lang } : { phase, phaseLabel: PHASE_LABEL[phase], lang },
            );
            if (note !== undefined) {
              // 记账：一句一次，不管这句最后说没说出口（账本与提示策略无关）。
              if (resolved.gapLog && !gapLogged.has(prompt.id)) {
                markGapLogged(prompt.id);
                recordGap(verdict, text, phase, lang);
              }
              // 注入：一句一次；被状态卡压住的那轮不标记，下一步补说。
              // 提问轮同样让位：缺口提示说的是「这块该不该补个专家」，而提问要的是答案。
              // 记账不受影响——账本记的是「这句没落到谁头上」，跟它最后说了什么无关。
              if (resolved.gap && !isAsk && !wantState && !gapPrompts.has(prompt.id)) {
                markGap(prompt.id);
                additions.push(gapMessage(note, prompt.id));
              }
            }
          }
          if (wantState) {
            additions.push(stateMessage(prompt.id, projectState, lang));
          }
          // 补充提示：一句话同时压到两个领域，或刚打开接单专家。
          // 一条用户消息最多补一条，避免和检查点叠成三段话把注意力撕碎。
          // 跟着 gap 开关走：关掉缺口提示的人，不会想要另一种「多说一句」。
          // 副领域提示在项目模式下也要说：任务卡写的是事先分好的工，用户临时插进来的跨领域
          // 请求不在卡上。实测「登录页样式全乱了，顺便把接口也改一下」在项目模式下只拿到状态卡，
          // 模型照着「按任务卡推进」只会做掉卡上那一半。
          if (resolved.gap && !isAsk && !notePrompts.has(prompt.id) && verdict.kind === "hit" && verdict.secondary !== undefined) {
            const note = secondaryText(verdict, lang);
            if (note !== undefined) {
              markNote(prompt.id);
              additions.push(noteMessage(note, prompt.id, SECONDARY_KIND));
            }
          }
          // 接单提示只在非项目模式：项目模式意味着已经接过单，再讲一次「接单不是终点」是废话。
          if (resolved.gap && !projectMode && !notePrompts.has(prompt.id) && verdict.kind === "hit" && (verdict.expert.kind ?? "worker") === "intake") {
            // 同一个来源，两种话说：还没接单就别急着谈分派，先让它去接单。
            // 不按阶段硬分岔会跳步——用户刚说「我想做个东西」，插件就宣布「接单之后要分派」。
            markNote(prompt.id);
            const nudge = (sessionState?.phase ?? "idle") === "idle" ? INTAKE_NUDGE_START : INTAKE_NUDGE;
            additions.push(noteMessage(nudge, prompt.id, INTAKE_KIND));
          }
          // 项目模式下检查点整体让位给状态卡，但「这句话是提问」这一条不能跟着让位。
          if (isAsk) {
            markHinted(prompt.id);
            recordHint(prompt.id);
            additions.push(hintMessage(prompt.id, lang === "en" ? ASK_TEXT_EN : ASK_TEXT));
          }
          // 项目模式下检查点降级：状态卡已经说了该干什么，再追加三分法会撕注意力。
          if (resolved.hint && !projectMode && !hintedPrompts.has(prompt.id) && !hasHintFor(messages, prompt.id)) {
            markHinted(prompt.id);
            recordHint(prompt.id);
            additions.push(hintMessage(prompt.id, lang === "en" ? HINT_TEXT_EN : HINT_TEXT));
          }

          if (resolved.runs) {
            recordRun({
              at: new Date().toISOString(),
              session: sessionId ?? null,
              phase: projectState?.phase ?? "idle",
              promptId: prompt.id ?? null,
              rout: verdict.kind,
              expert: verdict.expert?.id ?? null,
              // 下面三个字段是为了「事后能看出为什么这么选」：
              // task 说明这句像不像活，cands 说明当时有哪些备选，secondary 说明副领域被谁接着。
              task: looksLikeTask(text),
              cands: (verdict.candidates ?? []).map((row) => row.expert?.id ?? null).filter((id) => id !== null),
              secondary: verdict.secondary?.expert?.id ?? null,
              injected: additions.map((message) => message.source?.kind ?? "unknown"),
            });
          }

          if (additions.length === 0) return decision;
          return { ...decision, messages: [...messages, ...additions] };
        } catch (error) {
          warn(`路由失败 ${error?.message ?? error}`);
          return decision;
        }
      });
    } catch (error) {
      warn(`pre-step 挂钩失败 ${error?.message ?? error}`);
    }
  }

  try {
    ctx.effect(() => ctx.skills.register(selfSkill(resolved, catalog)), "capability-router: 自检技能");
  } catch (error) {
    warn(`自检技能注册失败 ${error?.message ?? error}`);
  }
}
