/**
 * 只读面板的数据层：把四份状态文件读成一份快照，再渲染成 HTML / JSON。
 *
 * 这里不碰网络、不碰进程——服务由 `tools/panel.mjs` 起，测试直接喂目录。
 * 分层的理由很实际：面板的价值在「读什么」，宿主随时可能换 UI 通道（见 ARCHITECTURE 第九节），
 * 换个壳不该动这一层。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_LABEL, projectStateFile, readState } from "./state.js";
import { KIND_LABEL_EN, LEVEL_LABEL_EN, PHASE_LABEL_EN, t } from "./i18n.js";

/**
 * 插件版本号，显示在面板顶部。
 *
 * 面板最常见的困惑是「我重启了，跑的是新代码吗」——版本号就在这一页上，
 * 对一眼 package.json 就知道。读不到不算错（发布出去的包可能被裁过），给 unknown。
 * @returns {string}
 */
let versionCache;
export function pluginVersion() {
  if (versionCache !== undefined) return versionCache;
  try {
    const file = fileURLToPath(new URL("../package.json", import.meta.url));
    const value = JSON.parse(fs.readFileSync(file, "utf8")).version;
    versionCache = typeof value === "string" && value !== "" ? value : "unknown";
  } catch {
    versionCache = "unknown";
  }
  return versionCache;
}

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
 *
 * `langs` 是 v0.21.3 起账本就有的语言分布（`lang: "zh" | "en"`）。它回答的是
 * 「是不是英文会话里没人接」——这个问题在只看原话时看不出来：中文用户和英文用户
 * 说同一件事，落空的往往是其中一边。
 *
 * @param {string} file gaps.jsonl
 * @returns {{text: string, count: number, kinds: string[], candidates: string[], phases: string[], langs: string[], last: string}[]}
 */
export function readGaps(file) {
  const byText = new Map();
  for (const row of readLines(file)) {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (text === "") continue;
    const entry = byText.get(text) ?? { text, count: 0, kinds: [], candidates: [], phases: [], langs: [], last: "" };
    entry.count += 1;
    // 阶段要留着：同一句话在「需求确认」和「实现」阶段落空，意思完全不同——
    // 前者说明词表没收住需求，后者说明该补一个专家。v0.20.1 起 gaps.jsonl 才带这个字段，
    // 老行没有，聚合时空着即可。
    if (typeof row.phase === "string" && row.phase !== "" && !entry.phases.includes(row.phase)) entry.phases.push(row.phase);
    // 没有 `lang` 键 = 中文：写入口径是「中文是基线，只记非中文」（lib/index.js 的 recordGap）。
    // 这里必须跟着补上，否则老账本会在面板上显示成「语言不明」——那不是未知，那是中文。
    const code = typeof row.lang === "string" && row.lang !== "" ? row.lang : "zh";
    if (!entry.langs.includes(code)) entry.langs.push(code);
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
 * 缺口队列的「结论」列：把内部值（miss / ambiguous / cross）翻成一句下一步动作。
 *
 * 为什么不把内部值直接显示：`miss` 是给账本用的分类，用户读到的是「没人接」这件事，
 * 而不是分类名。同一句 `miss` 在需求期和实现期要做的动作完全不同，所以按阶段分叉。
 *
 * @param {{kinds?: string[], phases?: string[]}} gap
 * @param {"zh"|"en"} [lang]
 * @returns {string}
 */
export function gapSuggestion(gap, lang = "zh") {
  const kinds = Array.isArray(gap?.kinds) ? gap.kinds : [];
  const phases = Array.isArray(gap?.phases) ? gap.phases : [];
  const inBuild = phases.some((phase) => phase === "build" || phase === "review" || phase === "deliver");
  if (kinds.includes("ambiguous")) {
    return t(lang, "两个专家在抢：收窄其中一方的触发词", "two experts overlap — narrow one side's triggers");
  }
  if (kinds.includes("cross")) {
    return t(lang, "跨领域：按主次分派，别一个人硬扛", "cross-domain — split by primary/secondary");
  }
  if (kinds.includes("miss") && phases.includes("spec")) {
    return t(lang, "需求期落空：给接单专家补触发词", "missed at spec — add triggers to the intake expert");
  }
  if (kinds.includes("miss") && inBuild) {
    return t(lang, "实现期落空：该造一个新专家了", "missed mid-build — worth a new expert");
  }
  if (kinds.includes("miss")) {
    return t(lang, "没人接：先看是不是新领域", "nobody claimed it — check whether it is a new domain");
  }
  return t(lang, "先观察：样本还太少", "watch it — too few samples yet");
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
 * 把会话按项目合并成「一张卡一个项目」。
 *
 * 为什么必须合并：一个项目被 3 个会话接手是常态（新开窗口、重启 DSH、换模型），
 * 每个会话各留一份镜像。按会话铺卡，用户看到的是 3 张一模一样的「实现 · 在场 intake、backend」，
 * 分不清是 3 个项目还是 1 个项目被接手了 3 次——面板回答的应该是后一个问题。
 *
 * 没有 `project` 的会话各自成组（它没有可合并的身份）。
 * 组内成员阶段不一致时标 `conflict`：这说明有会话读不到项目文件、退回的是过期镜像。
 *
 * @param {object[]} sessions readSessions() 之后（最好已经过 effectiveSession）
 * @returns {object[]} 每组：key / project? / sessions[] / phase / approved / level / experts / since / fromProject / conflict
 */
export function groupProjects(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const project = typeof session.project === "string" && session.project !== "" ? session.project : undefined;
    const key = project ?? `session:${session.sessionId}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        ...project === undefined ? {} : { project },
        sessions: [session.sessionId],
        phase: session.phase,
        approved: session.approved === true,
        level: session.level ?? null,
        experts: [...session.experts],
        since: session.since,
        fromProject: session.fromProject !== false,
        conflict: false,
      });
      continue;
    }
    // 组内按 since 倒序进来的，第一个就是最新的那个会话——它的镜像最接近事实。
    if (!existing.sessions.includes(session.sessionId)) existing.sessions.push(session.sessionId);
    if (session.phase !== existing.phase) existing.conflict = true;
  }
  return [...groups.values()];
}

/**
 * 读齐四份东西，交给渲染层。
 * @param {string} stateDir `<DSH_HOME>/capability-router`
 * @param {{doctor?: object, experts?: object[], sessionId?: string, config?: object}} [extra]
 *   `sessionId` 非空时只看这一个会话（会话页那个 iframe 用）；缺口队列仍全局。
 *   `config` 是插件当前生效的开关（`lib/index.js` 的 resolved），独立面板没有它。
 * @returns {object}
 */
export function collect(stateDir, extra = {}) {
  const only = typeof extra.sessionId === "string" && extra.sessionId !== "" ? extra.sessionId : undefined;
  // 200 行在「每步一行」的粒度下只够两三句（实测单句最多 55 步）。折叠发生在渲染层，
  // 所以这里必须读到够 25 句的量：按每句 80 步封顶算，2000 行足够；真超了也只是截得早一点。
  const runs = readRuns(path.join(stateDir, "runs.jsonl"), only === undefined ? 2000 : 5000);
  const sessions = readSessions(path.join(stateDir, "sessions")).map(effectiveSession);
  const scoped = only === undefined ? sessions : sessions.filter((row) => row.sessionId === only);
  // 快照会经 `/api/state` 出去，配置里只该有开关：`order`、`debug`、用户 `config.json`
  // 里的任意键（可能有 key/token）都不该跟着走。入口那一层已经挑过一遍，这里再兜一次——
  // 多一道过滤比多一个泄露面便宜，而且这道闸门对所有调用方都生效（含将来的壳）。
  const switches =
    extra.config === undefined
      ? undefined
      : Object.fromEntries(Object.entries(extra.config).filter(([, value]) => typeof value === "boolean"));
  return {
    generatedAt: new Date().toISOString(),
    scope: only,
    version: pluginVersion(),
    stateDir: String(stateDir ?? ""),
    ...(switches === undefined ? {} : { config: switches }),
    // 项目分组也按 scope 过滤：会话页那格只该看当前会话，但它所属项目的信息照旧有用。
    projects: groupProjects(scoped),
    runs: only === undefined ? runs : runs.filter((row) => row.session === only).slice(-2000),
    sessions: scoped,
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

/**
 * 绝对路径在卡片里会把布局撑破（`C:\Users\…\Documents\…\项目` 一条就占两行）。
 * 卡片上只留最后两段，完整路径放进 `title`——想看全的悬停就有，不想看的不用被它挤。
 */
function shortPath(value, keep = 2) {
  const text = String(value ?? "");
  const parts = text.split(/[\\/]+/).filter((part) => part !== "");
  if (parts.length <= keep) return text;
  return `…/${parts.slice(-keep).join("/")}`;
}

/** 用户水平的中文名。null（未判定）在卡片上显示「未判定」。 */
const LEVEL_LABEL = { novice: "新手", pro: "老手" };
/** 专家类别的中文名。 */
const KIND_LABEL = { intake: "接单", worker: "执行", scout: "调研", reviewer: "审查" };
/** 缺口语言的显示名。 */
const LANG_LABEL = { zh: "中文", en: "English" };

const STYLE = `
:root { color-scheme: light dark;
  --bg: #fbfbfd; --fg: #1f2328; --muted: #5b6270; --line: #e3e6ea; --card: #ffffff; --chip: #f1f3f6;
  --spec: #9a6700; --build: #1a5fb4; --review: #6b3fa0; --deliver: #1a7f4b; --idle: #5b6270; }
@media (prefers-color-scheme: dark) { :root {
  --bg: #14161a; --fg: #d7dae0; --muted: #9aa2b1; --line: #262b33; --card: #181b20; --chip: #1d2128;
  --spec: #e0b341; --build: #5fa8f5; --review: #b18cf0; --deliver: #4fc08d; --idle: #9aa2b1; } }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
h1 { font-size: 15px; margin: 0 0 10px; font-weight: 600; letter-spacing: .04em; }
h2 { font-size: 12px; margin: 28px 0 8px; font-weight: 600; color: var(--muted);
  text-transform: uppercase; letter-spacing: .12em; }
.meta { color: var(--muted); margin-bottom: 4px; }
.bar { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 6px; background: var(--card); }
.chip { color: var(--muted); }
.chip b { color: var(--fg); font-weight: 600; }
.grid { display: flex; flex-wrap: wrap; gap: 12px; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; min-width: 220px; max-width: 340px; background: var(--card); }
.card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .1em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .v { font-size: 14px; margin-top: 2px; }
.warn { color: var(--spec); }
.phase-spec { color: var(--spec); } .phase-build { color: var(--build); }
.phase-review { color: var(--review); } .phase-deliver { color: var(--deliver); } .phase-idle { color: var(--idle); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
td.num { color: var(--muted); }
.empty { color: var(--muted); font-style: italic; }
code { background: var(--chip); padding: 1px 4px; border-radius: 3px; }
`;

/**
 * 渲染整页 HTML。
 *
 * 页面里没有 `<meta http-equiv="refresh">`：整页刷新会把滚动位置打回顶部，
 * 一个正看到第 30 句的面板每 5 秒跳一次，等于不能用。改成轮询同一页、只替换区块内容
 * （见页尾脚本）：滚动位置留着，服务端仍然是唯一的渲染实现。
 *
 * @param {object} data collect() 的结果
 * @param {"zh"|"en"} [lang]
 * @returns {string}
 */
export function renderHtml(data, lang = "zh") {
  // 面板是给人看的，所以它得跟人走，不跟数据走：同一份快照，语言由 URL 决定（?lang=en）。
  // 阶段名、水平名这些「自己长出来的词」走 i18n 的表；专家 id 原样显示——它本来就是英文。
  const T = (zh, en) => t(lang, zh, en);
  const phaseOf = (phase) => (lang === "en" ? PHASE_LABEL_EN[phase] ?? phase : PHASE_LABEL[phase] ?? phase);
  const levelOf = (level) =>
    lang === "en" ? LEVEL_LABEL_EN[level] ?? "unknown" : LEVEL_LABEL[level] ?? "未判定";
  const kindOf = (kind) => (lang === "en" ? KIND_LABEL_EN[kind] ?? kind ?? "worker" : KIND_LABEL[kind] ?? kind ?? "执行");
  const langOf = (code) => (lang === "en" ? (code === "zh" ? "Chinese" : "English") : LANG_LABEL[code] ?? code);

  const sessions = data.sessions ?? [];
  const runs = data.runs ?? [];
  const gaps = data.gaps ?? [];
  const experts = data.experts ?? [];
  const doctor = data.doctor;
  // 老调用方（测试、别的壳）只喂 sessions，没喂 projects：这里兜一层，
  // 让「按项目合并」这件事对所有入口都成立，而不是只在 collect() 走过时成立。
  const projects = Array.isArray(data.projects) ? data.projects : groupProjects(sessions);

  const scope = typeof data.scope === "string" && data.scope !== "" ? data.scope : undefined;
  const scopeTitle = scope === undefined ? T("全部会话", "all sessions") : `${T("会话", "session")} ${escapeHtml(shortSession(scope))}`;
  const gapNote = scope === undefined ? "" : T("（缺口队列是全局的：gaps.jsonl 不按会话记）", " (the gap queue is global: gaps.jsonl is not per-session)");

  // 语言切换必须把 session 带过去：会话页那个 iframe 里点一下 English，
  // 地址变成光秃秃的 `?lang=en`，面板就跳出当前会话的范围了。
  const otherLang = lang === "en" ? "zh" : "en";
  // 切换入口上的语言名用「当前语言」写：英文页上写 Chinese，不是写中文——
  // 正文里一个汉字都不该有（场景十就是这么断的）。
  const otherLabel = lang === "en" ? "Chinese" : "English";
  const langHref = `?lang=${otherLang}${scope === undefined ? "" : `&session=${encodeURIComponent(scope)}`}`;

  const config = data.config;
  const switches = config === undefined ? [] : Object.entries(config).filter(([, value]) => typeof value === "boolean");
  const offSwitches = switches.filter(([, value]) => value === false).map(([name]) => name);
  const stateDir = typeof data.stateDir === "string" ? data.stateDir : "";

  const overview = `<div class="bar" id="overview">
  <span class="chip">${T("版本", "version")} <b>${escapeHtml(data.version ?? pluginVersion())}</b></span>
  ${stateDir === "" ? "" : `<span class="chip" title="${escapeHtml(stateDir)}">${T("数据", "data")} <b>${escapeHtml(shortPath(stateDir))}</b></span>`}
  ${
    switches.length === 0
      ? ""
      : `<span class="chip" title="${escapeHtml(offSwitches.join(", ") || T("全部打开", "all on"))}">${T("开关", "switches")} <b>${switches.length - offSwitches.length}/${switches.length}</b>${
          offSwitches.length === 0 ? "" : ` ${T("关", "off")}: ${escapeHtml(offSwitches.join("、"))}`
        }</span>`
  }
  <span class="chip">${T("项目", "projects")} <b>${projects.length}</b></span>
  <span class="chip">${T("会话", "sessions")} <b>${sessions.length}</b></span>
  <span class="chip">${T("落空", "gaps")} <b>${gaps.length}</b></span>
  <span class="chip">${T("生成于", "generated")} <b id="gen-at">${escapeHtml(String(data.generatedAt ?? "").replace("T", " ").slice(0, 19))}</b></span>
</div>`;

  // 卡片只铺最近 8 个（一屏铺不下 9 张），但**截断必须说出来**：
  // 概览条印的是全量计数，卡片少一张而不吭声，等于让用户以为项目丢了。
  const CARD_LIMIT = 8;
  const shownProjects = projects.slice(0, CARD_LIMIT);
  const hiddenProjects = projects.length - shownProjects.length;

  // 两个项目截成同样的「…/app/docs」就分不清了（`D:/work/app/docs` 与 `E:/backup/app/docs`）。
  // 撞名的那几个多留一段，直到能分开为止——title 里有全路径，但没人会为了分辨去悬停。
  const projectNames = projects.map((group) => group.project).filter((value) => value !== undefined);
  const labelOf = (value) => {
    if (value === undefined) return "";
    for (let keep = 2; keep < 5; keep += 1) {
      const short = shortPath(value, keep);
      if (projectNames.filter((other) => shortPath(other, keep) === short).length === 1) return short;
    }
    return shortPath(value, 4);
  };

  const cards =
    projects.length === 0
      ? `<div class="empty">${T(`还没有会话进入项目模式（打开 <code>expert("intake")</code> 才会写状态）`, `No session has entered project mode yet — state is written when <code>expert("intake")</code> is opened.`)}</div>`
      : `<div class="grid">${shownProjects
          .map((group) => {
            const head =
              group.project === undefined
                ? `${T("会话", "session")} ${escapeHtml(shortSession(group.sessions[0]))}`
                : `${T("项目", "project")} ${escapeHtml(labelOf(group.project))}`;
            const headTitle = group.project === undefined ? "" : ` title="${escapeHtml(group.project)}"`;
            const more =
              group.sessions.length > 1
                ? `<div class="meta">${T("会话", "sessions")} ${group.sessions.length} ${T("个：", ": ")}${escapeHtml(
                    group.sessions.map((id) => shortSession(id)).join(lang === "en" ? ", " : "、"),
                  )}</div>`
                : "";
            return `<div class="card">
  <div class="k"${headTitle}>${head}</div>
  <div class="v phase-${escapeHtml(group.phase)}">${escapeHtml(phaseOf(group.phase))}（${escapeHtml(group.phase)}）</div>
  <div class="meta">${T("方案：", "plan: ")}${group.approved === true ? T("已确认", "confirmed") : T("待确认", "unconfirmed")}｜${T("水平：", "user: ")}${escapeHtml(levelOf(group.level))}</div>
  <div class="meta">${T("在场：", "in the room: ")}${escapeHtml(group.experts.join(lang === "en" ? ", " : "、") || T("无", "none"))}</div>
  <div class="meta">${T("自", "since")} ${escapeHtml(String(group.since ?? "").replace("T", " ").slice(0, 19))}</div>
  ${more}
  ${group.conflict ? `<div class="meta warn">${T("组内阶段不一致：有会话读不到项目文件，显示的是过期镜像", "phases disagree inside this group: some session fell back to a stale mirror")}</div>` : ""}
</div>`;
          })
          .join("")}</div>${
          hiddenProjects === 0
            ? ""
            : `<div class="empty">${T(
                `还有 ${hiddenProjects} 个项目没画（共 ${projects.length} 个）：卡片只铺最近 ${CARD_LIMIT} 个，其余的用 ?session= 打开对应会话页看`,
                `${hiddenProjects} more project(s) not drawn (${projects.length} total) — only the newest ${CARD_LIMIT} get a card; open a session page with ?session= for the rest`,
              )}</div>`
        }`;

  const expertRows =
    experts.length === 0
      ? `<tr><td colspan="6" class="empty">${T("没有扫到专家包", "no expert package found")}</td></tr>`
      : experts
          .map((expert) => {
            const triggers = Array.isArray(expert.triggers) ? expert.triggers : [];
            const missing = Array.isArray(expert.missing) ? expert.missing : [];
            return `<tr>
  <td>${escapeHtml(expert.id)}</td>
  <td>${escapeHtml(expert.name ?? "")}</td>
  <td>${escapeHtml(kindOf(expert.kind))}</td>
  <td class="num" title="${escapeHtml(triggers.join(", "))}">${triggers.length}</td>
  <td>${escapeHtml((expert.deliverables ?? []).join(lang === "en" ? ", " : "、") || "-")}</td>
  <td>${missing.length === 0 ? `<span class="phase-deliver">${T("齐全", "ok")}</span>` : escapeHtml(missing.join(lang === "en" ? ", " : "、"))}</td>
</tr>`;
          })
          .join("");

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
      ? `<tr><td colspan="7" class="empty">${T("没有落空记录", "no gaps recorded")}</td></tr>`
      : gaps
          .slice(0, 12)
          .map(
            (gap) => `<tr>
  <td>${escapeHtml(gap.text.length > 60 ? `${gap.text.slice(0, 60)}…` : gap.text)}</td>
  <td class="num">${gap.count}</td>
  <td>${escapeHtml((gap.phases ?? []).map((phase) => phaseOf(phase)).join(lang === "en" ? ", " : "、") || "-")}</td>
  <td>${escapeHtml((gap.langs ?? []).map((code) => langOf(code)).join(lang === "en" ? ", " : "、") || "-")}</td>
  <td class="num">${escapeHtml(String(gap.last ?? "").replace("T", " ").slice(0, 16) || "-")}</td>
  <td>${escapeHtml(gapSuggestion(gap, lang))}</td>
  <td class="num">${escapeHtml((gap.candidates ?? []).join(lang === "en" ? ", " : "、") || "-")}</td>
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

  return `<!doctype html>
<html lang="${lang === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${T("能力路由 · 面板", "capability-router · panel")}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${T("能力路由 · 面板", "capability-router · panel")} <span class="meta">${scopeTitle}</span> <a class="meta" href="${escapeHtml(langHref)}">${otherLabel}</a></h1>
${overview}

<h2>${T("项目阶段", "project phase")}</h2>
<div id="projects">${cards}</div>

<h2>${T("专家名册", "expert roster")}</h2>
<div id="experts"><table>
  <tr><th>${T("专家", "expert")}</th><th>${T("名称", "name")}</th><th>${T("类别", "kind")}</th><th>${T("触发词", "triggers")}</th><th>${T("该产出", "deliverables")}</th><th>${T("缺必装", "missing")}</th></tr>
  ${expertRows}
</table></div>

<h2>${T("最近 25 句", "last 25 prompts")}</h2>
<div id="runs"><table>
  <tr><th>${T("时间", "time")}</th><th>${T("会话", "session")}</th><th>${T("阶段", "phase")}</th><th>${T("命中", "routing")}</th><th>${T("注入", "injected")}</th></tr>
  ${runRows}
</table></div>

<h2>${T("缺口队列", "gap queue")}<span class="meta">${gapNote}</span></h2>
<div id="gaps"><table>
  <tr><th>${T("原话", "said")}</th><th>${T("次数", "count")}</th><th>${T("阶段", "phase")}</th><th>${T("语言", "lang")}</th><th>${T("最近", "last")}</th><th>${T("结论", "verdict")}</th><th>${T("候选", "candidates")}</th></tr>
  ${gapRows}
</table></div>

<h2>${T("技能供给", "skill supply")}</h2>
<div id="doctor">${doctorBlock}</div>
<script>
(function () {
  // 轮询同一页，只换区块内容：整页刷新会把滚动位置打回顶部，
  // 服务端仍是唯一渲染实现（不在浏览器里复制一套渲染逻辑）。
  var url = location.pathname + location.search;
  var ids = ["overview", "projects", "experts", "runs", "gaps", "doctor"];
  function tick() {
    if (document.hidden) return;
    fetch(url, { cache: "no-store" })
      .then(function (response) { return response.text(); })
      .then(function (html) {
        var next = new DOMParser().parseFromString(html, "text/html");
        for (var index = 0; index < ids.length; index += 1) {
          var before = document.getElementById(ids[index]);
          var after = next.getElementById(ids[index]);
          if (before && after && before.innerHTML !== after.innerHTML) before.innerHTML = after.innerHTML;
        }
      })
      .catch(function () { /* 面板挂了不该影响宿主，静默重试 */ });
  }
  setInterval(tick, 8000);
})();
</script>
</body>
</html>
`;
}
