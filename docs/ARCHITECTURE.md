# 架构 v2：项目级专家编排

> 状态：**待确认的基准稿**，尚未动代码。
> 本文取代 [DESIGN.md](../DESIGN.md) 第二～三节的架构假设，其余章节（宿主实测、坑）仍然有效。
> 写作时间：2026-11-01

---

## 一、定位变了

| | v1（现在，v0.6.0） | v2（本文） |
|---|---|---|
| 单位 | 一条用户消息 | 一个项目 |
| 插件的角色 | 替模型裁决「这算谁的活」 | 提供专家目录、状态事实、阶段闸门 |
| 专家 | 注入一段角色的提示词 | 有交付物、有上游输入、有技能依赖的承包方 |
| 决策权 | 插件（规则匹配） | 模型 |
| 技能 | 按专家动态收窄 | 不隐藏，按依赖声明做供给检查 |

一句话：**v1 是个提示器，v2 是个接单台。**

---

## 二、验收场景（先定「做到什么算对」）

拿你说的视频监控软件当基准场景，v2 成立的条件是这一条链能自己跑完：

```text
用户：我要做一个视频监控软件

intake    → 问 ≤3 个关键决策（存储本地还是云、要不要人形检测、部署形态），
            其余自己定并写进「假设」
          → 产出 REQUIREMENTS.md（目标 / 范围 / 验收标准 / 不做什么）
          → 产出 TASKS.md（任务卡：谁做、输入、输出、依赖、验收）
用户：确认
backend   → 接口与数据模型，落盘到项目目录
frontend  → 界面与交互，接 backend 的接口契约
review    → 按 REQUIREMENTS.md 的验收标准逐条收口，不合格打回
intake    → 交付清单给用户
```

全程用户只说两句话：需求 + 确认。中间不催、不解释、不汇报进度。

反例同样要成立：「今天中午吃什么」不能触发任何专家、不能产生任何项目状态。

---

## 三、五个部件

```text
①  专家目录        常驻系统提示，稳定不变，每行一个专家
②  expert() 工具   模型按需拉完整 role.md / 技能清单 / 交付契约
③  会话状态        阶段、在场专家、当前任务卡、需求产物路径
④  阶段闸门        spec 未确认时，实现类专家不得上场（提示级）
⑤  记录层          runs.jsonl / gaps.jsonl / doctor（技能依赖体检）
```

### ① 专家目录：放系统提示，不放 pre-step

```text
## 可用专家
intake   接单：把模糊需求收敛成需求与任务卡。任何项目的第一站。
backend  后端：接口、数据模型、并发、服务边界。
frontend 前端：界面、交互、样式、浏览器行为。
review   审查：按验收标准收口，不说「整体不错」。
debug    排障：报错、崩溃、不生效、性能。
data     数据与办公：表格、报表、演示、PDF。
docs     文档：读得懂、能照做的那一层。
```

放 `ctx.systemPrompt.section()` 的理由是成本：目录**稳定不变**，放在系统提示里等于进了稳定前缀，prefix cache 一次命中、后面全复用。放 pre-step 则每轮重发一遍，还挤占用户消息旁边的注意力。

每个专家只占一行：**名字 + 何时找我 + 我交什么**。详情靠 ②。

### ② `expert(name)` 工具：已落地（未用 `defineTool`）

宿主给插件留了工具注册口：

```js
import { defineTool } from "@deepseek-ai/dsh-tools";

const inject = ["tools"];
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "expert",
    description: "读取某个领域专家的完整角色说明、技能清单与交付契约。需要某个领域的人干活前先调它。",
    parameters: { name: { type: "string", description: "专家 id，见「可用专家」清单" } },
    output: { schema: { type: "object", additionalProperties: false, properties: { /* … */ } } },
    async execute(args, exec) { /* 读 experts/<id>/role.md 等 */ },
  }));
}
```

- 出处：`@deepseek-ai/dsh-tools/lib/index.js:838`（`defineTool`），注册方式 `ctx.tools.register(...)`
- 现成范例：`@deepseek-ai/dsh-experimental-tool-worktree/lib/index.js:13`

返回内容分三段：`role.md` 全文、技能清单（含是否已安装）、交付契约（输出什么文件、什么形状）。

为什么不让 7 个 `role.md` 全常驻：每个约 400 字，七份就是 2800 字，且大部分和当轮无关。按需取一次只花一个工具调用。

### ③ 会话状态

```js
{
  phase: "idle" | "intake" | "spec" | "build" | "review" | "deliver",
  project: "<项目目录绝对路径>" | null,
  experts: ["intake", "backend"],        // 本会话已加载过的专家
  task: "<当前任务卡 id>" | null,
  specConfirmed: false,
  updatedAt: "…"
}
```

落在 `<DSH_HOME>/capability-router/sessions/<sessionId>.json`，键取 `agent` 上的会话身份（`agent/pre-step` 的 payload 带 `agent`，出处 `dsh-agent/lib/index.js:193`；具体字段实现时确认）。

不存进会话消息：状态要能被插件读写、被你用面板看，且在压缩掉上下文之后依然存在。

### ④ 阶段闸门：提示级，不是拦截

```text
idle      任何专家都可以上场（闲聊、单次提问走这条）
intake    只该有 intake 在场
spec      需求产物已写，等用户确认
build     specConfirmed === true 才允许实现类专家上场
review    有交付物，按验收标准收口
deliver   交付清单
```

**能力边界的如实说明**：宿主没有给插件「拦截工具调用」的钩子，所以我们拦不住模型直接写代码。闸门能做到的是：状态不对时，每轮注入一句事实——

```text
【能力路由 · 阶段】
当前阶段 spec：需求尚未确认。实现类专家不得上场。
产物：<项目目录>/REQUIREMENTS.md（已存在，未确认）
```

这比硬拦弱，但比没有强，而且不需要越权。真要硬拦，得包一层 `tools.register` 的 wrapper 在工具层拒绝——那是 v2.1 的事，且会跟用户自己的工具调用打架。

### ⑤ 记录层

| 文件 | 内容 | 用途 |
|---|---|---|
| `runs.jsonl` | 每轮：阶段、在场专家、命中的任务卡、注入的是目录还是状态卡 | 面板的数据源 |
| `gaps.jsonl` | 沿用 v1，落空的原话 | 决定下一个专家造什么 |
| `sessions/<id>.json` | 会话状态快照 | 重启后恢复、面板展示 |

---

## 四、专家包格式 v2

`expert.yml` 在 v1 字段上增加五个（都可选，不写就是普通专家）：

```yaml
name: 接单专家
description: 把模糊需求收敛成需求文档与任务卡，并分派给其他专家
kind: intake                            # intake | worker | reviewer（默认 worker）
triggers: [做个, 开发, 搭建, 实现, 需求, 项目]
handoff: [backend, frontend, review]    # 我通常把活交给谁
deliverables: [REQUIREMENTS.md, TASKS.md]
skills:                                 # 一条依赖写一行：YAML 子集只支持一层流式映射
  - {name: doc-coauthoring, required: true, source: local}
  - {name: writing-plans, required: false, source: host}
```

`source` 取 `host`（跟着 DSH 装，体检不查）/ `local`（`~/.dsh/skills`，逐个数）/ `unknown`（老写法默认值，按缺失报）。

`skills` 从「字符串数组」变成「依赖声明」：

- `required: true` 缺了就报错（在 doctor 里，不阻断加载）
- `source` 记来源，供 doctor 提示「这个技能不是本插件带的，去装」
- **永不把技能源码复制进本包**。安装落在用户自己的技能目录，后续由 DSH 技能管理器统一升级，插件只读。

v1 的 `skills: [a, b]` 仍然能解析（当 `required: false` 且 `source: unknown`），不破坏已有专家包。

---

## 五、运行时：一条消息进来

```text
apply():
  if (!enabled) return
  ctx.systemPrompt.section(专家目录 + 协议)      // ① 稳定前缀
  ctx.tools.register(expert())                  // ② 按需取详情（直接给 register 的形状，不 import defineTool）
  ctx.effect(() => ctx.skills.register(selfSkill))
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next() ?? payload
    const state = loadSession(payload.agent)     // ③
    if (state.phase !== "idle") 追加 状态卡（阶段 + 任务 + specConfirmed）
    if (state.phase === "idle" && hint) 追加 检查点（v1 那句，仅非项目模式）
    记 runs.jsonl
  })
```

三条与 v1 的差别：

1. **不再替模型判专家**。规则匹配退成「目录里加一句提示」的可选能力（见第七节）。
2. **检查点降级**。项目模式下只剩状态卡，避免「检查点说该问一句、接单专家说先出文档」两条协议对喊。
3. **状态从哪来**：模型通过 `expert()` 与写文件改变它。插件不猜阶段，只读事实——`REQUIREMENTS.md` 存在且用户确认过（模型显式调用 `expert("intake", {phase:"build"})` 或写 `state.json`）才进 build。

---

## 六、收窄（`narrow`）退役

> **第 1 步已执行（v0.7.0）**：`narrow`/`alwaysVisible` 配置、`lib/narrow.js`、`test/narrow.mjs` 已删除，`test/route.mjs` 反过来断言「路由不碰技能目录」。场景数 62 → 54，七套全绿。

| | 决定 |
|---|---|
| `lib/narrow.js` | **删除**（147 行） |
| `test/narrow.mjs` | 删除（8 场景） |
| 配置 `narrow` / `alwaysVisible` | 两个都删（`alwaysVisible` 只服务收窄，留着是死配置；真需要会话级白名单时用新名字重开） |
| 替代 | `role.md` 里写技能路由 + 目录里标注推荐（标注需宿主支持，待核实） |

理由写在上一轮对话里，核心三条：语义错（收窄服务的是会话不是单条消息）、成本高（全量重发 + cache 重算 + 每条告警）、效果假（真机只收起 8/49，且只对插件层生效）。

删掉它同时删掉一类解释成本：以后不用再向任何人解释「为什么我的技能不见了」。

---

## 七、匹配器降级

保留 `lib/router.js`，但结论从「裁决」变成「提示」：

```text
hit(multi) → 目录区末尾加一句：这句话涉及 backend、frontend
ambiguous  → 加一句：可能是 A 或 B
miss       → 加一句：没有对口专家（并记账）
```

新增 `multi` 结论：最高分 ≥ 1.0 且第二名 ≥ 1.0 且分差 < 0.35 时，报多个而不是 ambiguous。v1 把「跨领域项目」误判成「分不清」，是它最明显的错。

匹配器的价值从「选人」变成「提醒模型这活有多宽」。

---

## 八、技能供给：不内置，只做体检

```bash
npm run doctor     # 或 node tools/doctor.mjs
```

```text
专家技能依赖体检
  intake     缺 0/2   ✓
  backend    缺 2/3   ✗ writing-plans(必需) · mcp-builder(可选)
  frontend   缺 0/5   ✓

缺失的技能需要你自己装（插件不打包第三方技能，避免版本僵死）：
  writing-plans  →  在 DSH 技能面板搜索安装，或 agentskill.sh 安装 writing-plans
装完重跑 npm run doctor 确认。
```

三条硬规则：

1. **插件包里只有专家定义，没有任何第三方技能源码。** 你要的是「跟着上游更新」，内置就等于冻结。
2. **doctor 只报不装**（v2 范围内）。一键安装涉及往用户技能目录写东西，等 skill 安装入口确认后再做，否则会造出第二个「不受管的副本」——这正是之前 `~/.dsh/plugins` 那次收拾过的烂摊子。
3. **来源可查**：`source` 字段写清这技能从哪来，未来做更新检查时才有依据。

---

## 九、GUI：做在插件详情页和会话页（机制已核实）

**参照 billion-context**（本机已装，同一套宿主）：

| 它怎么做的 | 证据 |
|---|---|
| `package.json` 里 `"dsh": { "bundle": {…}, "client": { "platform": "web" } }`，`exports["./client"]` 指向浏览器半边 | `billion-context/package.json` |
| 浏览器半边就是一个 cordis 插件：`inject = ["slots", "locale"]`，`ctx.slots.inject(名, () => ctx.slots.register({…}, 组件))` | `dist/agent/dsh-native-client.js:32、740-760` |
| 挂了四个 slot：`settings.section`、`plugins.bundle.config`（key = 包名）、`conversation.view`（就是「对话/轨迹/上下文」那排 tab）、`shell.overlay` | 同上 |
| **数据不走宿主 RPC**：自己起本地 HTTP（`127.0.0.1:<port>/__bili/`），slot 里放的是 iframe，套自己的页面；「打开 Web UI」直接开这个地址 | `:671` |

宿主这套 slot 契约是内嵌在 `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 里的（每个 slot 的 kind / scope / registerOptions / 可用 hooks 都写全了）。

### 我们能用的四个落点

| slot | kind · scope | 放什么 |
|---|---|---|
| `plugins.bundle.config` | keyed · root | **插件详情页那块**（截图 1 红框）。key 必须等于包名。内部自己分 tab：总览 / 专家 / 缺口 / 体检 / 日志 |
| `conversation.view` | list · session | **会话页顶栏那排 tab**（截图 2）。id 用自己的，别复用宿主 id（复用会顶掉宿主那一格）。标签叫「编排」：当前阶段、在场专家、任务卡进度 |
| `settings.section` | — | 设置里一页：总开关 + 专家管理 + `doctor` 结果。低频但省事，照抄 billion-context 的用法 |
| `conversation.input.dock` | list · session | 可选：输入框上方一条极窄的阶段条（阶段 + 下一步）。**默认不做**，先看前两个够不够，别把界面塞满 |

### 数据通道：自己起 HTTP，不接宿主 RPC

宿主给的那一堆 `useResource` / `useSessions` 是**宿主自己数据**的 selector，不是给插件读自己状态的通用通道。billion-context 的答案是自建本地 HTTP + iframe，我们照做：

```text
tools/panel.mjs 起 HTTP（127.0.0.1，随机端口）
   ├─ 读 runs.jsonl / sessions/*.json / gaps.jsonl / 专家包
   └─ 渲染页面（无框架，服务端拼 HTML 或一个静态 index.html + fetch）
client 半边只有一层壳：tab 导航 + iframe(src = panel 地址)
插件详情页与「编排」tab 复用它
```

好处：面板先能独立使用（浏览器直接开），UI 只是把它嵌进去；宿主换版本时，掉的是壳不是数据。

### 分两步，别混

- **第一步（不依赖任何 UI 能力）**：`tools/panel.mjs` 只读面板——v0.12.0 已交付，HTML 在 `lib/panel.js`，HTTP 在 `tools/panel.mjs`，`/api/state` 直接给第二半当数据源。
- **第二步（依赖 client 半边）**：加 ~100 行壳（tab + iframe）挂到上面两个 slot。

### 坑（billion-context 踩过并写在文案里的）

- **远程访问**：iframe 里的 `127.0.0.1` 在用户浏览器里指向用户自己的机器。它专门写了 `remote_blocked` 文案 + 「去配置页开启」的引导。我们至少要做检测与提示，别让面板白屏。
- **版本错位**：宿主 UI 更新了、本地服务还是老的，它也有 `stale` 文案。我们的壳只嵌 iframe，风险小，但面板页要带自己的版本号。
- **client 半边是独立产物**：ESM、不在 `lib/` 里，服务端那套 CommonJS 代码不要直接 require。

---

---

## 十、迁移路径（每步可独立验证）

| 步 | 内容 | 验证方式 | 风险 |
|---|---|---|---|
| 1 | ~~删 `narrow` 全套（代码、测试、配置、文档）~~ **已完成 v0.7.0** | 62 → 54 场景全绿 | 低，纯减法 |
| 2 | ~~专家包 v2 字段 + `tools/doctor.mjs`~~ **已完成 v0.8.0** | `npm run doctor` 报出五个专家的依赖现状（host 源不查） | 低 |
| 3 | ~~专家目录进系统提示 + `expert()` 工具~~ **已完成 v0.9.0** | `npm test` 68 场景；真机待验证「模型会自己调 `expert()`」 | 中，工具 schema 要对 |
| 4 | ~~会话状态 + 阶段闸门 + `runs.jsonl`~~ **已完成 v0.10.0** | 打开 `expert("intake")` 进 spec，之后每步只收状态卡 | 会话身份已确认：`payload.agent.id` === `agent.session.id` |
| 5 | ~~加 `intake`、`review` 两个专家包~~ **已完成 v0.11.0** | `npm test` 79 场景；匹配器 a/b 集 20/20 未回退 | 中，提示词要反复调 |
| 6 | ~~`tools/panel.mjs` 只读面板~~ **已完成 v0.12.0** | `npm run panel` 打开三屏：会话阶段 / 最近 25 步 / 缺口队列 + 技能供给 | 低 |
| 7 | ~~匹配器 `multi` 结论 + 降级为提示~~ **已完成 v0.13.0** | 跨领域句判 multi 且不指定专家；a/b 集仍 20/20 | 低 |
| 8 | ~~client 半边：两个 slot 的壳，iframe 嵌面板~~ **已完成 v0.14.0** | 插件详情页出现面板；会话页多一个「编排」tab；面板走宿主路由 `/capability-router/panel` | 中，改了 `package.json`（`dsh.client` + `exports["./client"]`），要重启/重装生效 |

顺序有依赖但不用一次做完：1、2 可以立刻做；3 是分水岭（第一次把决定权交出去）；4、5 决定验收场景能不能通；8 只做壳，随时可以弹回第 6 步的独立面板。

---

## 十一、要删的东西（避免抱着旧代码改）

- `lib/narrow.js` 全部、`test/narrow.mjs` 全部
- `lib/index.js` 里 `pre-step` 的裁决分支（`match()` 结果直接决定注入什么）
- 配置项 `narrow`
- 文档里所有「按专家收窄」的表述（README 限制段、FEATURES 第九节、DESIGN 六.2）

**保留**：`expert.yml`/`role.md` 双文件、`lib/yaml.js`、`lib/experts.js`、`lib/router.js`（降级使用）、`gaps.jsonl` 与 `tools/gaps.mjs`、`tools/forge.mjs`、自检技能。

---

## 十二、未决问题（实现前要确认的宿主能力）

1. ~~`agent/pre-step` 的 `agent` 上取会话 id 的确切字段~~ 已确认：`agent.id`，等于 `agent.session.id`（`dsh-agent/lib/index.js:513-514`）。
2. `ctx.tools.register` 注册的工具能否按会话/阶段动态启停；不能的话，闸门只能靠提示。
3. 技能目录消息是否支持「推荐标记」；不支持就只能靠 `role.md` 里写技能路由。
4. 工具输出版本里 `output.schema` 的约束风格（`required` 放在 property 里而不是数组里，见 `dsh-experimental-tool-worktree` 的写法，与标准 JSON Schema 不同）。
5. ~~client 半边的 React 从哪来~~ 已确认：bundle 的 `factory(require)` 里 `require("react")` 由宿主加载器提供，不需要打包、不需要构建步骤。
6. ~~client 清单字段~~ 已确认：`@deepseek-ai/dsh-client-modules/lib/index.js:62-76` 只读 `pkg.dsh.client`（`platform`/`inject`/`external`/`immediately`），`dshClient` 是 runner 注释里的旧说法。
7. ~~远程访问下的 iframe 地址~~ 已用同源相对路径解决：面板挂在宿主 Web 服务上（`ctx.inject(["webServer"], sub => sub.webServer.register({kind:"exact", path, handler}))`），iframe 用 `/capability-router/panel`，远程访问天然正确。
