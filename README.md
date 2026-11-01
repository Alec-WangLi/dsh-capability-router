# dsh-capability-router

> 状态：v0.2.0，已在 DSH Desktop 0.2.1 上验证生效（A/B 对照见 [DESIGN.md](./DESIGN.md) 第十节）。
> 设计取舍、宿主 API 实测记录、踩过的坑都在 [DESIGN.md](./DESIGN.md)。

本机自研的 DSH 插件。解决两个问题：**agent 拿到一句含糊的需求就直接开干**，以及**技能装多了挑不准**。

## 仓库结构

```text
lib/index.js           插件本体（单文件，无依赖）
test/smoke.mjs         假 ctx 跑 apply，九场景
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

## 之后

按当前任务收窄技能目录：只把该领域的技能留在模型目录里，其余设成 `modelInvocable: false`——名字还在、仍可 `/name` 调用，但不占目录 token。

判断走确定性匹配（名称 / whenToUse / 描述加权 + IDF + 中英桥接词典），不每轮调模型。

## 安装方式

开发目录在 `C:\dev\dsh-capability-router`，profile 通过 junction 引用它：

```text
~/.dsh/profiles/desktop/node_modules/dsh-capability-router
  ⇒ C:\dev\dsh-capability-router
```

建立链接（管理员或开发者模式下）：

```bash
cmd //c "mklink /J %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-capability-router C:\dev\dsh-capability-router"
```

profile 的 `cordis.patch.yml` 末尾：

```yaml
# capability-router：本机自研，通过 insert 新增（非 insert 的 patch 只能改已有条目）
- insert:
    - id: capability-router
      name: dsh-capability-router
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
