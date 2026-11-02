import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessions } from "../lib/panel.js";
import { PANEL_PATH, STATE_PATH, attachWebPanel, panelRoutes, sessionFromUrl, snapshot } from "../lib/web.js";

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

  // A13：每个会话项都要带 level 与 approved。
  // 这条有个坑：JSON.stringify 会把值为 undefined 的键整个丢掉，所以「未判定」必须
  // 显式写成 null 才算「带上了」——留空的话 client 那边拿到的对象里根本没这个键。
  for (const item of body.sessions) {
    assert.ok(Object.hasOwn(item, "level"), `会话 ${item.sessionId} 缺 level 键`);
    assert.ok(Object.hasOwn(item, "approved"), `会话 ${item.sessionId} 缺 approved 键`);
    assert.equal(typeof item.approved, "boolean", "approved 必须是 JSON 布尔");
    assert.ok(
      [null, "novice", "pro"].includes(item.level),
      `level 只能是 null / novice / pro，实际 ${JSON.stringify(item.level)}`,
    );
  }
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
  assert.equal(data.experts.length, 10, "仓库自带十个专家包（v0.20.0 加了 research / reverse / qa）");
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

// 场景六：?session= 解析——空值/怪值当没传；路由按它过滤
{
  assert.equal(sessionFromUrl("/capability-router/panel?session=s1"), "s1");
  assert.equal(sessionFromUrl("/capability-router/panel?session=%20%20"), undefined, "空白当没传");
  assert.equal(sessionFromUrl("/capability-router/panel"), undefined);
  assert.equal(sessionFromUrl("::not a url::"), undefined, "坏 url 不炸");

  const route = panelRoutes(options).find((row) => row.path === STATE_PATH);
  const response = fakeResponse();
  route.handler({ url: `${STATE_PATH}?session=s1` }, response);
  const body = JSON.parse(response.out.body);
  assert.equal(body.scope, "s1");
  assert.ok(body.sessions.every((row) => row.sessionId === "s1"));

  const htmlResponse = fakeResponse();
  panelRoutes(options).find((row) => row.path === PANEL_PATH).handler({ url: `${PANEL_PATH}?session=s1` }, htmlResponse);
  assert.match(htmlResponse.out.body, /会话 s1/);
}

// 场景七（A13）：带水平与确认状态的会话，两个字段要原样透出（真走一遍 JSON 序列化）
{
  const stateDir2 = path.join(tmp, "capability-router-v2");
  fs.mkdirSync(path.join(stateDir2, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir2, "sessions", "s9.json"),
    JSON.stringify({
      sessionId: "s9",
      phase: "build",
      experts: ["intake"],
      level: "novice",
      approved: true,
      since: "2026-11-01T10:00:00.000Z",
    }),
    "utf8",
  );

  const direct = snapshot({ stateDir: stateDir2, dshHome: tmp });
  assert.equal(direct.sessions.length, 1);
  assert.equal(direct.sessions[0].level, "novice", "level 要透出到快照");
  assert.equal(direct.sessions[0].approved, true, "approved 要透出到快照");

  const route = panelRoutes({ stateDir: stateDir2, dshHome: tmp }).find((row) => row.path === STATE_PATH);
  const response = fakeResponse();
  route.handler({ url: STATE_PATH }, response);
  const item = JSON.parse(response.out.body).sessions[0];
  assert.equal(item.level, "novice", "序列化之后 level 还在");
  assert.equal(item.approved, true, "序列化之后 approved 还在");
  assert.ok(Object.hasOwn(item, "level") && Object.hasOwn(item, "approved"), "两个键都要在 JSON 里，不能是 undefined 被丢掉");
}

// 场景八（A13 反向）：老形状的会话记录经过 readSessions() 之后也要补齐两个字段。
// 理由：面板前端不该为「这个字段可能不存在」写分支。approved 必须是布尔 false 而不是
// undefined；level 未判定时给 null（undefined 在 JSON 里会整条键消失，等于没给）。
{
  const rows = readSessions(path.join(stateDir, "sessions"));
  const legacy = rows.find((row) => row.sessionId === "s1");
  assert.ok(legacy, "应读到老形状的 s1");
  assert.equal(legacy.approved, false, "老记录也要给出布尔 false，不能是 undefined");
  assert.notEqual(legacy.approved, undefined);
  assert.equal(legacy.level, null, "level 未判定时显式给 null");
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("场景一 路由形状      ✓");
console.log("场景二 快照接口      ✓");
console.log("场景三 页面接口      ✓");
console.log("场景四 snapshot      ✓");
console.log("场景五 挂载容错      ✓");
console.log("场景六 会话参数      ✓");
console.log("场景七 水平与确认    ✓");
console.log("场景八 老记录补字段  ✓");
console.log("面板路由测试通过");
