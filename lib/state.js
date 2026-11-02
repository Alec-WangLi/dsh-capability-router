/**
 * 会话状态：项目跑到哪一步了。
 *
 * 一条原则：**插件不猜阶段，只读事实**。阶段由模型的动作推进（打开接单专家 = 进入
 * 需求确认），由插件落盘；插件只负责把当前阶段摆回模型眼前，以及在该提醒的时候提醒。
 *
 * 存一个会话一个文件：`<STATE_DIR>/sessions/<sessionId>.json`。会话 id 来自
 * `payload.agent.id`（宿主里它等于 `agent.session.id`，见 `dsh-agent/lib/index.js:513-514`）。
 */

import fs from "node:fs";
import path from "node:path";
import { LEVEL_LABEL_EN, PHASE_LABEL_EN } from "./i18n.js";

/**
 * 允许的阶段。顺序即推进方向。
 * deliver 是 2026-11-02 补的：原来的阶段止于 review，「审完了」和「交出去了」是同一格，
 * 于是「审过了就说完成」和「根本没审也说完成」在状态上长得一模一样。
 * 真实用例里交付的成品用户打不开、README 写错原因，就是这一格缺位的代价。
 */
export const PHASES = ["idle", "spec", "build", "review", "deliver"];

/**
 * 阶段的中文名，状态卡与文档共用一套说法。
 * 2026-11-02 导出：原来这张表在 state.js / index.js / panel.js 各有一份，
 * 加第六个阶段时漏改任何一处，都会出现「实现」和「build」在同一屏里对不上。
 */
export const PHASE_LABEL = {
  idle: "空闲",
  spec: "需求确认",
  build: "实现",
  review: "审查",
  deliver: "交付",
};

/**
 * 允许的用户水平。顺序即从「要细节」到「只要结论」。
 *
 * 为什么单独一个字段：同一句需求，新手要的是「这是什么、为什么这么选」，
 * 老手要的是结论和命令。这个差别不改变任务本身，只改变回答的粒度，
 * 所以它进状态卡与闸门文案，不进专家的 role.md（角色提示词是静态的）。
 */
export const LEVELS = ["novice", "pro"];

/** 用户水平的中文名。未判定时状态卡显示「未判定」。 */
const LEVEL_LABEL = {
  novice: "新手",
  pro: "老手",
};

/** 状态卡总长上限；超了先砍「在场专家」，那一项最不影响下一步动作。 */
const CARD_LIMIT = 120;
// 英文按字符算，同样意思要多占三成（`unconfirmed` 十一个字母，`待确认` 三个字）。
// 两套上限各按各的语言卡，谁也别拿谁的尺子量。
const CARD_LIMIT_EN = 190;

/**
 * 会话 id → 合法文件名。
 * @param {string} sessionId
 * @returns {string}
 */
function safeId(sessionId) {
  const text = String(sessionId ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return text === "" ? "unknown" : text.slice(0, 96);
}

/**
 * 状态文件路径。
 * @param {string} stateDir 本插件状态目录
 * @param {string} sessionId
 * @returns {string}
 */
export function stateFile(stateDir, sessionId) {
  return path.join(stateDir, "sessions", `${safeId(sessionId)}.json`);
}

/**
 * 项目级状态文件：`<项目目录>/.capability-router/state.json`。
 *
 * 为什么需要它：阶段属于**项目**，不属于会话。多代理协作时同一个项目会被
 * 好几个会话接手（接单一个、实现一个、审查一个），阶段跟着会话走就会各自为政——
 * 验收里真出现过同一个项目在三个会话里分别是 spec / idle / review。
 * @param {string} projectDir 项目根目录（绝对路径）
 * @returns {string}
 */
export function projectStateFile(projectDir) {
  // resolve 一下：模型偶尔会传相对路径，而宿主的 cwd 与会话的工作目录不是一回事。
  // 至少让它落到一个**可预测、可回显**的位置，而不是某个别人看不见的目录里。
  return path.join(path.resolve(projectDir), ".capability-router", "state.json");
}

/** 新建一个空闲状态。 */
export function newState(sessionId) {
  return {
    sessionId: String(sessionId ?? "unknown"),
    phase: "idle",
    approved: false,
    experts: [],
    since: new Date().toISOString(),
  };
}

/**
 * 读状态；文件不存在或损坏都当作「空闲」，不抛。
 * @param {string} file
 * @returns {object|undefined}
 */
export function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeState(value);
  } catch {
    return undefined;
  }
}

/**
 * 写状态（先写临时文件再改名，避免半截 JSON）。
 * @param {string} file
 * @param {object} state
 * @returns {{ state: object, error: Error | undefined }} 规整后的状态，以及写失败时的原因
 */
export function writeState(file, state) {
  const next = normalizeState({ ...state, since: state.since ?? new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
  } catch (error) {
    // 以前这里静默吞掉，理由是「状态卡是提示，不是账本」。但 `project` 指到一个**文件**上时，
    // 状态每轮都丢、每轮都从头开始，而模型看到的 `found:true` 一切正常——
    // 静默失败比不记更贵，因为它让人以为记下了。现在把原因回传给调用方去说一句。
    return { state: next, error };
  }
  return { state: next, error: undefined };
}

/**
 * 规整外部读入的状态：未知阶段回落 idle，字段类型不对就重建。
 * @param {unknown} value
 * @returns {object}
 */
export function normalizeState(value) {
  const base = newState(value?.sessionId);
  if (value === null || typeof value !== "object") return base;
  const phase = PHASES.includes(value.phase) ? value.phase : "idle";
  // 状态文件是外部输入：`"true"` 字符串、`1` 都不算「方案已确认」，只认严格 true。
  // level 是非法值时只回落 undefined，不因此丢掉整份状态——阶段和在场专家比水平值钱。
  const level = LEVELS.includes(value.level) ? value.level : undefined;
  return {
    sessionId: typeof value.sessionId === "string" && value.sessionId !== "" ? value.sessionId : base.sessionId,
    phase,
    approved: value.approved === true,
    ...level === undefined ? {} : { level },
    experts: Array.isArray(value.experts) ? value.experts.filter((id) => typeof id === "string") : [],
    since: typeof value.since === "string" ? value.since : base.since,
    ...typeof value.project === "string" && value.project !== "" ? { project: value.project } : {},
    // 重开的痕迹。阶段退回 build，但「退过」这件事得留在状态里——
    // 否则事后看状态文件，一次重开和一次正常推进长得一模一样。
    ...typeof value.reopenedAt === "string" && value.reopenedAt !== "" ? { reopenedAt: value.reopenedAt } : {},
  };
}

/**
 * 记下用户想听多细（`expert(id, { level: "novice" })`）。
 * 非法值不改状态、只给一句原因：调用方传错了该被告知，但不该把已有状态冲掉。
 * @param {object} state
 * @param {unknown} level
 * @returns {{state: object, error?: string}}
 */
export function setLevel(state, level) {
  const current = normalizeState(state);
  const text = typeof level === "string" ? level.trim() : "";
  if (!LEVELS.includes(text)) {
    return { state: current, error: `未知的用户水平「${String(level ?? "")}」，只能是 ${LEVELS.join(" / ")}` };
  }
  return { state: { ...current, level: text } };
}

/**
 * 记下方案是否已被用户确认（`expert(id, { approved: false })` 可撤销）。
 * 与 level 一样只认严格布尔：这是提示级状态，不做类型宽容比做错更安全。
 * @param {object} state
 * @param {unknown} approved
 * @returns {{state: object, changed: boolean}}
 */
export function setApproved(state, approved) {
  const current = normalizeState(state);
  const next = approved === true;
  return { state: { ...current, approved: next }, changed: next !== current.approved };
}

/**
 * 打开一位专家时推进状态：接单专家 → 需求确认；其余专家把人记进在场的名单。
 * @param {object} state
 * @param {{id: string, kind?: string}} expert
 * @returns {object} 新状态（不改原对象）
 */
export function openExpert(state, expert) {
  const next = normalizeState(state);
  const experts = next.experts.includes(expert.id) ? next.experts : [...next.experts, expert.id];
  let phase = next.phase;
  if (expert.kind === "intake" && phase === "idle") phase = "spec";
  if (expert.kind === "reviewer" && phase === "build") phase = "review";
  return { ...next, phase, experts };
}

/**
 * 模型显式推进阶段（`expert("intake", { phase: "build" })`）。
 * 只允许往前走，且只允许跳过一格——阶段是「事实的记录」，不是可以随意改的开关。
 * @param {object} state
 * @param {string} target 目标阶段
 * @returns {{state: object, changed: boolean, error?: string}}
 */
export function advancePhase(state, target) {
  const current = normalizeState(state);
  if (!PHASES.includes(target)) {
    return { state: current, changed: false, error: `未知阶段「${target}」，只能是 ${PHASES.join(" / ")}` };
  }
  const from = PHASES.indexOf(current.phase);
  const to = PHASES.indexOf(target);
  // 幂等：已经在这个阶段就别报错，重复交卷是常态（多会话接手时常见）。
  if (to === from) return { state: current, changed: false };
  if (to < from) {
    return { state: current, changed: false, error: `阶段只能往前走：当前 ${current.phase}，目标是 ${target}` };
  }
  // 允许一次跨多格：换一个会话接手同一个项目时，新会话从 idle 起步，
  // 它需要能直接把阶段放到项目实际所处的 build / review。往后仍然一律禁止。
  return { state: { ...current, phase: target }, changed: true };
}

/**
 * 阶段闸门（提示级）：该阶段还差什么，差就说一句，不拦截。
 * @param {object} state
 * @param {{id: string, kind?: string}} expert 正要打开的专家
 * @returns {string|undefined}
 */
export function gateNote(state, expert, lang = "zh") {
  const current = normalizeState(state);
  const kind = expert.kind ?? "worker";
  if (lang === "en") return gateNoteEn(current, kind);
  // 调研分支必须排在所有 worker 分支之前：spec 阶段打开 research 时，
  // 该说的是「先查市面有没有现成的」，而不是「先别开工」——顺序写反会自相矛盾。
  // 但它也要看阶段：deliver 阶段需求早就写完了，再劝人「再决定需求怎么写」就是错的。
  if (kind === "scout") {
    if (current.phase === "idle" || current.phase === "spec") {
      return "阶段提醒：先出 `PRIOR-ART.md`（谁能直接用 / 谁能改着用 / 都不行为什么），再决定需求怎么写；没查过现成的就动手，等于重造一遍。";
    }
    // 不假设历史：跨格直接进 build 的项目（新会话从 idle 起步、advancePhase 允许跨格）
    // 其调研可能根本没人做过，断言「已经做完」等于给不存在的动作背书。
    // 所以这里只讲现在该干什么，并给一个「该回哪去」的落点。
    return `阶段提醒：调研是需求阶段的事，现在到了${PHASE_LABEL[current.phase] ?? current.phase}阶段——发现需求缺证据就补缺口，别重开一轮调研，也别再回到选型上；真发现需求本身有问题，回到接单专家那里改需求，别在下游打补丁。`;
  }
  if (current.phase === "spec" && kind === "worker") {
    const base = "阶段提醒：需求还没确认（`REQUIREMENTS.md` 与 `TASKS.md` 未产出）。这一步只做澄清与记录，先别开工。";
    // 这段会每轮注入一次，是最长的闸门文案。上下文预算吃紧要砍时按这个优先级：
    // 「先别开工」与「直接做也算确认」是行为约束，必须留；问水平那句是礼貌，先砍它。
    // 水平没判定时顺手把接单第一问带出来：判定前每轮都提，判定后消失。
    const askLevel =
      current.level === undefined
        ? "先问一句用户想听多细（新手要细节，老手直接上）并用 expert(\"intake\",{level:\"novice\"|\"pro\"}) 记下；"
        : "";
    // 「用户说直接做」也算确认——不写进这里，模型就会等一句形式上的「同意」才敢开工。
    const confirm = current.approved === true ? "" : "用户说「直接做」也算确认，用 {approved:true} 记下，不用等一句形式上的「同意」。";
    return `${base}${askLevel}${confirm}`;
  }
  if (current.phase === "idle" && kind === "reviewer") {
    return "阶段提醒：还没有可审的东西。审查专家通常在实现之后进场。";
  }
  // 这一条是 2026-11-02 真实用例补的：整场没调过一次 expert("intake")，
  // 直接叫领域专家开工，于是没有验收标准、也没人收口。跳过接单是最容易犯的错，
  // 所以要在这里说一句——它只在 idle 的第一次出现，不会每轮唠叨。
  if (current.phase === "idle" && kind === "worker") {
    return [
      "阶段提醒：还没接单。",
      "先 `expert(\"intake\")` 把需求收敛成 `REQUIREMENTS.md` + `TASKS.md`，再回来开工——",
      "没有验收标准的实现，做完也没人说得清算不算完。",
      "（只是改个小东西、或在别人已接单的项目里干活，可以忽略这句。）",
    ].join("");
  }
  if (current.phase === "review" && kind === "worker") {
    return "阶段提醒：正在审查。这一步只逐条核对，不改代码——发现不通过就先列缺口，改完重新审。";
  }
  // 交付之后开领域专家：以前这里返回 undefined，等于「已交付的项目接着改，没人说一句话」。
  // 阶段不能后退（advancePhase 只往前走），所以这不是「回 build 继续」能解决的问题——
  // 要么说清这是上一轮验收过的修补（那要回审查重核），要么承认它是新一轮需求。
  if (current.phase === "deliver" && kind === "worker") {
    return "阶段提醒：这个项目已经交付了。在交付状态上接着改，改动会落在没人验收的地方——先说清这是上一轮验收过的修补（那要回审查重核），还是新一轮需求（另建项目目录）；阶段不会自己退回去。";
  }
  // 交付之后叫审查专家：与上一条同族。复核是正当需求，但要先分清核的是哪一版——
  // 「交付后又改过」和「原样复核」是两件不同的事，静默等于让模型自己替用户决定。
  if (current.phase === "deliver" && kind === "reviewer") {
    return "阶段提醒：这个项目已经交付了。复核之前先说清核的是哪一版——交付之后又改过（那批改动没有验收记录，先核它），还是原样复核（结论要么推翻交付、要么补一句「复核通过」）。";
  }
  if (current.phase === "deliver" && kind === "intake") {
    return "阶段提醒：已经交付了，不用重新接单。新需求另起一段说。";
  }
  return undefined;
}

/**
 * `gateNote` 的英文版。逻辑逐条对应，文案各写各的——直译会留下中文语序的痕迹
 * （「阶段提醒：」直成 `Phase note:` 还行，但「别在下游打补丁」直译过去没人看得懂）。
 */
function gateNoteEn(current, kind) {
  const phaseName = PHASE_LABEL_EN[current.phase] ?? current.phase;
  if (kind === "scout") {
    if (current.phase === "idle" || current.phase === "spec") {
      return "Phase note: write `PRIOR-ART.md` first (who can use it as-is / who can adapt it / why nothing fits), then settle the requirements. Building without checking what already exists means building it twice.";
    }
    return `Phase note: research belongs to the spec phase, and you are in ${phaseName} now. If the requirements are missing evidence, fill that gap — do not reopen a research round and do not go back to picking a stack. If the requirement itself is wrong, go back to intake and fix it there instead of patching around it downstream.`;
  }
  if (current.phase === "spec" && kind === "worker") {
    const base = "Phase note: the requirements are not settled yet (`REQUIREMENTS.md` and `TASKS.md` do not exist). This step is clarification and notes only — do not start building. ";
    const askLevel =
      current.level === undefined
        ? 'Ask once how much detail they want (novice needs the why, experienced wants to get on with it) and record it with expert("intake",{level:"novice"|"pro"}); '
        : "";
    const confirm =
      current.approved === true
        ? ""
        : 'a plain "just do it" counts as approval — record it with {approved:true} instead of waiting for a formal yes.';
    return `${base}${askLevel}${confirm}`;
  }
  if (current.phase === "idle" && kind === "reviewer") {
    return "Phase note: there is nothing to review yet. Reviewers come in after the build.";
  }
  if (current.phase === "idle" && kind === "worker") {
    return [
      "Phase note: no one has taken this on yet. ",
      'Run `expert("intake")` to settle the requirements into `REQUIREMENTS.md` + `TASKS.md`, then come back and build — ',
      "without acceptance criteria, nobody can say afterwards whether it is done. ",
      "(If it is a small edit, or you are working inside a project someone else already took on, ignore this.)",
    ].join("");
  }
  if (current.phase === "review" && kind === "worker") {
    return "Phase note: this project is in review. This step is line-by-line checking only — do not change code. If something fails, list the gap first and re-review after it is fixed.";
  }
  if (current.phase === "deliver" && kind === "worker") {
    return "Phase note: this project has already been delivered. Changing it now means the change lands where nobody signs off. Say first whether this is a patch on the delivered version (it goes back through review) or a new round of requirements (start a new project directory) — the phase will not step backwards on its own.";
  }
  if (current.phase === "deliver" && kind === "reviewer") {
    return "Phase note: this project has already been delivered. Before reviewing, say which version you are checking — edits made after delivery (that batch has no acceptance record, check it first) or the delivered version unchanged (the conclusion either overturns the delivery or adds a \"review passed\").";
  }
  if (current.phase === "deliver" && kind === "intake") {
    return "Phase note: already delivered — no need to take it on again. Start a new requirement as its own piece of work.";
  }
  return undefined;
}

/**
 * 状态卡：一步一行，进 pre-step 的注入消息。
 * @param {object} state
 * @returns {string}
 */
export function stateCardText(state, lang = "zh") {
  const current = normalizeState(state);
  if (lang === "en") return stateCardTextEn(current);
  const label = PHASE_LABEL[current.phase] ?? current.phase;
  const head = `【能力路由 · 项目模式】阶段：${label}（${current.phase}）`;
  // 已确认是常态，不值得占字；只有「待确认」值得提醒。
  const plan = current.approved === true ? "" : "｜方案：待确认";
  const level = `｜用户水平：${current.level === undefined ? "未判定" : LEVEL_LABEL[current.level] ?? current.level}`;
  const who = `｜在场专家：${current.experts.length === 0 ? "无" : current.experts.join("、")}`;
  const tail = `｜下一步：${nextStep(current)}`;
  // 重开在完整版里露出日期（`2026-11-02T…` 取前 10 位）；超长的短版不带它——
  // 重开是当场就知道的事（note 里说得很清楚），状态卡只负责让后来的人看见「退过」。
  const reopened =
    typeof current.reopenedAt === "string" && current.reopenedAt.length >= 10 ? `｜重开于 ${current.reopenedAt.slice(5, 10)}` : "";
  const full = `${head}${plan}${reopened}${level}${who}${tail}`;
  // 超长先砍「在场专家」：那是最不影响下一步动作的一段。
  return full.length <= CARD_LIMIT ? full : `${head}${plan}${level}${tail}`;
}

/** `stateCardText` 的英文版：同样的取舍，同样的砍法（先砍在场专家）。 */
function stateCardTextEn(current) {
  const head = `[capability-router · project] phase: ${PHASE_LABEL_EN[current.phase] ?? current.phase}`;
  const plan = current.approved === true ? "" : " | plan: unconfirmed";
  const level = ` | user: ${current.level === undefined ? "unknown" : LEVEL_LABEL_EN[current.level] ?? current.level}`;
  const who = ` | in the room: ${current.experts.length === 0 ? "none" : current.experts.join(", ")}`;
  const tail = ` | next: ${nextStep(current, "en")}`;
  const reopened =
    typeof current.reopenedAt === "string" && current.reopenedAt.length >= 10 ? ` | reopened ${current.reopenedAt.slice(5, 10)}` : "";
  const full = `${head}${plan}${reopened}${level}${who}${tail}`;
  if (full.length <= CARD_LIMIT_EN) return full;
  // 砍的顺序按「谁先可以被牺牲」：在场专家是背景，读者水平只在第一次说话时有用，
  // 阶段和下一步是这张卡存在的理由——砍到最后也保留。
  const withoutWho = `${head}${plan}${reopened}${level}${tail}`;
  if (withoutWho.length <= CARD_LIMIT_EN) return withoutWho;
  return `${head}${plan}${reopened}${tail}`;
}

/**
 * 当前阶段该干什么，一句话。
 * @param {object} state
 * @returns {string}
 */
export function nextStep(state, lang = "zh") {
  const current = normalizeState(state);
  if (lang === "en") return nextStepEn(current);
  switch (current.phase) {
    case "spec":
      return "先出 PRIOR-ART.md，再收敛 REQUIREMENTS.md + TASKS.md，然后交给实现的专家";
    case "build":
      return "按任务卡推进；收口前交给审查专家";
    case "review":
      return "按同一份验收标准逐条核对，通过才算完";
    case "deliver":
      return "交付核对：真的装得上、真的开得起来、README 写的是真原因；核对完再说「可以用了」";
    default:
      return "普通对话；确认要开工后打开接单专家（`expert(\"intake\")`）";
  }
}

/** `nextStep` 的英文版。 */
function nextStepEn(current) {
  switch (current.phase) {
    case "spec":
      return "write PRIOR-ART.md first, then settle REQUIREMENTS.md + TASKS.md, then hand it to whoever builds";
    case "build":
      return "work the task cards; hand it to the reviewer before closing";
    case "review":
      return "check line by line against the same acceptance criteria; passing is what makes it done";
    case "deliver":
      // 英文按字符数算预算，这条原本 131 字符把 deliver 的状态卡顶到 202：
      // 压缩成三个问句而不是砍掉「真的能装/能开/README 说真原因」这三件事本身。
      return "delivery check: installs? starts? README says why? — only then call it ready";
    default:
      return 'plain conversation; once the work is confirmed, open intake (`expert("intake")`)';
  }
}
