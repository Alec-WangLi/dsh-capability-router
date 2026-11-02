/**
 * 只读面板的数据层：把四份状态文件读成一份快照，再渲染成 HTML / JSON。
 *
 * 这里不碰网络、不碰进程——服务由 `tools/panel.mjs` 起，测试直接喂目录。
 * 分层的理由很实际：面板的价值在「读什么」，宿主随时可能换 UI 通道（见 ARCHITECTURE 第九节），
 * 换个壳不该动这一层。
 */

import fs from "node:fs";
import path from "node:path";
import { PHASE_LABEL, projectStateFile, readState } from "./state.js";
import { LEVEL_LABEL_EN, PHASE_LABEL_EN, t } from "./i18n.js";

function readLines(file, limit) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* 半截行（进程被杀）跳过就好，面板不该因为一行坏数据白屏 */
    }
  }
  return limit === undefined ? rows : rows.slice(-limit);
}

/**
 * 每一步的判断记录，按时间正序。
 * @param {string} file runs.jsonl
 * @param {number} [limit]
 * @returns {object[]}
 */
export function readRuns(file, limit = 200) {
  return readLines(file, limit);
}

/**
 * 把「每步一行」的运行记录按 promptId 折叠成「一句一行」。
 *
 * `runs.jsonl` 是每步一行（`lib/index.js` 的设计如此），一句话跑 55 步就有 55 行。
 * 面板直接取最近 25 行，看到的是同一句话的一小段——「这个会话换过几次专家」
 * 这种问题得翻几十行才见得到上一句。
 *
 * 折叠只给面板看，`readRuns()` 保持原样：`tools/match.mjs` 的 a/b 判定按句算，
 * 两边口径混了会把「命中 20 句」变成「命中 20 步」。
 *
 * 只合并**相邻**的同 promptId 行。不同会话交错写进来时不能跨行合并，
 * 否则会把别人那一步算到这一句头上。
 *
 * @param {object[]} rows readRuns() 的结果，时间正序
 * @returns {object[]} 每句一行，字段与原来一致，多一个 steps
 */
export function foldRuns(rows) {
  const out = [];
  let current;
  for (const row of rows) {
    const id = typeof row.promptId === "string" && row.promptId !== "" ? row.promptId : undefined;
    if (id !== undefined && current !== undefined && current.promptId === id) {
      current.steps += 1;
      // 时间取最后一次：这一句最后一步在什么时候发生的
      if (row.at !== undefined) current.at = row.at;
      if (row.phase !== undefined) current.phase = row.phase;
      if (row.rout !== undefined) current.rout = row.rout;
      if (row.expert !== undefined) current.expert = row.expert;
      for (const kind of row.injected ?? []) {
        if (!current.injected.includes(kind)) current.injected.push(kind);
      }
      continue;
    }
    current = {
      promptId: id,
      at: row.at,
      session: row.session,
      phase: row.phase,
      rout: row.rout,
      expert: row.expert,
      injected: [...(row.injected ?? [])],
      steps: 1,
    };
    out.push(current);
  }
  return out;
}

/**
 * 所有会话的状态文件。
 * @param {string} dir `<STATE_DIR>/sessions`
 * @returns {object[]}
 */
export function readSessions(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      rows.push({
        sessionId: typeof value.sessionId === "string" ? value.sessionId : name.replace(/\.json$/, ""),
        phase: typeof value.phase === "string" ? value.phase : "idle",
        // 与 normalizeState 同一套降级语义：approved 一律布尔，level 只认 novice / pro。
        // level 未判定时写 null 而不是省略：JSON.stringify 会把 undefined 的键整个丢掉，
        // 省略掉的话 client 那边拿到的对象里根本没这个键，就分不清「没判定」和「老版本没这字段」。
        approved: value.approved === true,
        level: value.level === "novice" || value.level === "pro" ? value.level : null,
        experts: Array.isArray(value.experts) ? value.experts : [],
        since: typeof value.since === "string" ? value.since : "",
        ...typeof value.project === "string" && value.project !== "" ? { project: value.project } : {},
      });
    } catch {
      continue;
    }
  }
  return rows.sort((left, right) => String(right.since).localeCompare(String(left.since)));
}

/**
 * 缺口按原话聚合：同一句话说几次、最近一次是什么时候、当时怀疑哪两个专家。
 * @param {string} file gaps.jsonl
 * @returns {{text: string, count: number, kinds: string[], candidates: string[], last: string}[]}
 */
export function readGaps(file) {
  const byText = new Map();
  for (const row of readLines(file)) {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (text === "") continue;
    const entry = byText.get(text) ?? { text, count: 0, kinds: [], candidates: [], phases: [], last: "" };
    entry.count += 1;
    // 阶段要留着：同一句话在「需求确认」和「实现」阶段落空，意思完全不同——
    // 前者说明词表没收住需求，后者说明该补一个专家。v0.20.1 起 gaps.jsonl 才带这个字段，
    // 老行没有，聚合时空着即可。
    if (typeof row.phase === "string" && row.phase !== "" && !entry.phases.includes(row.phase)) entry.phases.push(row.phase);
    if (typeof row.kind === "string" && !entry.kinds.includes(row.kind)) entry.kinds.push(row.kind);
    for (const name of Array.isArray(row.candidates) ? row.candidates : []) {
      if (typeof name === "string" && !entry.candidates.includes(name)) entry.candidates.push(name);
    }
    if (typeof row.at === "string" && row.at > entry.last) entry.last = row.at;
    byText.set(text, entry);
  }
  return [...byText.values()].sort((left, right) => right.count - left.count || String(right.last).localeCompare(String(left.last)));
}

/**
 * 会话文件里的 `phase` / `experts` 只是**镜像**，pre-step 判的是项目文件。
 * 同一个项目被几个会话接手时，镜像会各自停在不同阶段——面板照抄镜像，
 * 就等于让用户同时看见三个不一样的「现在」。所以有 `project` 就以项目文件为准。
 *
 * 读不到项目文件（被删、路径失效）时退回镜像，并标 `fromProject: false`，
 * 让人知道这份显示可能已经过期。
 */
function effectiveSession(row) {
  const project = row.project;
  if (typeof project !== "string" || project === "") return row;
  const state = readState(projectStateFile(project));
  if (state === undefined || state === null) return { ...row, fromProject: false };
  return {
    ...row,
    phase: state.phase,
    experts: state.experts,
    approved: state.approved,
    ...state.level === undefined ? {} : { level: state.level },
    fromProject: true,
  };
}

/**
 * 读齐四份东西，交给渲染层。
 * @param {string} stateDir `<DSH_HOME>/capability-router`
 * @param {{doctor?: object, experts?: object[], sessionId?: string}} [extra]
 *   `sessionId` 非空时只看这一个会话（会话页那个 iframe 用）；缺口队列仍全局。
 * @returns {object}
 */
export function collect(stateDir, extra = {}) {
  const only = typeof extra.sessionId === "string" && extra.sessionId !== "" ? extra.sessionId : undefined;
  // 200 行在「每步一行」的粒度下只够两三句（实测单句最多 55 步）。折叠发生在渲染层，
  // 所以这里必须读到够 25 句的量：按每句 80 步封顶算，2000 行足够；真超了也只是截得早一点。
  const runs = readRuns(path.join(stateDir, "runs.jsonl"), only === undefined ? 2000 : 5000);
  const sessions = readSessions(path.join(stateDir, "sessions")).map(effectiveSession);
  return {
    generatedAt: new Date().toISOString(),
    scope: only,
    runs: only === undefined ? runs : runs.filter((row) => row.session === only).slice(-2000),
    sessions: only === undefined ? sessions : sessions.filter((row) => row.sessionId === only),
    gaps: readGaps(path.join(stateDir, "gaps.jsonl")),
    doctor: extra.doctor,
    experts: extra.experts ?? [],
  };
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortSession(id) {
  const text = String(id ?? "");
  return text.length <= 16 ? text : `${text.slice(0, 8)}…${text.slice(-4)}`;
}

/** 用户水平的中文名。null（未判定）在卡片上显示「未判定」。 */
const LEVEL_LABEL = { novice: "新手", pro: "老手" };

const STYLE = `
:root { color-scheme: dark; }
body { margin: 0; padding: 24px; background: #14161a; color: #d7dae0;
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
h1 { font-size: 15px; margin: 0 0 4px; font-weight: 600; letter-spacing: .04em; }
h2 { font-size: 12px; margin: 28px 0 8px; font-weight: 600; color: #8b93a1;
  text-transform: uppercase; letter-spacing: .12em; }
.meta { color: #6b7280; margin-bottom: 4px; }
.grid { display: flex; flex-wrap: wrap; gap: 12px; }
.card { border: 1px solid #262b33; border-radius: 6px; padding: 10px 12px; min-width: 220px; background: #181b20; }
.card .k { color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
.card .v { font-size: 14px; margin-top: 2px; }
.phase-spec { color: #e0b341; } .phase-build { color: #5fa8f5; }
.phase-review { color: #b18cf0; } .phase-deliver { color: #4fc08d; } .phase-idle { color: #8b93a1; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid #23272e; vertical-align: top; }
th { color: #6b7280; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
td.num { color: #8b93a1; }
.empty { color: #5b6270; font-style: italic; }
code { background: #1d2128; padding: 1px 4px; border-radius: 3px; }
`;

/**
 * 渲染整页 HTML。
 * @param {object} data collect() 的结果
 * @returns {string}
 */
export function renderHtml(data, lang = "zh") {
  // 面板是给人看的，所以它得跟人走，不跟数据走：同一份快照，语言由 URL 决定（?lang=en）。
  // 阶段名、水平名这些「自己长出来的词」走 i18n 的表；专家 id 原样显示——它本来就是英文。
  const T = (zh, en) => t(lang, zh, en);
  const phaseOf = (phase) => (lang === "en" ? PHASE_LABEL_EN[phase] ?? phase : PHASE_LABEL[phase] ?? phase);
  const levelOf = (level) =>
    lang === "en" ? LEVEL_LABEL_EN[level] ?? "unknown" : LEVEL_LABEL[level] ?? "未判定";

  const sessions = data.sessions ?? [];
  const runs = data.runs ?? [];
  const gaps = data.gaps ?? [];
  const doctor = data.doctor;

  const scope = typeof data.scope === "string" && data.scope !== "" ? data.scope : undefined;
  const scopeTitle = scope === undefined ? T("全部会话", "all sessions") : `${T("会话", "session")} ${escapeHtml(shortSession(scope))}`;
  const gapNote = scope === undefined ? "" : T("（缺口队列是全局的：gaps.jsonl 不按会话记）", " (the gap queue is global: gaps.jsonl is not per-session)");

  const sessionCards =
    sessions.length === 0
      ? `<div class="empty">${T(`还没有会话进入项目模式（打开 <code>expert("intake")</code> 才会写状态）`, `No session has entered project mode yet — state is written when <code>expert("intake")</code> is opened.`)}</div>`
      : `<div class="grid">${sessions
          .slice(0, 8)
          .map(
            (session) => `<div class="card">
  <div class="k">${T("会话", "session")} ${escapeHtml(shortSession(session.sessionId))}</div>
  <div class="v phase-${escapeHtml(session.phase)}">${escapeHtml(phaseOf(session.phase))}（${escapeHtml(session.phase)}）</div>
  <div class="meta">${T("方案：", "plan: ")}${session.approved === true ? T("已确认", "confirmed") : T("待确认", "unconfirmed")}｜${T("水平：", "user: ")}${escapeHtml(levelOf(session.level))}</div>
  <div class="meta">${T("在场：", "in the room: ")}${escapeHtml(session.experts.join(lang === "en" ? ", " : "、") || T("无", "none"))}</div>
  <div class="meta">${T("自", "since")} ${escapeHtml(session.since.replace("T", " ").slice(0, 19))}</div>
  ${session.project === undefined ? "" : `<div class="meta">${T("项目", "project")} ${escapeHtml(session.project)}</div>`}
</div>`,
          )
          .join("")}</div>`;

  // 先折叠再截断：直接 slice(-25) 会把同一句的 25 步全取走，表里只剩一句话。
  // 折叠之后 25 行是 25 句，步数挂在路由列上（×N）。
  const recent = foldRuns(runs).slice(-25).reverse();
  const runRows =
    recent.length === 0
      ? `<tr><td colspan="5" class="empty">${T("runs.jsonl 还是空的", "runs.jsonl is still empty")}</td></tr>`
      : recent
          .map(
            (row) => `<tr>
  <td class="num">${escapeHtml(String(row.at ?? "").slice(11, 19))}</td>
  <td>${escapeHtml(shortSession(row.session))}</td>
  <td class="phase-${escapeHtml(row.phase ?? "idle")}">${escapeHtml(row.phase ?? "-")}</td>
  <td>${escapeHtml(row.rout ?? "-")}${row.expert ? " → " + escapeHtml(row.expert) : ""}${(row.steps ?? 1) > 1 ? ` ×${row.steps}` : ""}</td>
  <td class="num">${escapeHtml((row.injected ?? []).map((kind) => String(kind).replace("capability-router-", "")).join(", ") || "-")}</td>
</tr>`,
          )
          .join("");

  const gapRows =
    gaps.length === 0
      ? `<tr><td colspan="5" class="empty">${T("没有落空记录", "no gaps recorded")}</td></tr>`
      : gaps
          .slice(0, 12)
          .map(
            (gap) => `<tr>
  <td>${escapeHtml(gap.text.length > 60 ? `${gap.text.slice(0, 60)}…` : gap.text)}</td>
  <td class="num">${gap.count}</td>
  <td>${escapeHtml((gap.phases ?? []).map((phase) => phaseOf(phase)).join(lang === "en" ? ", " : "、") || "-")}</td>
  <td>${escapeHtml(gap.kinds.join(lang === "en" ? ", " : "、") || "-")}</td>
  <td class="num">${escapeHtml(gap.candidates.join(lang === "en" ? ", " : "、") || "-")}</td>
</tr>`,
          )
          .join("");

  let doctorBlock = `<div class="empty">${T("没有跑体检", "no doctor run yet")}</div>`;
  if (doctor !== undefined) {
    const rows = (doctor.rows ?? [])
      .map((row) => {
        const miss = (row.missingRequired ?? []).map((dep) => dep.name);
        return `<tr>
  <td>${escapeHtml(row.id)}</td>
  <td>${escapeHtml(row.kind ?? "worker")}</td>
  <td class="num">${(row.deps ?? []).length}</td>
  <td>${miss.length === 0 ? `<span class="phase-review">${T("齐全", "ok")}</span>` : escapeHtml(miss.join(lang === "en" ? ", " : "、"))}</td>
</tr>`;
      })
      .join("");
    doctorBlock = `<table>
  <tr><th>${T("专家", "expert")}</th><th>${T("角色", "kind")}</th><th>${T("依赖", "deps")}</th><th>${T("缺必装", "missing")}</th></tr>
  ${rows}
</table>`;
  }

  const otherLang = lang === "en" ? "zh" : "en";
  const otherLabel = lang === "en" ? "Chinese" : "English";

  return `<!doctype html>
<html lang="${lang === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>${T("能力路由 · 面板", "capability-router · panel")}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${T("能力路由 · 面板", "capability-router · panel")} <span class="meta">${scopeTitle}</span> <a class="meta" href="?lang=${otherLang}">${otherLabel}</a></h1>
<div class="meta">${T("只读 · 5 秒自动刷新 · 生成于", "read-only · refreshes every 5s · generated at")} ${escapeHtml(data.generatedAt ?? "")}</div>

<h2>${T("会话阶段", "session phase")}</h2>
${sessionCards}

<h2>${T("最近 25 步", "last 25 turns")}</h2>
<table>
  <tr><th>${T("时间", "time")}</th><th>${T("会话", "session")}</th><th>${T("阶段", "phase")}</th><th>${T("命中", "routing")}</th><th>${T("注入", "injected")}</th></tr>
  ${runRows}
</table>

<h2>${T("缺口队列", "gap queue")}<span class="meta">${gapNote}</span></h2>
<table>
  <tr><th>${T("原话", "said")}</th><th>${T("次数", "count")}</th><th>${T("阶段", "phase")}</th><th>${T("结论", "verdict")}</th><th>${T("候选", "candidates")}</th></tr>
  ${gapRows}
</table>

<h2>${T("技能供给", "skill supply")}</h2>
${doctorBlock}
</body>
</html>
`;
}
