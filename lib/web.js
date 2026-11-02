/**
 * 面板的宿主侧路由：把 `lib/panel.js` 那份快照挂到 DSH 自己的 Web 服务上。
 *
 * 为什么不用 `tools/panel.mjs` 那个独立进程：同一个源、同一个端口意味着
 * ① 浏览器不用跨域；② 远程访问时地址天然正确（独立进程的 127.0.0.1 在用户机器上指向用户自己）；
 * ③ 面板与插件同版本，不会出现「壳是新的、数据是旧的」。
 *
 * `tools/panel.mjs` 仍然有用：不启动 DSH 也能看，命令行里排查最省事。
 */

import { checkSupply } from "./doctor.js";
import { expertDirs, scanExperts } from "./experts.js";
import { collect, foldRuns, renderHtml } from "./panel.js";
import { defaultSkillDirs, discoverSkills } from "./skills.js";

/** 面板页面路径（client 半边 iframe 直接用它）。 */
export const PANEL_PATH = "/capability-router/panel";
/** 快照接口路径。 */
export const STATE_PATH = "/capability-router/api/state";

/**
 * 现读现算一份快照——路由是旁路，不加缓存，面板显示的永远是刚刚发生的事。
 * @param {{stateDir: string, dshHome: string, extraSkillDirs?: string[]}} options
 * @returns {object}
 */
export function snapshot(options) {
  const { stateDir, dshHome, extraSkillDirs = [], sessionId } = options;
  const { experts } = scanExperts({ dirs: expertDirs(stateDir) });
  const installed = discoverSkills(defaultSkillDirs(dshHome, extraSkillDirs));
  const doctor = checkSupply(experts, new Set(installed.keys()));
  const data = collect(stateDir, {
    sessionId,
    doctor,
    experts: experts.map((expert) => ({ id: expert.id, name: expert.name, kind: expert.kind })),
  });
  // 接口给的是「一句一行」，不是「一步一行」。
  //
  // `runs.jsonl` 每步一行是设计如此（面板靠它算步数），但同一句话跑 55 步就有 55 行——
  // 原样吐给接口，实测 2000 行时约 550 KB，而里面至少一半是同一句话的重复。
  // 消费侧需要的正是折叠后的形状：每句一行、带 steps。原始行留在文件里，
  // 要按步核对用 `tools/match.mjs` 那条路（它读 `readRuns()`，口径没有被这里改掉）。
  return { ...data, runs: foldRuns(data.runs).slice(-200) };
}

/** 从请求里取会话范围：`?session=<id>`。取不到就当没传。 */
export function sessionFromUrl(url) {
  try {
    const parsed = new URL(String(url ?? "/"), "http://127.0.0.1");
    const value = parsed.searchParams.get("session");
    return value === null || value.trim() === "" ? undefined : value.trim();
  } catch {
    return undefined;
  }
}

/**
 * 面板语言从 URL 来（`?lang=en`），默认中文。
 * 不给它读浏览器头：宿主可能压根没有头可读，而且「谁在看」比「浏览器说什么」更准确——
 * 同一个浏览器，人在两种语言之间切，靠的是这个参数不是 Accept-Language。
 */
function langFromUrl(url) {
  const text = String(url ?? "");
  const match = /[?&]lang=([^&]+)/.exec(text);
  return match !== null && decodeURIComponent(match[1]).toLowerCase().startsWith("en") ? "en" : "zh";
}

function send(response, status, contentType, body) {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

/**
 * 两条路由：页面与快照。
 * @param {{stateDir: string, dshHome: string, extraSkillDirs?: string[]}} options
 * @returns {{kind: string, path: string, handler: (req: unknown, res: any) => void}[]}
 */
export function panelRoutes(options) {
  return [
    {
      kind: "exact",
      path: STATE_PATH,
      handler: (request, response) => {
        try {
          const scoped = { ...options, sessionId: sessionFromUrl(request?.url) };
          send(response, 200, "application/json; charset=utf-8", JSON.stringify(snapshot(scoped), null, 2));
        } catch (error) {
          send(response, 500, "application/json; charset=utf-8", JSON.stringify({ error: String(error?.message ?? error) }));
        }
      },
    },
    {
      kind: "exact",
      path: PANEL_PATH,
      handler: (request, response) => {
        try {
          const scoped = { ...options, sessionId: sessionFromUrl(request?.url) };
          send(response, 200, "text/html; charset=utf-8", renderHtml(snapshot(scoped), langFromUrl(request?.url)));
        } catch (error) {
          send(response, 500, "text/plain; charset=utf-8", `面板渲染失败：${error?.message ?? error}\n`);
        }
      },
    },
  ];
}

/**
 * 把路由挂到宿主 Web 服务上。注册失败只记告警——面板挂不上不该影响插件本体。
 * @param {any} ctx cordis 上下文
 * @param {object} options 见 panelRoutes
 * @param {(message: string) => void} warn
 */
export function attachWebPanel(ctx, options, warn) {
  for (const route of panelRoutes(options)) {
    try {
      ctx.effect(() => ctx.webServer.register(route), `capability-router: ${route.path}`);
    } catch (error) {
      warn?.(`面板路由注册失败 ${route.path} ${error?.message ?? error}`);
    }
  }
}
