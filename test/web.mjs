import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PANEL_PATH, STATE_PATH, attachWebPanel, panelRoutes, snapshot } from "../lib/web.js";

/**
 * 宿主侧面板路由的测试：形状对不对（exact + 路径）、响应能不能拿、挂载失败会不会炸。
 * 不起真 HTTP 服务——`webServer.register` 收的是 (req,res) 处理器，用假的就够了。
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-web-"));
const stateDir = path.join(tmp, "capability-router");
fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
fs.writeFileSync(
  path.join(stateDir, "runs.jsonl"),
  `${JSON.stringify({ at: "2026-11-01T12:00:00.000Z", session: "s1", phase: "spec", rout: "miss", injected: ["capability-router-state"] })}\n`,
  "utf8",
);
fs.writeFileSync(
  path.join(stateDir, "sessions", "s1.json"),
  JSON.stringify({ sessionId: "s1", phase: "spec", experts: ["intake"], since: "2026-11-01T11:00:00.000Z" }),
  "utf8",
);

function fakeResponse() {
  const out = { status: 0, headers: {}, body: "" };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers ?? {};
    },
    end(body) {
      out.body = String(body ?? "");
    },
  };
}

const options = { stateDir, dshHome: tmp };

// 场景一：两条路由，都是 exact，路径与常量一致
{
  const routes = panelRoutes(options);
  assert.equal(routes.length, 2);
  assert.deepEqual(routes.map((route) => route.path).sort(), [PANEL_PATH, STATE_PATH].sort());
  assert.ok(routes.every((route) => route.kind === "exact"), "精确路由，避免抢占别的路径");
  assert.ok(routes.every((route) => typeof route.handler === "function"));
}

// 场景二：/api/state 返回 JSON——会话、runs、体检都在
{
  const route = panelRoutes(options).find((row) => row.path === STATE_PATH);
  const response = fakeResponse();
  route.handler({ url: STATE_PATH }, response);
  assert.equal(response.out.status, 200);
  assert.match(response.out.headers["content-type"], /application\/json/);
  const body = JSON.parse(response.out.body);
  assert.equal(body.sessions[0].phase, "spec");
  assert.equal(body.runs.length, 1);
  assert.ok(body.doctor !== undefined, "体检结果一起给出去");
  assert.ok(Array.isArray(body.experts) && body.experts.length > 0, "专家清单给 client 半边用");
}

// 场景三：/panel 返回 HTML——四个区块都在，且不缓存
{
  const route = panelRoutes(options).find((row) => row.path === PANEL_PATH);
  const response = fakeResponse();
  route.handler({ url: PANEL_PATH }, response);
  assert.equal(response.out.status, 200);
  assert.match(response.out.headers["content-type"], /text\/html/);
  assert.equal(response.out.headers["cache-control"], "no-store");
  for (const section of ["会话阶段", "最近 25 步", "缺口队列", "技能供给"]) {
    assert.ok(response.out.body.includes(section), `缺区块：${section}`);
  }
}

// 场景四：snapshot 直接调用也成立（client 侧或别的壳可以复用）
{
  const data = snapshot(options);
  assert.equal(data.sessions.length, 1);
  assert.equal(data.experts.length, 7, "仓库自带七个专家包");
}

// 场景五：挂载——注册两条路由；某条注册失败只告警，不影响另一条
{
  const registered = [];
  const warnings = [];
  const ctx = {
    effect(factory) {
      factory();
    },
    webServer: {
      register(route) {
        if (route.path === STATE_PATH) throw new Error("boom");
        registered.push(route.path);
        return () => {};
      },
    },
  };
  assert.doesNotThrow(() => attachWebPanel(ctx, options, (message) => warnings.push(message)));
  assert.deepEqual(registered, [PANEL_PATH], "一条失败不该带走另一条");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /面板路由注册失败/);

  const ok = { effect: (factory) => factory(), webServer: { register: (route) => registered.push(route.path) } };
  attachWebPanel(ok, options, () => {});
  assert.ok(registered.includes(PANEL_PATH) && registered.includes(STATE_PATH));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("场景一 路由形状      ✓");
console.log("场景二 快照接口      ✓");
console.log("场景三 页面接口      ✓");
console.log("场景四 snapshot      ✓");
console.log("场景五 挂载容错      ✓");
console.log("面板路由测试通过");
