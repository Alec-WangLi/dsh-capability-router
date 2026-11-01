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

/**
 * 允许的阶段。顺序即推进方向。
 * deliver 是 2026-11-02 补的：原来的阶段止于 review，「审完了」和「交出去了」是同一格，
 * 于是「审过了就说完成」和「根本没审也说完成」在状态上长得一模一样。
 * 真实用例里交付的成品用户打不开、README 写错原因，就是这一格缺位的代价。
 */
export const PHASES = ["idle", "spec", "build", "review", "deliver"];

/** 阶段的中文名，状态卡与文档共用一套说法。 */
const PHASE_LABEL = {
  idle: "空闲",
  spec: "需求确认",
  build: "实现",
  review: "审查",
  deliver: "交付",
};

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
  return path.join(projectDir, ".capability-router", "state.json");
}

/** 新建一个空闲状态。 */
export function newState(sessionId) {
  return { sessionId: String(sessionId ?? "unknown"), phase: "idle", experts: [], since: new Date().toISOString() };
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
 * @returns {object} 写入后的状态
 */
export function writeState(file, state) {
  const next = normalizeState({ ...state, since: state.since ?? new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
  } catch {
    /* 写不进去就当没记过：状态卡是提示，不是账本 */
  }
  return next;
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
  return {
    sessionId: typeof value.sessionId === "string" && value.sessionId !== "" ? value.sessionId : base.sessionId,
    phase,
    experts: Array.isArray(value.experts) ? value.experts.filter((id) => typeof id === "string") : [],
    since: typeof value.since === "string" ? value.since : base.since,
    ...typeof value.project === "string" && value.project !== "" ? { project: value.project } : {},
  };
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
export function gateNote(state, expert) {
  const current = normalizeState(state);
  const kind = expert.kind ?? "worker";
  if (current.phase === "spec" && kind === "worker") {
    return "阶段提醒：需求还没确认（`REQUIREMENTS.md` 与 `TASKS.md` 未产出）。这一步只做澄清与记录，先别开工。";
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
  if (current.phase === "deliver" && kind === "intake") {
    return "阶段提醒：已经交付了，不用重新接单。新需求另起一段说。";
  }
  return undefined;
}

/**
 * 状态卡：一步一行，进 pre-step 的注入消息。
 * @param {object} state
 * @returns {string}
 */
export function stateCardText(state) {
  const current = normalizeState(state);
  const label = PHASE_LABEL[current.phase] ?? current.phase;
  const who = current.experts.length === 0 ? "无" : current.experts.join("、");
  return `【能力路由 · 项目模式】阶段：${label}（${current.phase}）｜在场专家：${who}｜下一步：${nextStep(current)}`;
}

/**
 * 当前阶段该干什么，一句话。
 * @param {object} state
 * @returns {string}
 */
export function nextStep(state) {
  const current = normalizeState(state);
  switch (current.phase) {
    case "spec":
      return "把需求收敛成 REQUIREMENTS.md + TASKS.md，再交给实现的专家";
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
