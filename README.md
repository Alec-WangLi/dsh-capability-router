# dsh-capability-router

> 状态：v0.3.0。v0.2.0 的检查点已在 DSH Desktop 0.2.1 上做过 A/B 对照（[DESIGN.md](./DESIGN.md) 第十节）；v0.3.0 加了专家包、规则匹配、角色注入与技能目录收窄。
> 设计取舍、宿主 API 实测记录、踩过的坑都在 [DESIGN.md](./DESIGN.md)。

本机自研的 DSH 插件。解决两个问题：**agent 拿到一句含糊的需求就直接开干**，以及**技能装多了挑不准**。

## 仓库结构

```text
lib/index.js           插件本体：挂载、两处注入、自检技能
lib/experts.js         专家包发现与校验（内层覆盖外层）
lib/router.js          规则匹配器：一句话判给哪个专家
lib/narrow.js          技能目录收窄（冒名接管，仍可按名加载）
lib/yaml.js            YAML 子集解析器（为了零依赖手写的）
experts/<id>/          专家包：expert.yml + role.md，首批 5 个
test/smoke.mjs         假 ctx 跑 apply，九场景
test/experts.mjs       解析器与扫描器，九场景
test/router.mjs        匹配打分与三种结论，九场景
test/narrow.mjs        收窄语义（含仍可按名加载），八场景
test/route.mjs         集成：一句话进来后模型看到什么变了
tools/match.mjs        匹配器验收集（a 回归 / b 口语 / c 探针）
tools/dump-session.mjs 把 DSH 的多帧 zstd 会话日志 dump 成可读 JSONL
DESIGN.md              设计文档：为什么这么做、宿主 API 实测、坑
README.md              本文件
```

`tools/dump-session.mjs` 解决一个很具体的问题：`~/.dsh/sessions/<slug>/session-<id>/session.v4.jsonl.zstd` 是**多帧 zstd 串联**，`zlib.zstdDecompressSync` 只解第一帧（通常几百字节）。这个工具按帧头 magic 切片逐帧解压再拼接，并给出事件与工具调用统计：

```bash
node tools/dump-session.mjs ~/.dsh/sessions/<slug>/session-<id> --stats
node tools/dump-session.mjs ~/.dsh/sessions/<slug>/session-<id> --out dump.jsonl
```


## 两个注入通道

同一份协议，用两种方式送到模型面前，区别在**距离**。

| | 长期原则段 | 当轮检查点 |
|---|---|---|
| 机制 | `ctx.systemPrompt.section()` | `ctx.on("agent/pre-step")` |
| 位置 | 系统提示后半段 | 紧跟用户那句话 |
| 距离 | 中间隔着几十 KB 项目规则 | 零距离 |
| 频率 | 常驻 | 每条用户消息一次 |
| 作用 | 背景设定 | 触发动作 |

只有后者会真正改变行为。前者存在的意义是：模型在长对话里回头翻上下文时，还能找到依据。

检查点的做法是在 `agent/pre-step` 里往 `decision.messages` 末尾追加一条 user 消息：

```js
{
  role: "user",
  id: randomUUID(),
  content: [{ type: "text", text: HINT_TEXT }],
  source: { kind: "capability-router-hint", form: "notice", forPrompt: <该用户消息的 id> }
}
```

`forPrompt` 用来去重——同一条用户消息只注入一次，工具调用来回多少步都不重复。识别"真人说的话"靠 `source.kind === "user"`，因为 `agent-instructions`、`runtime-context`、`skill-catalog`、`time-context` 也都是 user 角色。

## 检查点写了什么

```text
【能力路由 · 当轮检查】

先归类用户这句话，再决定动作：

- 提问（要答案）：直接答。不要顺手改代码，不要先跑一堆命令验证。
- 命令（要动作）：有一个会改变实现方向的黑洞就问，一次只问一个，附上推荐答案；没有就开工。
- 报告（是继续）：接着做，别重新评估已经定下的事。

开工前扫一眼技能目录：对口就加载完整指令再动手；不对口就说「我手上没有对应能力」并说缺什么。
```

## 专家包

一个目录就是一个专家：`expert.yml` 说它是谁、什么话该找它，`role.md` 是命中后注入的角色提示词。

```text
<包内>/experts/<id>/                          随插件发布，改它要动源码
<DSH_HOME>/capability-router/experts/<id>/    用户自建或覆盖，同名 id 以内层为准
  expert.yml
  role.md
  skills/        可选，专家自带的技能
```

```yaml
name: 前端工程师
description: 界面、交互、样式、浏览器行为
triggers: [界面, 样式, 前端, 组件, 布局, 交互, 渲染, 动画, 响应式, 页面, CSS, HTML, React, Vue, 浏览器]
skills: [frontend-design, playwright, canvas-design, theme-factory, prototype]
tools: []          # 空 = 用全部
```

`expert.yml` 用的是 YAML 子集：扁平 key、标量、一维列表（`[a, b]` 或缩进 `- a`），不支持多行块和嵌套——要长文本写进 `role.md`。

自带五个：

| id | 名字 | 覆盖什么 |
|---|---|---|
| `frontend` | 前端工程师 | 界面、样式、交互、浏览器行为 |
| `backend` | 后端工程师 | 接口、数据模型、并发、服务边界 |
| `docs` | 文档与写作 | 文档、方案、汇报、对外文字 |
| `debug` | 排障工程师 | 报错、崩溃、不生效、性能 |
| `data` | 数据与办公 | 表格、报表、演示文稿、PDF |

`name`、`description`、`triggers` 任一为空，这个专家会被判无效并进告警；缺 `role.md` 只告警（命中后只注入技能集）。内层同名包坏了不会退回旧版本，那个 id 直接消失——少一个专家比用错一个专家好。

**当前版本只做到「读得出、列得全」**：扫描结果出现在 `capability-router` 自检技能里，匹配与收窄还没接上。

## 匹配器

一句话 → 该由哪个专家接，纯规则，不调模型（`lib/router.js`）：

```text
触发词命中 × (1 + (len-1)×0.5，上限 2.5)
同义词命中 × 1.0（总量上限 2.0，已当触发词命中过的不重复计）
描述命中 × 0.5（总量上限 1.5）

最高分 < 1.0            → miss
最高分 - 次高分 < 0.35  → ambiguous，列前两名
否则                    → hit
```

按词长给权重是为了让「数据库」压过「数据」、「设计文档」压过「文档」——笼统词盖过具体词是最常见的错路由来源。

三种结论都是正常结果，尤其 **ambiguous 不是错误**：分差太小时说「像是 A 也可能是 B」比硬选一个错的好。

跑验收：

```bash
npm run accept              # a 集（回归）+ b 集（口语，门槛 70%）
node tools/match.mjs --set c # 泛化探针
```

`expert.yml` 里 `triggers` 写「这个领域叫什么」，`synonyms` 写「用户会怎么说」：

```yaml
triggers: [样式, 前端, 组件, 布局, 交互, React, Vue]
synonyms: [登录, 按钮, 表单, 首页, 弹窗, 滚动, 适配]
```

## 命中之后做什么

`agent/pre-step` 里拿用户那句原话判一次专家，两条后果：

1. **注入角色**（默认开）：命中就把该专家 `role.md` 作为一条 `source.kind = capability-router-role` 的消息追加进去。一条用户消息只注入一次。
2. **收窄目录**（默认关，配置 `narrow: true`）：把该专家 `skills` 之外的技能全部设成 `modelInvocable: false`——模型看不见，用户仍可 `/name` 调用。

收窄的实现是冒名接管：宿主没有「排除技能」的接口，只能交一份同名候选、`rank: -1` 压过原 provider（排序是 `rank → providerOrder → localOrder`，同名先到先得）。

代价写在明面上：

- 每被覆盖一个技能，宿主在目录重算时打一条 `ignored because a higher-priority skill already exists` 告警。只在缓存失效时出现，但切专家那一刻会有 N 条。
- 目录是全量重发的，每变一次 prefix cache 重算一次。所以同一专家不重复算目录，匹配落空立刻恢复完整目录（逃生口）。

```json
{ "role": true, "narrow": false, "alwaysVisible": ["research", "office", "pdf"] }
```

`alwaysVisible` 是跨领域技能白名单：调研、Office、PDF 这类跟哪个专家都能撞上的，不进收窄范围。

## 之后

- **缺口提示**：匹配落空时说一句「没有干这个的人」，而不是静默按普通对话处理。
- **造专家**：缺口确认后生成 `expert.yml` 草案，人审过再落盘。
- **否定式说法**：`没生效 / 没起作用 / 不起作用` 这类整类词还没进词表，是当前匹配的已知短板。

## 安装方式

**源码只有一份**，放在哪都行；`C:\dev\dsh-capability-router` 只是个不含空格的稳定别名（junction）。profile 再链接到别名：

```text
C:\Users\Alec\Documents\DeepSeekHermesData\DSH-capability-router dev   ← 唯一源码（git 仓库）
  ⇐ C:\dev\dsh-capability-router                                      ← junction，稳定别名
  ⇐ ~/.dsh/profiles/desktop/node_modules/dsh-capability-router        ← profile 安装位
```

别在 `~/.dsh/plugins/` 下再建副本——运行时根本不扫那个目录。

唯一受支持的安装动作：DSH → 插件 → 添加插件，输入**源码目录的绝对路径**。它会走 `dsh-plugin-manager` 的 `reconcile()`：登记 profile `package.json` 的 `dependencies` 与 `pnpm-lock.yaml` → 把包名推进 `dsh.profile.bundles` → 校验包内 patch 能解析。手写链接不会登记，插件面板看不见、版本兼容校验也不跑。

被 GUI 接受的前提是包里声明了 `dsh.bundle`，否则直接拒：`dsh-capability-router declares no dsh.bundle`（`dsh-plugin-manager/lib/index.js:1866` 的 `not-a-bundle` 分支）。本包已声明：

```json
"dsh": { "bundle": { "patch": "cordis.patch.yml" }, "compatibility": { … } }
```

包内 `cordis.patch.yml` 就是加载入口：

```yaml
- insert:
    - id: capability-router
      name: dsh-capability-router
```

patch 的应用顺序是「各 bundle 的 patch → profile 的 `cordis.patch.yml` → `~/.dsh/cordis.patch.yml`」（`dsh-app-boot` `readProfilePatches`）。**所以 profile 自己的 patch 里不要再写同一条 insert**，同一 id 会挂两次、检查点会重复注入。

带空格的路径 pnpm 11 实测能吃（`link:C:/Users/…/DSH-capability-router dev` 解析正常）；不想敲长路径也可以用 `C:\dev\dsh-capability-router` 这个别名，效果一样。手动兜底（GUI 不可用时）才需要自己建链接 + 改 profile `package.json` + 手写 insert。

建立链接（管理员或开发者模式下）：

```bash
cmd //c "mklink /J %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-capability-router C:\dev\dsh-capability-router"
```

**`insert` 不能省。** 不带 `insert` 的 patch 是「按 id 覆盖已存在条目」，新 id 匹配不到时 `applyEntryPatches` 只输出一条 warn 就跳过，插件静默不加载，日志里也翻不到。只有 `insert` 分支能新增条目（不带 `id` 的 insert 直接 push 到根数组）。

改 YAML 会热重载；只改 `lib/` 下的源码不一定触发，必要时重启 DSH。

## 配置

`~/.dsh/capability-router/config.json`，缺省时用内置默认值：

```json
{
  "enabled": true,
  "intake": true,
  "hint": true,
  "narrow": false,
  "groups": {},
  "activeGroups": [],
  "hidden": [],
  "order": 5000
}
```

| 字段 | 作用 |
|---|---|
| `enabled` | 总开关；关掉后无任何注入，行为等同未安装 |
| `intake` | 是否注入系统提示里的长期原则段 |
| `hint` | 是否追加当轮检查点 |
| `narrow` | 是否按 `activeGroups` 收窄技能目录（尚未实现，开了只记录） |
| `groups` | 分组定义，`{ "分组名": ["技能名", …] }` |
| `activeGroups` | 收窄时保持可见的分组 |
| `hidden` | 永不进模型目录的技能名 |
| `order` | 原则段的排序位；dsh-purge 尾段在 5100，这里排它前面 |

也可以调 `saveConfig(patch)` 从代码里改。

## 验证

```bash
npm test          # 等价于 node test/smoke.mjs
```

九个场景：首次注入、同句去重、新句再注入、无真人消息、reject 透传、`hint:false`、`enabled:false`、配置写回、跨步去重。

测试会把 `DSH_HOME` 指到临时目录，不会污染真实状态。**这个隔离必须在 `import` 插件之前设置**，否则假 promptId 会写进真实的 `hints.jsonl`。

行为验证看下一轮：问一句「这个功能为什么不生效？」——如果它先回答判断再动手，而不是先跑十条命令，说明检查点在起作用。

## 两个实测出来的坑

**一、改 `lib/` 源码必须重启，热重载只能验配置。**

改 YAML 会触发配置重载，`apply()` 确实又跑一遍（`trace.jsonl` 里有 `event:"apply"`）。但**重载出来的那个实例，`agent/pre-step` 拿到的 payload 和 decision 里 `messages` 都是空的**：

```json
{"at":"…08:50:22","p":0,"d":0,"keys":"kind|messages","lastKind":null,"promptId":null}
```

事件其实还在触发（每步一条记录），只是没有消息，`lastUserPrompt()` 找不到"用户那句话"，于是什么也不注入。重启之后同一条路径立刻正常：

```json
{"at":"…08:54:40","p":1,"d":2,"keys":"kind|messages",
 "pkeys":"messages|turn|step|signal|agent","lastKind":"runtime-context",
 "promptId":"6f50972d-287a-4681-a532-6e188dbc1a1d"}
```

所以：**改 YAML 用来验证条目挂上没挂上；改源码只能重启。** 别指望热重载。

**二、`p=0` 不等于没挂钩。**

我一开始看到 `p=0` 以为是监听没注册上，白查了一轮。实际是「挂钩在、payload 空」。判断办法就是看 `trace.jsonl` 有没有持续的新记录——有记录说明 handler 在跑，没消息才是 payload 的问题。

## 打开诊断

`config.json` 里 `"debug": true` 后，每次 pre-step 会往 `~/.dsh/capability-router/trace.jsonl` 追加一行：

```json
{"at":"…","p":1,"d":2,"keys":"kind|messages","pkeys":"messages|turn|step|signal|agent",
 "lastKind":"runtime-context","promptId":"…"}
```

- `p` = `payload.messages` 长度，`d` = `decision.messages` 长度
- `pkeys` = payload 有哪些键，用来确认消息到底挂在哪
- `promptId` 有值 = 找到了真人消息

验收标准三条：`promptId` 非空、`hints.jsonl` 出现同一 id、下一轮回答先归类再动手。

文件超过 64 KB 自动只留后一半。查完把 `debug` 改回 `false`。

## 卸载

1. 从 profile 的 `cordis.patch.yml` 删掉那两行 insert；
2. 删 junction：`cmd /c rmdir "C:\Users\Alec\.dsh\profiles\desktop\node_modules\dsh-capability-router"`（不带 `/s` 只删链接，不动源码）；
3. 重启。

源码目录留着不影响任何东西。`rmdir` 不带 `/s` 只删链接，不动源码——别用 `rm -rf`。
