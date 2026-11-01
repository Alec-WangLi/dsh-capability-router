# dsh-capability-router 设计文档

> 这份文档是给未来的自己看的。上下文会被压缩，记忆会失真，但文件不会。
> 任何一次开工之前，先读这里，再读 `README.md`（那是给用户看的用法）。
>
> 最后更新：2026-11-01

---

## 一、这个插件要解决什么

### 最初的诉求（用户原话，2026-11-01）

> 每次我们新开对话的时候，这个插件把咱们的需求搞清楚之后，需要用到什么 Skills 或者插件之类的，它自己选择或者推荐咱们安装，或者自己安装什么。我们全部用自然语言，这样才符合下一代 Agent 的风格。

拆成四件事：

1. 开局把需求搞清楚
2. 判断这件事需要什么能力
3. 有就自己选、没有就推荐安装或自己造
4. 全程自然语言，用户不点名技能

### 为什么需要它（实测数据）

不是"上下文爆炸"——那是错觉。实测：

| 项 | 数据 |
|---|---|
| 全装 99 个技能的目录 | 19,617 字符 ≈ 6,130 token |
| `~/.dsh/prompt-inject.md` | 25,128 字节 ≈ 7,850 token |
| 一个真实项目会话的 `AGENTS.md` | **405,066 字节**，被 workspace budget 截断到 **64,451 字节**才进模型 |

技能目录只占注入开销的 78%，占 1M 上下文不到 1%。真正的成本是**注意力稀释**：50 多条技能描述常驻，模型每次都要在一堆不相关的领域里找路。

所以要做的不是"省 token"，是**把不相关的信息挪走，让相关的更显眼**。

---

## 二、架构演进（重要：当前方案是第二版）

### 第一版：技能路由

```text
用户说话 → intake 澄清需求 → provider 按任务收窄技能目录 → 缺什么就造什么技能
```

### 为什么推翻：`forge` 太轻

一个 SKILL.md 解决不了"做视频监控"——那是 RTSP、ONVIF、流媒体转发、存储回放一整片领域。造十个技能也拼不出一个能干活的人。

用户 2026-11-01 17:20 提出的关键修正：

> 现在不是到能力路由阶段吗？他可以选对应的专家来干活，然后那个专家自带这些能力。实在是碰到一些全新的领域，确实没有能匹配的专家时，再提示我们创建一个新的专家，然后让专家干活。

### 第二版：专家路由（当前）

```text
用户说第一句话
   ↓
intake：把需求问清楚（一次一个问题）
   ↓
expert-router：这句话落在哪个专家的地盘上？
   ├─ 命中 → 注入 role.md + 技能目录收窄到「该专家技能 + 全局技能」
   └─ 没命中 → 说「我手上没有干这个的人」，给两条路：装一个 / 现造一个
   ↓
provider：按专家的技能集改 modelInvocable，其余 name 还在、/name 仍可调
   ↓
干活
```

**核心变化：路由单位从"技能"升到"专家"，缺口判断从"缺一个技能"变成"缺一个角色"。**

---

## 三、关键约束：专家不能是 agent-preset

DSH 原生有 `~/.dsh/.agent-presets/`（本机现有 liangshen / redteam / unrestricted），看起来正好能当专家用。

**不行。** preset 是会话级的——选定后绑死在这个会话上，中途换等于换一个 agent，上下文全断。而我们要的是"这一轮这个活该请谁"，每轮换 preset = 每轮开新会话。

所以专家是**软专家**：不换 agent，只换三样东西。

| 换什么 | 怎么换 | 代价 |
|---|---|---|
| 角色提示词 | 注入 `role.md` | prefix cache 失效一次（贵） |
| 技能子集 | `registerProvider` + `modelInvocable` | 目录消息重发（便宜） |
| 工具集 | 暂不做 | — |

**因此规则是：首轮定专家并注入 role；之后只切技能子集，不再换 role。** 用户明确说"换个专家"时才允许第二次换。

这条不开玩笑：不加约束就会出现每轮换专家、每轮 cache 全废。

---

## 四、四个部件

| 部件 | 职责 | 状态 |
|---|---|---|
| `intake` | 开局澄清需求；另有一条每轮检查点 | **部分实现**（只有检查点，没有需求画像） |
| `expert-router` | 匹配专家、注入 role、决定技能集 | **未实现** |
| `provider` | `registerProvider` 接管目录，按专家技能集收窄 | **未实现** |
| `gap` | 无专家匹配时提示；给候选或提议新建 | **未实现** |
| `forge` | 生成新专家包草案 | **未实现** |

### 文件地图

```text
C:\Users\Alec\Documents\DeepSeekHermesData\DSH-capability-router dev\   ← 唯一源码（git 仓库）
  package.json          name: dsh-capability-router, type: module, main: lib/index.js
                        dsh.bundle.patch = cordis.patch.yml（GUI 安装的唯一凭据）
                        peerDependencies: {"@deepseek-ai/cordis": "~4.0.5"}
  cordis.patch.yml      bundle 层入口：insert 一条 capability-router
  lib/index.js          全部逻辑（单文件，约 300 行）
  test/smoke.mjs        假 ctx 跑 apply，九个场景
  README.md             给用户看的用法
  DESIGN.md             本文件
  experts/<id>/         专家包（未实现）
```

### 挂载链路

```text
C:\Users\Alec\Documents\DeepSeekHermesData\DSH-capability-router dev   (唯一源码)
  ⇐ C:\dev\dsh-capability-router                                      (junction，不含空格的稳定别名)
  ⇐ ~/.dsh/profiles/desktop/node_modules/dsh-capability-router        (profile 安装位，pnpm 记成 link:)

包 package.json：
  "dsh": { "bundle": { "patch": "cordis.patch.yml" } }                ← 没有这行 GUI 直接拒装
    ↓ 安装时 dsh-plugin-manager 的 reconcile()
~/.dsh/profiles/desktop/package.json
  dependencies["dsh-capability-router"] = "link:…"                    ← 登记，进 pnpm-lock.yaml
  dsh.profile.bundles = [ …, "dsh-capability-router" ]                ← 成为 profile layer

包根 cordis.patch.yml（本包自带）：
  - insert:
      - id: capability-router
        name: dsh-capability-router
```

patch 的应用顺序是「各 bundle 的 patch → profile 的 `cordis.patch.yml` → `~/.dsh/cordis.patch.yml`」
（`dsh-app-boot` `readProfilePatches`）。既然入口已经在包内，profile 的 patch 里就不要再写同一条——
同一 id 会挂两次，检查点重复注入。

**`insert` 不能省**，见第七节。

**光有 insert + 解析得到，只算「能加载」，不算「已安装」。** 官方口径里包还得登记进 profile 的
`package.json` dependencies 与 `pnpm-lock.yaml`；不登记时插件面板/库存（`dsh-host-plugin-inventory`）
看不见它，`dsh.compatibility` 的版本闸（`evaluatePluginCompatibility`）不跑，重装修复时那条游离的
`node_modules` 目录也有被清掉的风险。desktop profile 由 Electron 独占管理
（`dsh plugin --profile desktop list` → `profile "desktop" is managed exclusively by the Electron application`），
所以登记只能走 GUI：插件 → 添加插件 → 输入源码绝对路径（`C:\dev\dsh-capability-router` 别名亦可，
两条路径 pnpm 11 都实测可用，带空格那条会记成 `link:C:/Users/…/DSH-capability-router dev`）。
登记动作由 `reconcile()` 完成，前提是包声明了 `dsh.bundle`——否则 GUI 报
`dsh-capability-router declares no dsh.bundle`（`dsh-plugin-manager/lib/index.js:1866` 的 `not-a-bundle` 分支），
CLI 那条路只 warn 一句 `installed as a plain dependency, not a profile layer` 就当普通依赖装进去了。
本地目录会被 pnpm 记成 `link:`，源码仍只有一份。

---

## 五、专家包格式

```text
~/.dsh/capability-router/experts/<id>/
  expert.yml      # 元数据
  role.md         # 角色提示词，注入系统提示
  skills/         # 自带的 SKILL.md，与普通技能同格式
```

`expert.yml`：

```yaml
name: 前端工程师
description: 界面、交互、样式、浏览器行为
triggers: [界面, 样式, 前端, 组件, 布局, React, Vue, CSS, 页面]
skills: [frontend-design, playwright, canvas-design]
tools: []          # 空 = 用全部
```

格式与 `dsh-expert-hub` 基本一致（`~/.dsh/experts/<id>/{expert.yml, role.md, skills/}`）。区别：它靠输入框胶囊**手动**切，我们做**自动**判断该切谁。两边能互转，所以将来不排除直接复用它的 UI。

### 第一批专家（5 个起步）

覆盖本机实际在干的事：

1. **需求与方案** —— "我想做 X" → 能开工的需求文档
2. **前端** —— 界面、交互、样式
3. **后端与数据** —— 服务、接口、存储
4. **逆向与安全** —— 打包 `@dhicoc/dsh-reverse-skill` 那套
5. **交付与审查** —— 测试、评审、文档、上线

跨领域能力（调研、搜索、Office 文档）**不塞进任何专家**，留作全局技能，永远可见。

---

## 六、设计决定与理由

### 1. 判断用规则匹配，不用 LLM

每轮调模型做一次分类，等于把延迟和成本翻倍。确定性方案：

```text
得分 = 名称命中 × 4 + whenToUse 命中 × 2 + description 命中 × 1
总权重 = 得分 × IDF(词)
```

IDF 用来压低"帮我""看看"这类高频无意义词的权重。另需中→英桥接词典：本机技能名几乎全是英文，用户说的是中文，`dsh-plugin-skill-autoroute` 内建 180 条，这个思路要抄。

LLM 只在两处各用一次：**首轮需求画像**、**能力缺口判断**。

### 2. 只缩小不封锁

被收窄的技能只是 `modelInvocable: false`，名字仍在、`/name` 仍可调。必须有"把完整目录给我"的逃生口。

理由：匹配算法一定会错。错的时候宁可模型自己找不到、再问一句，也不要它明明看得见却被规则挡死。

### 3. 目录变更次数克制

技能目录消息是**全量替换**的（见第七节 digest 机制）。每变一次，prefix cache 重算一次。

一个会话最多变 2–3 次：首轮定专家一次、明确换专家一次、兜底一次。

### 4. 零标注

不改任何现有 SKILL.md。`@starpivot/dsh-skill-router` 要求给每个技能手写 `exposure:` 标记——99 个文件，0 个版本迭代，直接否掉。

### 5. 专家 ≠ preset

见第三节。

### 6. 检查点只提示不枷锁

`agent/pre-step` 注入的那段话是**提示**，不是规则。实测证据见第八节：模型收到"这是提问，直接答"之后，判断"要准确回答需要读代码"，然后去读——这是对的。

文案如果写成硬规则，模型会为了遵守规则给出瞎猜的答案。

---

## 七、实测出来的宿主事实（最容易丢，优先看这节）

### `ctx.skills` 服务（`@deepseek-ai/dsh-skill`，**未被 dsh-purge 改动**）

```js
ctx.skills.registerProvider(create)   // lib/index.js:147
// create({signal, invalidate}) → { name, list(options), get(name, options) }
// 返回 disposer，自动摘除 + 清缓存

ctx.skills.register(skill)            // lib/index.js:193
// 注册内存技能，默认 invocation: {modelInvocable:true, userInvocable:true}

control.invalidate()                  // lib/index.js:153
// 下一次 agent/pre-step 重算目录
```

`register()` 的硬校验（`lib/index.js:480`，发生在补默认值之前）：

- `name` 必须匹配 `SKILL_NAME` 正则
- `description` 非空
- `invocation` 必须是两个 boolean
- `source` / `provider` 必须是 string ← **必须自己传**

技能候选结构（`dsh-skill-filesystem/lib/index.js:599`）：

```js
{ name, description, whenToUse?, invocation, provider, source, rank,
  locator: {path, directory}, resourceBase: {kind: "directory", path},
  path, metadata? }
```

覆盖优先级 `compareIndexedCandidates`：`rank → providerOrder → localOrder`，**更小获胜**。filesystem 的 rank 是常量，所以自定义 provider 用 `rank: 0` 就能压过它。

### `agent/pre-step` 瀑布

payload（实测字段）：`messages | turn | step | signal | agent`
decision：`kind | messages`

```js
ctx.on("agent/pre-step", async (payload, next) => {
  const decision = await next();
  if (decision.kind === "reject") return decision;
  return { ...decision, messages: [...decision.messages, extra] };
});
```

注意：`decision.messages` 是**本步要发的消息**，不一定是完整历史。`payload.messages` 在正常重启后长度 ≥ 1（含用户那条），但见第八节第一条坑。

### 消息构造

`createMessage(input)` = `deepFreeze(structuredClone({...input, id: randomUUID()}))`（`@deepseek-ai/dsh-llm/lib/index.js:37`）
`createUserMessage(input)` = `createMessage({...input, role:"user"})`（60 行）

**第三方插件 import 不到 `@deepseek-ai/dsh-llm`**（从 `~/.dsh/plugins/` 向上找不到），必须手搓同形状对象：

```js
{ role: "user", id: randomUUID(), content: [{type:"text", text}], source: {...} }
```

### `source.kind` 取值（实测）

`user`（真人）| `agent-instructions` | `runtime-context` | `skill-catalog` | `time-context` | `system-prompt` | `tool` | `model` | `provider` | `fallback`

**识别"用户那句话"只能靠 `source.kind === "user"`**。系统注入的全部是 user 角色。

### 技能目录刷新机制（`dsh-tool-skill/lib/index.js:931`）

每次 `agent/pre-step` 快照目录，与日志里最新 `skill-catalog` 消息做 digest 比对；变了才追加**全量替换**的持久 user 消息；目录空了会发空信封停用旧名。

所以"改一个技能的可见性"的代价 = 一整条目录消息重发。

### `cordis.patch.yml` 的 insert 语义（`cordis-plugin-include/lib/index.js:56`）

```js
if (insert) {                      // 唯一能新增条目的分支
  if (id) { /* 插进 id 指向的 group */ }
  else data.push(...insert);       // 不带 id：追加到根数组
  continue;
}
if (!id) { warn("patch: id is required"); continue; }
const target = entryMap.get(id);
if (!target) { warn("patch: entry %C not found"); continue; }   // ← 静默跳过
```

**不带 `insert` 的 patch 只能改已有条目。** 新 id 匹配不到时只输出一条 warn 就跳过，日志里翻不到。

### loader 的裸包名解析

`mountRootInclude(ctx, path, patches, bareModuleBaseUrl, binName)`（`dsh-app-boot/lib/index.js:4131`）：

- `bareModuleBaseUrl === undefined` → 原生 `Include`
- 否则 → `HostResolvedRootInclude`，裸名走 `internal.import(specifier, bareModuleBaseUrl, {})`

`dsh` 的 `profile-boot-C14i-8IN.js:302` 只传 4 个参数 → 走 `ctx.loader.internal` 分支，基准是 `ctx.baseUrl`（`dsh-app-boot/lib/index.js:4531` 设为 `pathToFileURL(dirname(absoluteConfigPath))`，即 **profile 目录**）。所以 profile 的 `node_modules` 能被解析到。

### 备选钩子

`system-prompt/assemble`（`dsh-ops/lib/discovery/index.js:322`）：

```js
ctx.on('system-prompt/assemble', async (_assembly, context, next) => { ... })
```

能拿到 `context.scope`。如果 `agent/pre-step` 哪天拿不到消息，这是退路。

---

## 八、踩过的坑（带实测证据）

### 坑 1：改源码后热重载不生效，且表现为"payload 为空"

改 `cordis.patch.yml` 会触发配置重载，`apply()` 确实又跑一遍。但**重载出来的实例，pre-step 的 `messages` 是空的**：

```json
{"at":"…08:50:22","p":0,"d":0,"keys":"kind|messages","lastKind":null,"promptId":null}
```

事件在触发（每步一条记录），但拿不到消息，`lastUserPrompt()` 找不到用户那句话，于是安静地什么也不做。

重启后同一条路径立刻正常：

```json
{"at":"…08:54:40","p":1,"d":2,"keys":"kind|messages",
 "pkeys":"messages|turn|step|signal|agent","lastKind":"runtime-context",
 "promptId":"6f50972d-287a-4681-a532-6e188dbc1a1d"}
```

**结论：改 YAML 用来验证条目挂没挂上；改源码只能重启。** `p=0` 不等于没挂钩，先看 trace 有没有持续新记录。

### 坑 2：注入的消息不一定进下一步的 messages

第一版只用 `messages.some(...)` 判断"这条用户消息注入过没有"。如果注入的消息不出现在下一步的 `messages` 里，就会每步重注一次，一轮堆出几十条。

修法：模块级 `Set` 按 `promptId` 记账，上限 500 条，超了砍一半。消息 id 是 UUID，跨会话不撞，不需要按 agent 分桶。

### 坑 3：pre-step 注入的消息不进会话历史

所以光看 `session.v4.jsonl.zstd` 证明不了它跑过。为此加了 `hints.jsonl` 落地记账——每次真注入写一行。

### 坑 4：测试污染真实状态目录

`smoke.mjs` 一开始没隔离 `DSH_HOME`，把 `prompt-1`/`prompt-2` 这些假 id 写进了真实的 `~/.dsh/capability-router/hints.jsonl`。

修法：测试开头 `process.env.DSH_HOME = fs.mkdtempSync(...)`，且必须在 `import` 插件**之前**设。

### 坑 5：`state` 目录里的 config 改了不会立刻生效

`readConfig()` 在 `apply()` 时读一次。改 `config.json` 要等下次 `apply()`——也就是重启。热重载虽然会重跑 `apply()`，但见坑 1。

---

## 九、当前实现（v0.2.0）

`lib/index.js` 结构：

```text
常量        DSH_HOME / STATE_DIR / CONFIG_FILE / HINT_KIND / DEFAULTS
文案        INTAKE_TEXT（系统提示原则段，约 200 字）
            HINT_TEXT（当轮检查点，约 190 字）
函数        readConfig / saveConfig
            lastUserPrompt（倒序找 source.kind === "user"）
            hasHintFor / markHinted / hintedPrompts
            hintMessage / recordHint / recordTrace
            describeState / selfSkillContent / selfSkill
apply()     if (!enabled) return
            if (debug) recordTrace({event:"apply"})
            if (intake) ctx.effect(() => ctx.systemPrompt.section(...))
            if (hint)   ctx.on("agent/pre-step", ...)
            ctx.effect(() => ctx.skills.register(selfSkill(...)))
```

配置项（`~/.dsh/capability-router/config.json`）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | true | 总开关 |
| `intake` | true | 系统提示原则段 |
| `hint` | true | 当轮检查点 |
| `narrow` | false | **占位，未实现** |
| `activeGroups` | [] | **占位，未实现** |
| `groups` | {} | **占位，未实现** |
| `hidden` | [] | **占位，未实现** |
| `order` | 5000 | 原则段排序位（purge 尾段在 5100） |
| `debug` | false | 写 `trace.jsonl` |

### 当前检查点文案（v0.2.0，已验证有效但已判定要改）

```text
【能力路由 · 当轮检查】

先归类用户这句话，再决定动作：

- 提问（要答案）：直接答。不要顺手改代码，不要先跑一堆命令验证。
- 命令（要动作）：有一个会改变实现方向的黑洞就问，一次只问一个，附上推荐答案；没有就开工。
- 报告（是继续）：接着做，别重新评估已经定下的事。

开工前扫一眼技能目录：对口就加载完整指令再动手；不对口就说「我手上没有对应能力」并说缺什么。
```

**已知问题：按"语言形式"分类（提问/命令/报告）是错的维度。** 见第十一节。

---

## 十、v0.2.0 的效果验证（A/B 对照，真数据）

会话 `session-b57cad59`（shiftassistant 项目），同一个问题问了两次，中间重启过一次：

- **turn 1**：没有检查点（重启前）
- **turn 2**：有检查点（重启后）

### turn 1 首步推理原文

> The user reports a bug… **I need to look at the code. Let me start the SOP: read AGENTS.md** (already in context truncated), git log, tag, version.

直接进执行模式，无归类。

### turn 2 首步推理原文

> 用户在问一个关于"重复待办提醒时间"的问题…问这是 bug 还是设计如此。
>
> **这是提问，需要回答。** 我需要查代码理解重复待办的生成与提醒机制。
>
> **先开工 SOP？这是提问，不是改代码。** 但要准确回答，需要读代码。走读代码路径。

三件事全做了：归类 → 否决默认反射 → 细分边界（只读不写）。

### 量化

| | turn 1（无检查点） | turn 2（有检查点） |
|---|---|---|
| 工具调用 | 28 次 | 16 次 |
| 推理步数 | 26 步 | 15 步 |
| 首步动作 | 直接跑 SOP | 先归类再决定 |
| 是否改代码 | — | 否（只读） |

**降幅 42%。** 同一问题、同一仓库，唯一变量是那条 199 字的注入。

### 顺带确认的事实

- 注入位置：`agent-instructions → runtime-context → skill-catalog → **hint** → time-context`，即用户消息后第四位
- 长度 199 字符
- 副作用：turn 1 用英文推理，turn 2 变中文——中文检查点把思考语言带过去了

---

## 十一、待办：检查点要重做

### 现版本的四个毛病

1. **把诊断压进了提问**。诊断（"为什么坏了"）要查证，提问（"这是什么"）不用。压在一起，要么该查的不查，要么不该查的乱查。
2. **没有"判断"这一类**。"A 还是 B"要的是推荐，不是选项清单。模型天生爱给选项——这是最典型的逃避决策。
3. **没有"否决"这一类**。用户说"不对"，模型要么辩解，要么连对的部分一起推翻。两种都伤。
4. **没有汇报节奏**。长任务每步汇报一次，是最消耗耐心的行为，文案一个字没提。

### 改法：换维度

不问"用户说的是什么类型的话"，问两个问题：

1. 这一轮要的是**答案**还是**改动**？
2. 方向**已经定了**还是**现在要定**？

四象限：

| | 方向已定 | 方向未定 |
|---|---|---|
| **要答案** | 解释、诊断、评审、调研 | 判断、选型、可行性 |
| **要改动** | 执行、修 bug、加功能 | 澄清、拍板前置 |

外加三个语气例外（优先级高于四象限）：

- **「继续」** → 不重新评估
- **「不对」** → 先确认哪里不对，别辩解也别盲从
- **「你看着办」** → 授权，别再问

### 新版文案草案

```text
【能力路由 · 当轮检查】

先判一件事：这一轮要的是**答案**还是**改动**？方向定了没有？

- 要答案 · 已定 → 直接给结论。查证是为了结论，不是为了显得勤奋。
- 要答案 · 未定 → 给推荐，加一句理由和代价。别列一堆选项让人自己挑。
- 要改动 · 已定 → 做。别边做边请示。
- 要改动 · 未定 → 问一个，附上你的推荐答案，问完就动手。

例外优先于上面四条：

- 「继续」→ 不要重新评估，接着往下做。
- 「不对」→ 先确认哪里不对，别辩解，也别把对的部分一起扔了。
- 「你看着办」→ 这是授权，别再问。

长任务只在阶段边界说话，不要每步汇报。汇报的粒度是「一个能验证的结果」，不是「我刚做了什么」。
```

约 330 字。另建议**拆成两段**：一段管"这一轮怎么回应"，一段管"这个活用什么干"（能力路由），各自短、各自聚焦。

---

## 十二、落地路线

| 步 | 做什么 | 验收标准 |
|---|---|---|
| 1 | 专家包格式 + 扫描器（读 `experts/`） | 能列出 5 个专家 |
| 2 | 写 5 个专家的 `expert.yml` + `role.md` | 人工审，边界不重叠 |
| 3 | 规则匹配器（触发词 + 描述），不调 LLM | 20 句话测命中率 > 70% |
| 4 | 命中后注入 role + 收窄技能目录 | 目录从 50 条降到 10 条左右 |
| 5 | 未命中的提示 | 说"帮我做视频监控"，它该说"没有干这个的人" |
| 6 | 造专家（可选，最后） | 缺口确认后生成 `expert.yml` 草案 |

前 5 步做完就能感觉到差别。第 6 步才是原框架的 `forge`。

---

## 十三、环境事实

- profile：`C:\Users\Alec\.dsh\profiles\desktop`
- `cordis.yml` 恒为注释 + `[]`，树由 `dsh.profile.bundles` → `cordis.patch.yml` → `--patch` overlays 组合；每次启动重写
- 备份：`cordis.patch.yml.bak-20261101-caprouter`
- DSH 重启后 Web GUI 端口会变（63384 → 63195 → 52631）
- `dsh --dump-config` 对 desktop profile 不可用：`profile "desktop" is managed exclusively by the Electron application`
- `~/.dsh/logs/` 只有 2026-10-19 的旧日志，**没有当前启动日志**。插件加载失败只能靠静态读源码或自己的 trace
- 本机技能来源：`C:\Users\Alec\.dsh\skills`（27 个）、`C:\Users\Alec\.claude\skills`（24 个）、插件目录
- 宿主工具名：`purge_apply` / `purge_revert` / `purge_status`（由 dsh-purge 注册）

---

## 十四、命名与术语

| 术语 | 含义 |
|---|---|
| 专家（expert） | 一个能独立交付的角色：role.md + 技能子集 + 触发词 |
| 软专家 | 不换 agent、只换装束的专家（对比 agent-preset） |
| 收窄 | 把技能设为 `modelInvocable: false`，名字保留、`/name` 仍可用 |
| 检查点 | `agent/pre-step` 注入的那条当轮提示 |
| 原则段 | `ctx.systemPrompt.section()` 注入的长期背景 |
| 全局技能 | 不进任何专家、永远可见的技能（调研、搜索、Office） |
