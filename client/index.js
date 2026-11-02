// 浏览器半边：在插件的两个 slot 上各挂一个 iframe，指向宿主 Web 服务里的面板页。
//
// 形状照宿主 `@deepseek-ai/dsh-client-modules` 的加载约定来：
//   window.__ModuleLoader__.load({ id, factory: (require) => (§ 模块) })
// `require("react")` 由宿主提供，不需要打包 React，也不需要构建步骤——
// 这个文件就是产物，改完重装插件即可生效（`dsh.client.platform = "web"` + exports["./client"]）。
window.__ModuleLoader__.load({
  id: "dsh-capability-router",
  factory: function (require) {
    var module = { exports: {} };
    var React = require("react");

    var inject = ["slots"];
    var PANEL_PATH = "/capability-router/panel";

    function panelFrame(tall, sessionId) {
      // 会话页那格只该看当前会话：把 sessionId 带进地址，面板自己过滤。
      var src = typeof sessionId === "string" && sessionId !== ""
        ? PANEL_PATH + "?session=" + encodeURIComponent(sessionId)
        : PANEL_PATH;
      return React.createElement("iframe", {
        src: src,
        title: "能力路由 · 面板",
        style: {
          width: "100%",
          height: tall ? "calc(100vh - 180px)" : "560px",
          minHeight: "420px",
          border: "0",
          borderRadius: "6px",
          // 不要写死底色：面板自己按 prefers-color-scheme 选浅色/深色，
          // 这里钉一个 #14161a 就等于在浅色系统上给 iframe 镶一圈黑边。
          background: "transparent",
          colorScheme: "light dark",
        },
      });
    }

    function apply(ctx) {
      // 插件详情页：key 必须是包名，否则这一格不会指向我们。
      ctx.slots.inject("plugins.bundle.config", function () {
        return ctx.slots.register(
          { name: "plugins.bundle.config", key: "dsh-capability-router" },
          function BundlePanel() {
            return panelFrame(false);
          },
        );
      });

      // 会话页顶栏：id 用自己的，复用宿主的 id 会顶掉它那一格。
      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register(
          { name: "conversation.view", id: "capability-router", order: 40, label: function () { return "编排"; } },
          function SessionPanel(props) {
            return panelFrame(true, props && props.sessionId);
          },
        );
      });
    }

    module.exports = { apply: apply, inject: inject };
    return module.exports;
  },
});
