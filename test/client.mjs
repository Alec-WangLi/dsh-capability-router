import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * client 半边（`client/index.js`）的测试。
 *
 * 这个文件不是 ESM，是宿主加载器要的 `window.__ModuleLoader__.load(...)` 格式，
 * 所以不能在测试里直接 import——把它当源码跑一遍，用一个假的 window 收下 factory。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "client", "index.js"), "utf8");

/** 跑一遍 bundle，返回它交给加载器的东西。 */
function loadBundle() {
  let loaded;
  const fakeWindow = { __ModuleLoader__: { load: (entry) => (loaded = entry) } };
  new Function("window", SOURCE)(fakeWindow);
  assert.ok(loaded !== undefined, "应当调用 __ModuleLoader__.load");
  assert.equal(loaded.id, "dsh-capability-router", "id 必须是包名");

  const elements = [];
  const fakeReact = {
    createElement(type, props) {
      elements.push({ type, props });
      return { type, props };
    },
  };
  const module = loaded.factory((name) => {
    assert.equal(name, "react", "只从宿主取 react，别的不该 require");
    return fakeReact;
  });
  return { module, elements, entry: loaded };
}

// 场景一：bundle 暴露 apply 与 inject，注入的服务只有 slots
{
  const { module } = loadBundle();
  assert.equal(typeof module.apply, "function");
  assert.deepEqual(module.inject, ["slots"], "只要 slots，别把无关服务挂成依赖");
}

// 场景二：两个 slot 都注册了，key / id 用的是自己的
{
  const { module, elements } = loadBundle();
  const registered = [];
  const ctx = {
    slots: {
      inject(_name, factory) {
        factory();
      },
      register(options, Component) {
        registered.push({ options, Component });
        return () => {};
      },
    },
  };
  module.apply(ctx);

  assert.equal(registered.length, 2, "插件详情页与会话页各一个");
  const byName = Object.fromEntries(registered.map((row) => [row.options.name, row]));
  assert.equal(byName["plugins.bundle.config"].options.key, "dsh-capability-router", "key 必须等于包名");
  assert.equal(byName["conversation.view"].options.id, "capability-router", "id 用自己的，别顶掉宿主的格子");
  assert.ok(byName["conversation.view"].options.order > 0);

  // 标签是 thunk：宿主切换语言时能重读
  const label = byName["conversation.view"].options.label;
  assert.equal(typeof label, "function");
  assert.equal(label(), "编排");
}

// 场景三：插件详情页的 iframe 不带会话；会话页的 iframe 带 ?session=
{
  const { module, elements } = loadBundle();
  const registered = [];
  const ctx = {
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, Component) => {
        registered.push({ options, Component });
        return () => {};
      },
    },
  };
  module.apply(ctx);

  const bundleSlot = registered.find((row) => row.options.name === "plugins.bundle.config");
  bundleSlot.Component({ sessionId: "session-abc" });
  const sessionSlot = registered.find((row) => row.options.name === "conversation.view");
  sessionSlot.Component({ sessionId: "session-abc" });

  const iframes = elements.filter((row) => row.type === "iframe");
  assert.equal(iframes.length, 2);
  assert.equal(iframes[0].props.src, "/capability-router/panel", "详情页看全部");
  assert.equal(iframes[1].props.src, "/capability-router/panel?session=session-abc", "会话页只看这一个");
  assert.ok(iframes.every((row) => row.props.title.includes("能力路由")));
}

// 场景四：拿不到 sessionId 时退化成不带的地址，而不是拼出 undefined
{
  const { module, elements } = loadBundle();
  const registered = [];
  module.apply({
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, Component) => {
        registered.push({ options, Component });
        return () => {};
      },
    },
  });
  registered.find((row) => row.options.name === "conversation.view").Component(undefined);
  registered.find((row) => row.options.name === "conversation.view").Component({});
  const iframes = elements.filter((row) => row.type === "iframe");
  assert.deepEqual(
    iframes.map((row) => row.props.src),
    ["/capability-router/panel", "/capability-router/panel"],
  );
}

console.log("场景一 暴露与依赖      ✓");
console.log("场景二 两个 slot       ✓");
console.log("场景三 会话就地带参数  ✓");
console.log("场景四 缺参数退化      ✓");
console.log("client 半边测试通过");
