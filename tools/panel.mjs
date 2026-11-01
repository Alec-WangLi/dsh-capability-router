#!/usr/bin/env node
/**
 * 只读面板：把 runs.jsonl / sessions/*.json / gaps.jsonl 和技能体检渲染成一页。
 *
 * 用法：
 *   node tools/panel.mjs                # 127.0.0.1 随机端口
 *   node tools/panel.mjs --port 7788
 *   node tools/panel.mjs --dir D:/skills   # 额外扫技能目录（可重复）
 *
 * 端点：
 *   /            页面（5 秒自动刷新）
 *   /api/state   JSON 快照，给别的壳（将来的 GUI client 半边）直接用
 *   /health      纯文本 ok，给守护脚本用
 *
 * 只读、只听 loopback、不写任何文件。面板挂了不影响插件——它是旁路。
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { checkSupply } from "../lib/doctor.js";
import { expertDirs, scanExperts } from "../lib/experts.js";
import { collect, renderHtml } from "../lib/panel.js";
import { defaultSkillDirs, discoverSkills } from "../lib/skills.js";

const argv = process.argv.slice(2);

function take(flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} 缺少参数`);
    process.exit(2);
  }
  argv.splice(at, 2);
  return value;
}

const extraDirs = [];
for (let value = take("--dir"); value !== undefined; value = take("--dir")) {
  if (!path.isAbsolute(value)) {
    console.error(`--dir 需要绝对路径：${value}`);
    process.exit(2);
  }
  extraDirs.push(value);
}

const portArg = take("--port");
const port = portArg === undefined ? 0 : Number(portArg);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`--port 不合法：${portArg}`);
  process.exit(2);
}

if (argv.length > 0) {
  console.error(`未知参数：${argv.join(" ")}`);
  process.exit(2);
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const STATE_DIR = path.join(DSH_HOME, "capability-router");

/** 每次请求重新读一遍：面板要能显示刚刚发生的事，不做缓存。 */
function snapshot() {
  const { experts } = scanExperts({ dirs: expertDirs(STATE_DIR) });
  const installed = discoverSkills(defaultSkillDirs(DSH_HOME, extraDirs));
  const doctor = checkSupply(experts, new Set(installed.keys()));
  return collect(STATE_DIR, { doctor, experts: experts.map((expert) => ({ id: expert.id, name: expert.name, kind: expert.kind })) });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/api/state") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(snapshot(), null, 2));
      return;
    }
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderHtml(snapshot()));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`面板渲染失败：${error?.message ?? error}\n`);
  }
});

server.listen(port, "127.0.0.1", () => {
  const actual = server.address().port;
  console.log(`能力路由面板：http://127.0.0.1:${actual}`);
  console.log(`数据目录：${STATE_DIR}`);
  console.log("只读 · Ctrl+C 退出");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
