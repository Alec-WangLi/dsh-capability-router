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

    function panelFrame(tall) {
      return React.createElement("iframe", {
        src: PANEL_PATH,
        title: "能力路由 · 面板",
        style: {
          width: "100%",
          height: tall ? "calc(100vh - 180px)" : "560px",
          minHeight: "420px",
          border: "0",
          borderRadius: "6px",
          background: "#14161a",
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
          function SessionPanel() {
            return panelFrame(true);
          },
        );
      });
    }

    module.exports = { apply: apply, inject: inject };
    return module.exports;
  },
});
