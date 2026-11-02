/**
 * 只读面板的数据层：把四份状态文件读成一份快照，再渲染成 HTML / JSON。
 *
 * 这里不碰网络、不碰进程——服务由 `tools/panel.mjs` 起，测试直接喂目录。
 * 分层的理由很实际：面板的价值在「读什么」，宿主随时可能换 UI 通道（见 ARCHITECTURE 第九节），
 * 换个壳不该动这一层。
 */

import fs from "node:fs";
import path from "node:path";
import { PHASE_LABEL } from "./state.js";

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
    const entry = byText.get(text) ?? { text, count: 0, kinds: [], candidates: [], last: "" };
    entry.count += 1;
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
 * 读齐四份东西，交给渲染层。
 * @param {string} stateDir `<DSH_HOME>/capability-router`
 * @param {{doctor?: object, experts?: object[], sessionId?: string}} [extra]
 *   `sessionId` 非空时只看这一个会话（会话页那个 iframe 用）；缺口队列仍全局。
 * @returns {object}
 */
export function collect(stateDir, extra = {}) {
  const only = typeof extra.sessionId === "string" && extra.sessionId !== "" ? extra.sessionId : undefined;
  const runs = readRuns(path.join(stateDir, "runs.jsonl"), only === undefined ? 200 : 5000);
  const sessions = readSessions(path.join(stateDir, "sessions"));
  return {
    generatedAt: new Date().toISOString(),
    scope: only,
    runs: only === undefined ? runs : runs.filter((row) => row.session === only).slice(-200),
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
export function renderHtml(data) {
  const sessions = data.sessions ?? [];
  const runs = data.runs ?? [];
  const gaps = data.gaps ?? [];
  const doctor = data.doctor;

  const scope = typeof data.scope === "string" && data.scope !== "" ? data.scope : undefined;
  const scopeTitle = scope === undefined ? "全部会话" : `会话 ${escapeHtml(shortSession(scope))}`;
  const gapNote = scope === undefined ? "" : "（缺口队列是全局的：gaps.jsonl 不按会话记）";

  const sessionCards =
    sessions.length === 0
      ? `<div class="empty">还没有会话进入项目模式（打开 <code>expert("intake")</code> 才会写状态）</div>`
      : `<div class="grid">${sessions
          .slice(0, 8)
          .map(
            (session) => `<div class="card">
  <div class="k">会话 ${escapeHtml(shortSession(session.sessionId))}</div>
  <div class="v phase-${escapeHtml(session.phase)}">${escapeHtml(PHASE_LABEL[session.phase] ?? session.phase)}（${escapeHtml(session.phase)}）</div>
  <div class="meta">方案：${session.approved === true ? "已确认" : "待确认"}｜水平：${escapeHtml(LEVEL_LABEL[session.level] ?? "未判定")}</div>
  <div class="meta">在场：${escapeHtml(session.experts.join("、") || "无")}</div>
  <div class="meta">自 ${escapeHtml(session.since.replace("T", " ").slice(0, 19))}</div>
  ${session.project === undefined ? "" : `<div class="meta">项目 ${escapeHtml(session.project)}</div>`}
</div>`,
          )
          .join("")}</div>`;

  const recent = runs.slice(-25).reverse();
  const runRows =
    recent.length === 0
      ? `<tr><td colspan="5" class="empty">runs.jsonl 还是空的</td></tr>`
      : recent
          .map(
            (row) => `<tr>
  <td class="num">${escapeHtml(String(row.at ?? "").slice(11, 19))}</td>
  <td>${escapeHtml(shortSession(row.session))}</td>
  <td class="phase-${escapeHtml(row.phase ?? "idle")}">${escapeHtml(row.phase ?? "-")}</td>
  <td>${escapeHtml(row.rout ?? "-")}${row.expert ? " → " + escapeHtml(row.expert) : ""}</td>
  <td class="num">${escapeHtml((row.injected ?? []).map((kind) => String(kind).replace("capability-router-", "")).join(", ") || "-")}</td>
</tr>`,
          )
          .join("");

  const gapRows =
    gaps.length === 0
      ? `<tr><td colspan="4" class="empty">没有落空记录</td></tr>`
      : gaps
          .slice(0, 12)
          .map(
            (gap) => `<tr>
  <td>${escapeHtml(gap.text.length > 60 ? `${gap.text.slice(0, 60)}…` : gap.text)}</td>
  <td class="num">${gap.count}</td>
  <td>${escapeHtml(gap.kinds.join("、") || "-")}</td>
  <td class="num">${escapeHtml(gap.candidates.join("、") || "-")}</td>
</tr>`,
          )
          .join("");

  let doctorBlock = `<div class="empty">没有跑体检</div>`;
  if (doctor !== undefined) {
    const rows = (doctor.rows ?? [])
      .map((row) => {
        const miss = (row.missingRequired ?? []).map((dep) => dep.name);
        return `<tr>
  <td>${escapeHtml(row.id)}</td>
  <td>${escapeHtml(row.kind ?? "worker")}</td>
  <td class="num">${(row.deps ?? []).length}</td>
  <td>${miss.length === 0 ? `<span class="phase-review">齐全</span>` : escapeHtml(miss.join("、"))}</td>
</tr>`;
      })
      .join("");
    doctorBlock = `<table>
  <tr><th>专家</th><th>角色</th><th>依赖</th><th>缺必装</th></tr>
  ${rows}
</table>`;
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>能力路由 · 面板</title>
<style>${STYLE}</style>
</head>
<body>
<h1>能力路由 · 面板 <span class="meta">${scopeTitle}</span></h1>
<div class="meta">只读 · 5 秒自动刷新 · 生成于 ${escapeHtml(data.generatedAt ?? "")}</div>

<h2>会话阶段</h2>
${sessionCards}

<h2>最近 25 步</h2>
<table>
  <tr><th>时间</th><th>会话</th><th>阶段</th><th>命中</th><th>注入</th></tr>
  ${runRows}
</table>

<h2>缺口队列<span class="meta">${gapNote}</span></h2>
<table>
  <tr><th>原话</th><th>次数</th><th>结论</th><th>候选</th></tr>
  ${gapRows}
</table>

<h2>技能供给</h2>
${doctorBlock}
</body>
</html>
`;
}
