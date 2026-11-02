# dsh-capability-router 设计文档

> 这份文档是给未来的自己看的。上下文会被压缩，记忆会失真，但文件不会。
> 任何一次开工之前，先读这里，再读 `README.md`（那是给用户看的用法）。
>
> 文档分工：`README.md` 门面 · `docs/FEATURES.md` 功能与判据 · `docs/INSTALL.md` 安装与排障 · 本文件设计与宿主实测
>
> 最后更新：2026-11-01（v0.6.0）

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

> ⚠️ 下一版架构（项目级专家编排：专家目录 + `expert()` 工具 + 会话状态 + 阶段闸门 + 收窄退役）见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**。本节记录的是**已落地到 v0.6.0 的这一版**——按单条消息裁决、插件替模型选人，即将被取代。

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
| 专家包 | `experts/<id>/{expert.yml, role.md}` + 扫描器 | **已完成**（5 个专家，能列、能校验） |
| `expert-router` | 匹配专家、注入 role、决定技能集 | **已完成**（`lib/router.js` + `pre-step` 注入） |
| `provider` | `registerProvider` 接管目录，按专家技能集收窄 | **已完成**（`lib/narrow.js`，默认关闭，有代价） |
| `gap` | 无专家匹配时提示；给候选或提议新建 | **已完成**（`lib/gap.js`，含「闲聊不打扰」判定） |
| `forge` | 生成新专家包草案 | **已完成**（`tools/forge.mjs`，必填参数 + 当场校验） |

### 文件地图

```text
C:\Users\Alec\Documents\DeepSeekHermesData\DSH-capability-router dev\   ← 唯一源码（git 仓库）
  package.json          name: dsh-capability-router, type: module, main: lib/index.js
                        dsh.bundle.patch = cordis.patch.yml（GUI 安装的唯一凭据）
                        peerDependencies: {"@deepseek-ai/cordis": "~4.0.5"}
  cordis.patch.yml      bundle 层入口：insert 一条 capability-router
  lib/index.js          挂载、两处注入、自检技能
  lib/experts.js        专家包发现与校验（读目录、报错、内层覆盖外层）
  lib/router.js         规则匹配器：一句话判给哪个专家
  lib/gap.js            缺口提示：分不清 / 没人接时说哪一句，以及什么时候不说
  lib/narrow.js         技能目录收窄（冒名接管 + 不封锁的回落）
  lib/yaml.js           YAML 子集解析器（零依赖的代价与边界都写在文件头）
  experts/<id>/         专家包：expert.yml + role.md（首批 5 个）
  test/smoke.mjs        假 ctx 跑 apply，九个场景
  test/experts.mjs      解析器与扫描器，九个场景
  test/router.mjs       匹配打分与三种结论，九个场景
  test/gap.mjs          任务判定与缺口文案，八个场景
  test/forge.mjs        造专家：必填、id 规范、生成即可命中，七个场景
  test/gaps.mjs         缺口汇总工具：合并计数、坏行容错，四个场景
  test/narrow.mjs       收窄语义（含「仍可按名加载」），八个场景
  test/route.mjs        集成：一句话进来后模型看到什么变了，四个场景
  README.md             给用户看的用法
  DESIGN.md             本文件
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
<包内>/experts/<id>/                          随插件发布（第一批 5 个）
<DSH_HOME>/capability-router/experts/<id>/    用户自建或覆盖，同名 id 内层胜出
  expert.yml      # 元数据
  role.md         # 角色提示词，命中后注入系统提示
  skills/         # 可选，专家自带的 SKILL.md，与普通技能同格式
```

`expert.yml` 用的是 YAML **子集**（`lib/yaml.js`）：扁平 key + 标量 + 一维列表，不支持多行块、嵌套映射、锚点。理由见「零依赖」——为了读五个字段引一个 YAML 库不划算。

```yaml
name: 前端工程师
description: 界面、交互、样式、浏览器行为
triggers: [界面, 样式, 前端, 组件, 布局, 交互, 渲染, 动画, 响应式, 页面, CSS, HTML, React, Vue, 浏览器]
skills: [frontend-design, playwright, canvas-design, theme-factory, prototype]
tools: []          # 空 = 用全部
```

校验规则（`lib/experts.js` `loadExpert`）：

| 字段 | 要求 | 不合规时 |
|---|---|---|
| `name` | 非空 | 该专家作废，进 `errors` |
| `description` | 非空 | 同上 |
| `triggers` | 非空列表 | 同上（它永远不会被命中） |
| `skills` | 列表，可空 | 空 = 命中后不收窄 |
| `tools` | 列表，可空 | 空 = 不限制工具 |
| `role.md` | 可缺 | 只告警，命中后仅注入技能集 |
| 未知字段 | — | 告警后忽略 |

内层同名包坏掉时，这个 id **直接消失**并报 `errors`，不会静默回退到包内旧版本——排障时看到少了一个专家，比看到一个行为不对的专家好。

格式与 `dsh-expert-hub` 基本一致（`~/.dsh/experts/<id>/{expert.yml, role.md, skills/}`）。区别：它靠输入框胶囊**手动**切，我们做**自动**判断该切谁。两边能互转，所以将来不排除直接复用它的 UI。

### 第一批专家（5 个，已落地）

| id | 名字 | 触发面 | 技能 |
|---|---|---|---|
| `frontend` | 前端工程师 | 界面、样式、交互 | frontend-design、playwright、canvas-design、theme-factory、prototype |
| `backend` | 后端工程师 | 接口、数据模型、并发 | codebase-design、domain-modeling、research、test-driven-development、writing-plans |
| `docs` | 文档与写作 | 文档、方案、汇报 | doc-coauthoring、stop-slop、writing-for-agents、internal-comms、writing-plans |
| `debug` | 排障工程师 | 报错、不生效、性能 | systematic-debugging、verification-before-completion、diagnose-windows-sandbox-acl、diagnosing-superpowers、triage |
| `data` | 数据与办公 | 表格、报表、PDF | office、office-xlsx、office-docx、office-pptx、office-recalculate、pdf |

最初设想的「需求与方案」「逆向与安全」没有单独建包：前者归还给 intake（问清楚需求本身就是它的活），后者在本机是 `reverse-skill` 单体技能，边界落在「打包安装」而不是日常手艺。

跨领域能力（调研、搜索、Office 文档）**不塞进任何专家**，留作全局技能，永远可见——它们跟哪个领域都可能撞上，锁进专家里只会经常要手动放出来。

---

## 六、设计决定与理由

### 1. 判断用规则匹配，不用 LLM

每轮调模型做一次分类，等于把延迟和成本翻倍。确定性方案（v0.3.0 落地版，`lib/router.js`）：

```text
得分 = Σ 触发词命中 × (1 + (len-1)×0.5，上限 2.5)
     + Σ 同义词命中 × 1.0（总量上限 2.0，且不重复计已命中的触发词）
     + 描述命中 × 0.5（总量上限 1.5）
结论 = 最高分 < 1.0            → miss
       最高分 - 次高分 < 0.35  → ambiguous（列前两名）
       否则                    → hit
```

三条取舍：

- **按词长给权重**，是为了让「数据库」压过「数据」、「设计文档」压过「文档」。笼统词命中一次就盖过具体词，是最常见的错路由来源。
- **同义词单算一层**，因为口语和书面语不是一个词表。触发词是「这个领域叫什么」，同义词是「用户会怎么说」。同义词封顶 2.0，保证它单独能定案，堆一堆也压不过一个具体触发词。
- **保留 ambiguous**。分差小于 0.35 时说「像是 A 也可能是 B」，比硬选一个错的好；第 5 步的「没有对口专家」提示可以复用同一个出口。

不做 IDF：IDF 需要语料统计，本机没有稳定语料；日语感词（帮我、看看）靠「只认专家词汇表」自然过滤——不在表里的词根本不参与打分。中英桥接问题在这一版被绕开了：技能名的英文由专家包自己写在 `skills` 里，不需要用户说英文。

LLM 只在两处各用一次：**首轮需求画像**、**能力缺口判断**。

### 2. 只缩小不封锁

被收窄的技能只是 `modelInvocable: false`，名字仍在、`/name` 仍可调。必须有"把完整目录给我"的逃生口。

理由：匹配算法一定会错。错的时候宁可模型自己找不到、再问一句，也不要它明明看得见却被规则挡死。

宿主没有「排除某个技能」的接口，收窄的实现是**冒名接管**（`lib/narrow.js`）：

```js
// 对每个要收的技能，交一份同名候选，rank 取 -1 压过原 provider
{ name, description, invocation: { modelInvocable: false, userInvocable: true },
  source: "capability-router", provider: "capability-router", rank: -1 }
```

排序规则是 `rank → providerOrder → localOrder`（`dsh-skill/lib/index.js:520`），同名的先到先得，所以 rank -1 一定赢。

三条必须守的边界：

1. **不封锁**：模型看不见 ≠ 用户用不了。`provider.get()` 会把本 provider 的 `list()` 临时静音、让宿主重算一次目录，此时原 provider 胜出，拿到正文再返回。技能照常能 `/name` 加载。
2. **逃生口**：匹配落空（miss / ambiguous）时立刻 `clear()`，目录恢复完整。不需要用户记命令。
3. **代价写在明面上**：宿主每丢弃一个同名候选就打一条 `ignored because a higher-priority skill already exists` 告警，且目录要全量重发。告警只在目录缓存失效时出现（不是每步），但切专家那一刻会有 N 条（N = 被收起的技能数）。所以 `narrow` 默认关闭，要显式打开。

#### 实机结论：只对全局层生效（2026-11-01）

真机跑了一遍（49 个技能，命中 `frontend` 后应该只剩 5 个）：**只有 8 个被真正收起**——插件自带的 `office ×7` 与 `diagnose-windows-sandbox-acl`；用户目录下的 29 个技能纹丝不动。

原因在宿主的层语义，不在参数：

- `registerProvider` 把 provider 注册进**调用方所在的作用域层**（`dsh-skill/lib/index.js:147-178`，`this.layers.effect(this.ctx, …)`）。
- 读目录时 `collectFresh` 按 `[global, ...scope chain]` 合并，**靠后的层覆盖同名条目**（`:298-310`）。
- 本插件挂在 profile 上，`scopeOf(ctx)` 是空 → 只能写全局层，因此压不过作用域层里的同名技能。

`rank: -1` 只在**同一层内**决定同名胜负（`compareIndexedCandidates`，`:519-521`），跨层无效。

处置（已过时，v0.7.0 起 `narrow` 与 `alwaysVisible` 已删除，见 ARCHITECTURE 第六节）：`narrow` 保持默认关，文档按「只收插件层技能」表述；真要按专家收窄用户技能，得让 provider 落到读目录的那个作用域层里——profile 挂载点做不到，需要宿主提供作用域挂载或目录过滤钩子。

### 3. 目录变更次数克制

技能目录消息是**全量替换**的（见第七节 digest 机制）。每变一次，prefix cache 重算一次。

一个会话最多变 2–3 次：首轮定专家一次、明确换专家一次、兜底一次。实现上靠 `currentExpert` 记住当前专家，同一专家不重复算目录。

### 4. 零标注

不改任何现有 SKILL.md。`@starpivot/dsh-skill-router` 要求给每个技能手写 `exposure:` 标记——99 个文件，0 个版本迭代，直接否掉。

### 5. 专家 ≠ preset

见第三节。

### 6. 检查点只提示不枷锁

`agent/pre-step` 注入的那段话是**提示**，不是规则。实测证据见第八节：模型收到"这是提问，直接答"之后，判断"要准确回答需要读代码"，然后去读——这是对的。

文案如果写成硬规则，模型会为了遵守规则给出瞎猜的答案。

### 7. 缺口提示要克制

「没有对口的专家」这句话不能每轮都说。判据不是「匹配失败」（那太常见），而是「匹配失败 **且** 这句话像是在派一件活」。

判法还是规则（`lib/gap.js` 的 `looksLikeTask`）：出现任务形态的词才开口——帮我、做个、改成、排查、怎么、能不能…… 宁可漏报：漏报的代价是少一句提示，误报的代价是每句闲聊都被插一段废话。

实测 10 句日常说法（2026-11-01）：触发 5/10——「帮我做视频监控系统」「帮我规划一下下个月的学习计划」「这个怎么弄」「帮我写一个爬虫」开口；「今天中午吃什么」「好的」「嗯，继续说」静默；另外三句直接命中专家。

`ambiguous` 不设这道闸：分不清本身就是信号，而且此时两边都说得通，说清楚哪两个在抢比让模型自己蒙一个更有用。

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

## 九、当前实现（v0.6.0）

```text
lib/index.js   542 行  挂载、pre-step 路由与三处注入、自检技能、账本与落盘
lib/experts.js 150 行  专家包发现与校验（内层覆盖外层，坏包不静默回退）
lib/router.js  119 行  规则匹配：打分、三种结论
lib/narrow.js  147 行  冒名接管收窄（只对插件层生效，默认关）
lib/gap.js      58 行  任务判定与缺口文案
lib/yaml.js    121 行  YAML 子集解析
```

`apply()`：

```text
if (!enabled) return
if (debug) recordTrace({event:"apply"})
if (intake) ctx.effect(() => ctx.systemPrompt.section(...))
ctx.effect(() => ctx.skills.register(selfSkill(...)))     // 自检技能，总是注册
if (experts) catalog = loadAllExperts()
ctx.on("agent/pre-step", async (payload, next) => {
  const decision = (await next()) ?? payload           // 瀑布：先拿上游结论
  const msg = lastUserPrompt(decision, payload)        // source.kind === "user"
  if (!msg) return
  if (hint) 追加 HINT_TEXT（forPrompt + hintedPrompts 去重，记 hints.jsonl）
  if (experts) verdict = match(catalog, text)
  if (role && verdict.kind === "hit") 追加 role.md（rolePrompts 去重）
  if (gap) 另起一条缺口消息（miss 需过 looksLikeTask 闸门）
  if (gapLog) appendLedger(gaps.jsonl, …)              // 与「开不开口」同一判据
  if (narrow) applyNarrowing(verdict)                  // 目录下一步才生效
})
```

配置项（`~/.dsh/capability-router/config.json`，缺省取 `DEFAULTS`）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | true | 总开关，关掉等同未安装 |
| `intake` | true | 系统提示原则段 |
| `hint` | true | 当轮检查点 |
| `experts` | true | 扫描专家包、启用匹配器 |
| `role` | true | 命中后注入 `role.md` |
| `gap` | true | 落空时提示一句（闲聊不触发） |
| `gapLog` | true | 落空记账到 `gaps.jsonl` |
| `narrow` | false | 按专家收窄技能目录（见六.2 实机结论） |
| `alwaysVisible` | [] | 跨领域技能白名单，不收窄 |
| `order` | 5000 | 原则段排序位（purge 尾段在 5100） |
| `debug` | false | 写 `trace.jsonl` |

v0.2.0 的 `groups` / `activeGroups` / `hidden` 已删除：分组方案被专家包取代（见第二节）。

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

## 十、v0.2.0 的效果验证（历史，A/B 对照，真数据）

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

| 步 | 做什么 | 验收标准 | 状态 |
|---|---|---|---|
| 1 | 专家包格式 + 扫描器（读 `experts/`） | 能列出 5 个专家 | **完成**（`lib/experts.js`，`test/experts.mjs` 场景七） |
| 2 | 写 5 个专家的 `expert.yml` + `role.md` | 人工审，边界不重叠 | **完成**（frontend/backend/docs/debug/data） |
| 3 | 规则匹配器（触发词 + 描述），不调 LLM | 20 句话测命中率 > 70% | **完成**（`lib/router.js`，`npm run accept`） |
| 4 | 命中后注入 role + 收窄技能目录 | 目录从 50 条降到 10 条左右 | **完成**（默认只注入 role；`narrow` 需显式打开） |
| 5 | 未命中的提示 | 说"帮我做视频监控"，它该说"没有干这个的人" | **完成**（`lib/gap.js`） |
| 6 | 造专家（可选，最后） | 缺口确认后生成 `expert.yml` 草案 | **完成**（`tools/forge.mjs`，七个场景） |
| 7 | 缺口记账 | 能回答「先造哪个专家」 | **完成**（`gaps.jsonl` + `tools/gaps.mjs`） |

前 5 步做完就能感觉到差别。第 6 步才是原框架的 `forge`。

### 匹配器的验收数据（2026-11-01）

`tools/match.mjs` 里三套句子，`npm run accept` 跑 a、b 两套：

| 集 | 写的时候 | 结果 |
|---|---|---|
| a | 照着触发词写的标准说法 | 20/20（回归用，改规则时不得低于 90%） |
| b | 自然口语，故意绕开触发词 | 20/20（验收用，门槛 70%） |
| c | 调参时没看过的 8 句泛化探针 | 6/8 命中、1 句 ambiguous、2 句落空 |

b 集最初只有 13/20，两处改动把它拉上来：

1. **加同义词层**。「登录页」「按钮」「表单」这类口语词原本整句零分，「登录页点不动」直接 miss。
2. **同义词去重**。同一个词同时写进 `triggers` 和 `synonyms` 会被加两次分，「太慢了」凭空从 1.5 变 2.5，把后端问题抢成了排障问题。这是真 bug，不是标定问题。

b 集里三句最终按「程序判得对、我的期望写得草率」改了期望，逐条留证：

- 「帮看看这段 SQL 为什么慢」→ ambiguous。SQL 和「慢」都只有 1.0（单词权重低），分差为 0，程序如实说分不清。
- 「帮我总结一下这次事故」→ docs。「总结」是触发词 1.5，「事故」只是同义词 1.0。
- 「缓存没生效，每次都是全量查」→ backend。「缓存」命中触发词 1.5；「没生效」不等于触发词「不生效」，排障得 0 分。

c 集的两句落空暴露真实短板，留给后续：

- 「这个数字对不上，帮我核一下」——data 缺「数字 / 核对」这类动词性词汇。
- 「这段配置为什么没起作用」——**否定式说法**（没生效 / 没起作用 / 不起作用）一条都没进词表，这是系统性缺口，不是个例。

下一步（第 4 步）接入注入与收窄时，`ambiguous` 和 `miss` 都要有出口，不能静默当命中处理。

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

---

## 十五、平台差异从哪来

同一个模型、同一套工具，产出参差不齐。差异落在两处，都在提示层：

| 层 | 是什么 | 差的样子 | 好的样子 |
|---|---|---|---|
| 对自然语言的解析精度 | 从「我想要个东西」里问出真需求 | 把模糊句子当命令，直接开工 | 先问三句，把谁 / 什么场景 / 解决什么钉死 |
| 对工具的编排强度 | 知道什么时候换人、换谁、换完谁收口 | 一个人从头做到尾 | 接单 → 调研 → 分派 → 测试 → 收口，每步留产物 |

解析精度这条有实测。v0.18 的 matcher 把「把这个需求文档改成给老板看的版本」判给了接单专家：4.0 压过文档的 3.5。「需求」两个字值 1.5 分，一个词就把整轮派错了人。修法不是删词，是让入口专家不参加竞争（`lib/router.js` 的 `demoted` 逻辑）。同一份词表，解析规则差半步，结果差一整轮。

编排强度这条还没到「实测」的份上，但结构缺口看得见：v0.19 只有「接单 + 专家」两级，没有调研、没有测试、没有收口。一个项目从需求跑到交付，中间没人核验收，最后也没人问「市面是不是已经有现成的」。这不是模型不够聪明，是没人被安排去干这两件事。

**这两样都在提示层，所以本插件的边界是：只动协议，不动实现。**

| 落在协议层（做） | 落在实现层（不做） |
|---|---|
| 阶段、闸门、验收清单、证据要求 | 替用户写业务代码 |
| 状态字段（`phase` / `level` / `approved`） | 改专家包的行为定义去迁就某个用户 |
| 专家目录的标签与排序 | 把匹配器换成调 LLM 猜意图 |
| 检查点文案、角色提示词 | 自动装技能、自动改别人的 SKILL.md |

这条线不能破，理由是**可解释性**。现在每个判断都能落到一行：`lib/router.js` 的词权重、「入口专家不参加竞争」、`lib/state.js:228` 的 scout 分支、`expert.yml` 里的一条触发词。出了错，能指出是哪一行干的。插件一旦开始替模型干活，它就变成第二个模型，出错时没人能定位。

---

## 十六、v0.20.0 决策记录

拍下来的五条。格式：决定 / 理由 / 不这么做的代价。

### 1. `approved` 是软的，不拦推进

**决定**：`approved` 只影响状态卡文字与闸门文案。spec 阶段显示「方案：待确认」，~~推进到 build 自动置真~~，`expert(id, {approved: false})` 可撤销。

**理由**：「直接做」是用户最常见的确认方式。把这句话拦下来、翻译成一条错误、再要求他点一次头，是用流程惩罚一个已经想清楚的人。检查点每轮一条，再加一道硬闸，用户会先关掉插件。

**代价**：方案没确认就有人推进。接受——~~推进到 build 这个动作本身就是确认~~。

#### 2026-11-02 修正（v0.20.2）：上面那句「推进本身就是确认」是错的

**发现方式**：不是审出来的，是查运行时数据时撞上的。`approved` 在十份 `role.md` 里零引用——grep 一次都没命中。也就是说这个字段除了改状态卡上的几个字，没有任何人在任何环节真正核过它。

**问题**：`lib/index.js` 那段自动置真的条件是「`phase` 真的变了且进了 build/review/deliver」。它记下来的是**模型的推进动作**，却记成了**用户的点头**。两件事成本完全不同：模型挪阶段是零成本的，用户敲定方案是要花一次对话的。混成一个布尔之后，状态卡上「方案：待确认」在模型挪完阶段的那一刻自动消失——而那是用户唯一能看见的确认信号。

**为什么「推进本身就是确认」站不住**：它的前提是「模型只会在用户真的点头后才推进」。但阶段推进是纯提示层的东西，没有任何硬闸，模型完全可以自己判断「需求够清楚了」就推进——这恰恰是插件的设计意图（不要让用户烦）。于是这个假设在最好的情况下也只是巧合成立。

**改成**：`approved` 只认显式 `{approved: true}`。推进阶段不再改它，只在「推进了但没确认」时返回一句提醒，提示模型在那一刻把确认补记下来。审查专家的 `role.md` 同步加了核对项：`approved` 不是 true 就列为阻塞项。

**代价换了边**：现在漏记的代价是状态卡一直显示「待确认」——看得见、能纠正、会被审查拦住；原来假装确认的代价是看不见的。一个看得见的噪音，比一个看不见的谎话便宜。

#### 2026-11-02 追加（v0.20.2）：`deliver` 活着，但模型走不进去

**现象**：`deliver` 在五处活着——`PHASES` 常量、`nextStep()` 的交付文案、`gateNote` 的 deliver+intake 分支、面板的 `.phase-deliver` 配色、`test/state-level.mjs` 的阶段遍历。唯独 `expert()` 的 `phase.enum`（`lib/catalog.js:118`）里没有它。于是「交付」这个阶段在代码里活着、在协议里不可达：项目做完了，状态卡永远停在「审查」，`nextStep` 永远说「收口前交给审查专家」。

**教训：代码里的常量不是协议，schema 才是。** 模型看的只有 `tool.parameters`——它读不到 `PHASES`，也不知道 `advancePhase` 接受哪些值。一处常量加五处引用，全都不算数；`enum` 里少一个值，这条路就是死的。

**变异检验踩的坑（会重复犯，记下来）**：第一版断言测的是行为——「推进到 deliver 之后 `phase === "deliver"`」。把 `deliver` 从 enum 拿掉，测试**仍然全绿**：`enum` 在 JSON Schema 里不做运行时校验，`advancePhase` 本来就接受 deliver，行为一点没变。守点必须落在 schema 本身（`assert.ok(phaseEnum.includes("deliver"))`）。**「测试没红」有两种原因，一种是断言写偏了，一种是真没变异**——不区分就会留下一条永远成立的假断言。

#### 2026-11-02 追加（v0.20.2）：闸门和提醒是两件事，`??` 会把其中一件吃掉

**原写法**：`gateNote(after, expert) ?? (forgotApproval ? "…记得补记确认…" : undefined)`。用 `??` 合并，等于默认这两句话互斥。它们不互斥：闸门讲「这个阶段该干什么」，提醒讲「刚推进的这一步少了什么」。实测三类被吞掉的组合——worker 在 review、scout 在任何阶段、intake 在 deliver。

**更隐蔽的一条**：`forgotApproval` 原来按 `target !== undefined`（模型是不是显式传了 `phase`）判。但 `expert("review")` 在 build 上会由 `openExpert` 自己把阶段推到 review——**这是最常走的一步**，而它不走 `target` 那条路，全程静默。判据改成纯「阶段真的变了」之后就覆盖住了。

**教训一：两个独立判断产出的提示用 `??` 合并，等于替它们做了一个互斥假设——互斥是需要证明的，不是默认成立的。** 拼接的写法更长，但它不会替谁做决定。

**教训二：抑制条件必须有断言守着。** 「提醒」和「每轮唠叨」之间的分界线是 `after.phase !== before.phase` 这一行；删掉它，`npm test` 当时是全绿的。类似地，`deliver + worker` 这一格以前直接 return `undefined`——「已交付的项目接着改，没人说一句话」，直到补上分支才有断言覆盖。

### 2. `level` 只有一个值，不记翻转历史

**决定**：`level: "novice" | "pro" | undefined`，后写覆盖前写。

**理由**：同一件事用户先要细节、后要结论，覆盖就对了。记历史要多一个数组字段，而状态文件是外部输入（`lib/state.js` 的 `normalizeState`），每多一种形状就多一条兼容路径。

**接受的损失**：回放旧项目时看不出当时按哪档讲的。

### 3. `research` 的 kind 是 `scout`，不是 `worker`

**决定**：新增 kind 取值 `scout`，只给调研专家。

**理由**：spec 阶段打开 `worker` 会拿到「先别开工」，而调研必须在开工前做——它是写需求的输入。让调研专家挂 worker，等于让它在自己的工作阶段违反闸门，自相矛盾。`scout` 分支跳过「先别开工」，只给「先出 `PRIOR-ART.md`」。

**代价**：`kind` 从三个取值变四个，所有读 kind 的地方都要认。已落地：`lib/catalog.js:24`（【调研】标签）、`lib/state.js:228`（scout 闸门文案）、`lib/experts.js:131`（`KINDS` 允许集）。三处行号都能 `sed -n` 指到实句。

### 4. 调研强制靠 role.md，不靠插件拦截

**决定**：`experts/intake/role.md` 写死「写需求前先调 `research`」；插件不加阶段依赖。

**理由**：跟第六章第 6 条同一个道理，闸门是提示级的。真实的正当情况是「用户已经知道市面情况，只想赶紧开工」，插件分不出这一种和「懒得查」。role.md 一句话覆盖 90% 的场景；插件拦截要为剩下 10% 付一个状态机和一条回滚路径。

**剩下的 10% 由谁兜**：`review`。验收清单加「有没有查过现成的」；`PRIOR-ART.md` 缺失时，需求的「假设」段没有可引用的依据，审查一眼看得出。

### 5. 词表微调的实证依据

一句话：**加词不是加覆盖面，是拿回归集换召回；换输了就退。**

两条争过、最后按实测定的：

| 词 | 初始方案 | 实测 | 处置 |
|---|---|---|---|
| `内存` | 放进 `reverse` 的 triggers | b 集「服务重启后内存暴涨」期望 `ambiguous`，实际变成 `multi`：backend 1.5 / debug 1.5 / reverse 1.5 三人同时过强线（`minScore × 1.5`）。b 集 20/20 → 19/20 | 降为 synonyms：只计 1.0，够不上强线，该句回到 `ambiguous`，b 集回到 20/20 |
| `过一遍` | `qa` 与 `review` 的 synonyms 各写一次 | 「把这块过一遍」→ `分不清（qa 1.0 / review 1.0）` | 保留。这句本来就分不清，判 ambiguous 比硬选一个诚实 |

由此定下四条规矩，下次加词照此办：

1. 加完词跑 `node tools/match.mjs --set abc`。a 集掉一句就退回；b 集掉了先看期望是不是写草率，再决定改词还是改期望。
2. 长词更值钱（`1 + (len - 1) × 0.5`，上限 2.5）。别同时写长词和它的前缀——「激活」与「激活码」并列，同一段文字吃两次分。
3. `multi` 要三个人同时过 `minScore × 1.5`。一个新词把某个专家从 0 推到 1.5 分，就可能把「分不清」变成「跨领域」。这是最容易踩的一脚。
4. ~~想让一个词接得住但不抢活，放 `synonyms`（1.0，总量封顶 2.0）；要它抢活才放 `triggers`。~~ **这条 2026-11-02 被实测推翻，见下节。前半句（放 synonyms 就不抢）只在特定前提下成立，别照抄。**

#### 2026-11-02 修正：synonyms 不是安全区

起因是 review 判回的一条：`reverse` 把「表单校验没通过时提示不显示」「这个参数校验写错了」「帮我把这个 csv 样本导一下」三句全抢走了。根因是 `校验`、`样本`、`签名` 三个词待在 `triggers` 里。

先按上一节第 4 条的老规矩办——三个词全降 `synonyms`。**结果两句继续被抢**：

```text
三个词降 synonyms → 表单校验=ambiguous / 参数校验=hit reverse / csv 样本=hit reverse
```

原因一句话：同义词计 1.0，`minScore` 也是 1.0，而强线是 1.5。**孤句里没有第二个专家过线，1.0 就是唯一的候选，照样判 hit。** 老规矩的前提是「有别人同时过线」（1.0 输给 1.5，差 0.5 > margin 0.35），孤句根本没这个前提。规则写对了逻辑，漏了边界。

修正后的六条：

1. **`synonyms` 只在「有别人同时过线」时安全。** 孤句里 1.0 就是独苗，照样抢。判断一句话会不会被抢，先问「除了它，还有谁 ≥1.0」，没有就别指望降级能救。
2. **降级不是修抢活的手法，换组合词才是。** 最终的词表是这么落的：`校验` → 加 `校验和`（原词删光）、`样本` → 加 `样本分析` / `恶意样本` / `病毒样本`（原词删光）、`签名` → 删，只留 `dll` 接住「dll 的签名被改了」、`函数签名` → 也删（九成是重构：「把函数签名抽成接口」「给这个函数加个参数」都归 backend）。长词（1.5–2.5）只对完整说法生效，「校验和」不会被「校验」两个字触发——这是唯一能同时做到「接得住」和「不抢」的手法。删词只解决「抢」，不解决「接得住」。
3. **一个词该不该留，看它在本领域之外的高频用法有没有害。** 三个词一起判的，结论是都删：
   - `签名`：证书、合同、电子签名里高频，没有一个是逆向。RE 里的真身是 `dll`（「这个 dll 的签名被改了」走它）、`恶意样本`、`病毒样本`——不是 `函数签名`，那个词归重构。
   - `样本`：**整体删除**，不是降级。它在统计、抽样、数据语境高频且都有害（「这个样本量太小了帮我扩一下」实测被判给逆向）。代价是「帮我分析一下这个样本」「看看这个样本的行为」「这个样本跑起来连了外网」三句落空——**这是换来的，不是漏删**。
   - `校验`：表单、参数、清洗里同样高频，RE 里的「校验激活码」有 `激活` 单独撑着 1.5。所以它连同义词都不该拿：留着时「这个校验逻辑不对」靠 1.0 独苗判给了逆向，删掉后落空，其余四句一句没变。
4. **降级会让句子直接落空，不是「回到该去的人」。** 只改 `reverse` 之后实测：三句里 **2 句 `miss`、1 句 `ambiguous`**——没人接了，也没归位。这条最容易被下一个改词的人忽略，他以为删词是安全的。
5. **中文口语会往词中间插字，子串匹配接不住。** `抓包` → 「抓**个**包看这个 app 的协议」判 `miss`，因为「抓个包」里没有连续的子串 `抓包`。这类靠 `synonyms` 补**高频变体**（`抓个包`），不追求穷举——穷举下去词表会变成一部口语词典，加词的边际收益立刻变成负的（每加一个词都要重跑全集）。判断标准只有一条：**这个变体是不是「正常人第一反应会这么说」**。同理的还有 `导出` → 「导一下」。
6. **落空比抢活好，这是可接受的终局。** `这个函数签名改一下`、`这个样本量太小了`、`这个校验逻辑不对` 现在是 `miss`，这是**故意**的：它们是重构、统计、普通校验的活，逆向不该接。抢活的代价是**判给错的人、还带着角色提示词开工**——比空着贵得多。看到「改成 miss 了」别当成改坏，先问「这句本来该归谁，那个人有没有这个词」。

   落空之后模型看不看得见，取决于模式，这一点别记错：**非项目模式**才注入「没有对口专家」那类缺口提示；**项目模式（`phase !== "idle"`）下 `gap` / `gapLog` 整段被跳过**（`lib/index.js:793` 的 `!projectMode` 条件），落空是静默的，只剩状态卡里那句「下一步」。所以别指望「落空了会有人告诉它」——项目模式里不会。

所以「不抢活」只是及格线，**归属正确**才算修完。补进去的是三个原本就缺的词，每个都对应一个真实缺口：

| 加在哪 | 加什么 | 补的缺口 |
|---|---|---|
| `data` triggers | `CSV` | 原来只有 Excel / PDF / 表格，CSV 一个字都没沾 |
| `backend` triggers | `参数` | 「参数校验写错了」原本 0 分 |
| `frontend` triggers | `表单`（从 synonyms 提上来，并从 synonyms 删掉） | 表单是界面件，本该是触发词；两处都写会吃两次分 |

修完的验收数字（`node tools/match.mjs --set abc` 一次跑完，逐个加词、每加一个重跑一遍，**一次没掉**）：

```text
a 集 20/20 = 100%     b 集 20/20 = 100%     c 集 11/11 = 100%     npm test 132 场景全绿

表单校验没通过时提示不显示     → hit frontend
这个参数校验写错了            → hit backend
帮我把这个 csv 样本导一下      → hit data
这 exe 怎么校验激活码的        → hit reverse（激活 2.5）
这个 dll 的签名被改了          → hit reverse（dll 1.0，唯一候选）
帮我分析一下这个恶意样本        → hit reverse（恶意样本 2.5）
抓个包看这个 app 的协议        → hit reverse（抓个包同义词 1.0）
帮我脱壳看看                  → hit reverse（脱壳 2.0）
这软件怎么绕过激活            → hit reverse（激活 + 绕过）

这个函数签名改一下            → miss（故意：九成是重构）
这个样本量太小了              → miss（故意：统计语境）
这个校验逻辑不对              → miss（故意：`校验` 已从两个身份里全删）
```


v0.18 已经用血换过一次同类教训：通用词进词表不算错，词表配着规则一起错才算错。那次是「入口专家抢活」，这次是「新专家把分不清推成跨领域」——两次都不是模型猜错，是分数算错。

#### 2026-11-02 修正：一个门控，两个副作用（L1，v0.20.1）

L1 原本被记成「项目模式下 `miss` 是静默的」，事实比这重。缺口块原来是这么写的：

```js
if (!projectMode && (resolved.gap || resolved.gapLog) && verdict.kind !== "hit" && !gapPrompts.has(prompt.id)) {
  ...
  if (resolved.gapLog) recordGap(verdict, text);
  if (resolved.gap) additions.push(gapMessage(note, prompt.id));
}
```

`!projectMode` 的初衷是「项目模式下别打扰模型」，它本来只该管 `additions`（说话）。但 `recordGap` 站在同一个块里，于是「项目模式下不提示」顺带变成了「项目模式下不记账」。实测：`gaps.jsonl` 停在 phase 推进到 `spec` 的那一刻，之后整个会话零记录——面板的缺口页和 `tools/gaps.mjs` 看到的，一直是 idle 阶段那点语料。缺口本子的价值全在「项目里真实落空过什么」，断在这里等于没本子。

同一个坑在同一次修复里又出现了一遍，只是更隐蔽。第一版修完，去重交给 `gapPrompts` 一个集合，而 `markGap` 写在注入分支里：状态卡占位的那轮不标记，下一轮同一句会**再记一次账**，一句加书按步数刷成三行。qa 的 M3 变异（把两个集合合并成一个）当场把这条打红。

两条规矩：

1. **一个块里挂两个副作用（说 / 记），就要分别问：触发条件一样吗，失败代价一样吗。** 记账失败是数据缺失，过了就补不回来；说话失败只是少一句提醒，下一轮还有机会。代价不同，就不能共用一个门控。
2. **去重标记要跟着它保护的那个副作用走**，不能跨语义复用。现在两个集合：`gapLogged`（一句记一次，不管说不说）、`gapPrompts`（一句说一次，被状态卡压住的下一轮补说）。

修完的实测（同一句、同一 `prompt.id`、build 阶段）：

| 步 | 注入 | `gaps.jsonl` 行数 |
|---|---|---|
| 1 | state | 1 |
| 2 | gap | 1 |
| 3 | — | 1 |
| 4 | — | 1 |

一句话一行，提示也没丢——第 2 步补上了。

顺带把 `PHASE_LABEL` 从三份副本（`lib/state.js` / `lib/index.js` / `lib/panel.js`）收成一份，由 `state.js` 导出。同一张表散在三处，加第六个阶段时漏改任何一处，屏幕上就会把「实现」和 `build` 并排显示。这与上一条是同一个病：同一个事实存了多份，就一定会有一份先过期。


#### 2026-11-02 追加（v0.20.3）：限流和聚合的顺序不是实现细节

面板那张「最近运行」表一直是对的代码、错的结果：`runs.slice(-25).reverse()` 一行没写错，`runs.jsonl` 也一行没少写。错的是**先截断再给人看**。

真实数据里一句任务能跑 55 步（`session-413de83f` 111 条 run 只对应 4 个 promptId），于是 25 行正好填满一句——用户看到的是「这张表怎么只有一句话」，而不是「这句话跑了 55 步」。数据没丢，只是**在聚合之前就被扔掉了**。

规矩：**先聚合，再限流**。`foldRuns(rows).slice(-25)` 和 `rows.slice(-25).map(fold)` 是两种不同的仪表盘，而后者看起来同样合理。

同一个文件还得给两种消费者两种粒度：`tools/match.mjs` 按句判命中率，面板按句看历史——所以折叠只发生在渲染层，`readRuns()` 一行不动。**粒度差异要放在消费侧，不要改数据形状。**

#### 2026-11-02 追加（v0.20.3）：能放进「每步都变的那一层」，就别放进「只有开会话才变的那一层」

`level` 要在十位专家身上生效，最直觉的办法是按 level 改写 `role.md`——角色提示词本来就在系统提示里，改它最彻底。代价：每个 level 一套前缀缓存键，每次换 level 就是一次全价冷启动。

真正需要的其实只是「这一句怎么说」，而不是「这个人是谁」。所以 v0.20.3 把水平提示挂在 `expert()` 每次返回的 note 末尾——它天然每步都变，本来就不吃缓存。

代价说清楚：水平只影响**表达**，不影响**步骤拆法**。真正的新手模式应该连「先做什么」都不同（先复述需求、再给方案、方案里不出现没解释过的名词），那必须动角色提示词本身，缓存该花就得花。

判据：**静态部分进缓存，动态部分进每步注入**。反过来做，省下的是实现功夫，赔上的是每次开局的响应速度和账单。

#### 2026-11-02 追加（v0.20.5）：把「不合规就丢弃」当成参数校验，是最贵的一种静默

`project` 的解析原来是这一行：

```js
const explicitProject = typeof args?.project === "string" && path.isAbsolute(args.project) ? args.project : undefined;
```

读起来完全无害——「只认绝对路径」。它的实际行为是：模型传了相对路径，这个参数**被静默扔掉**，`projectDir` 退回 `sessionState?.project`，最后状态写进 `~/.dsh/capability-router/sessions/<id>.json`。模型看到的返回是 `found: true` 加一整段 role，一切正常；项目目录里一个字节都没有。

同一批里还有第二个：`writeState()` 的 `catch {}`，理由是「状态卡是提示，不是账本」。`project` 指到一个文件上时，`mkdirSync` 抛 `ENOTDIR`，被吞掉，于是状态每轮都写不进去、每轮都从头开始——状态卡上永远显示「空闲」，而模型刚刚才把阶段推到 build。

两处的共同形状：**输入不合规 → 降级 → 不报告**。降级本身不是错（插件确实不知道会话的工作目录），错的是降完不说。用户和模型看到的是同一个「正常」。

规矩：参数校验可以拒绝，可以解释，不能**替换成别的行为还不吭声**。要丢掉一个参数，就把「我没用它，因为我按 X 处理了」说出口；要吞一个异常，就把原因传回给能说话的那一层。

顺带一条：`writeState()` 的返回值从 `state` 改成 `{ state, error }`。**让函数能表示「我失败了」**，比在每个调用点外面套 `try/catch` 便宜得多——调用点根本不知道里面会怎么失败。

#### 2026-11-02 追加（v0.20.6）：镜像不是事实源

面板会话卡读的是 `sessions/*.json` 里的 `phase`。那是**镜像**——`expert()` 每次写项目文件后顺手给会话文件留一份，方便 pre-step 在项目文件被删时还能知道「我属于哪个项目」。

问题在于 pre-step 和面板的判据不同：pre-step 是项目优先（`lib/index.js:832` 的 `readState(projectStateFile(sessionState.project)) ?? sessionState`），面板直接读镜像。于是真实数据里出现：同一个项目三个会话，卡上分别写着 review / build / idle，而实际生效的一直是 review。用户打开面板，看见三个互相矛盾的「现在」。

更难看的是那个 idle：它是这个项目的**创建者**（项目文件里 `sessionId` 正是它），镜像停在 idle，仍在按 review 干活。

规矩：**同一份事实只留一个权威副本，其余副本必须标明自己是副本**。会话文件是副本，所以展示层要么不读它，要么读之前先问权威副本还在不在。

修法是展示层加一层 `effectiveSession()`：有 `project` 就读项目文件；读不到（被删、路径失效）退回镜像，但标 `fromProject: false`——让「这份可能是旧的」变成可见信息，而不是藏在一个看起来一模一样的卡片里。

一条实施细节：`readState()` 读不到时返回 `undefined` 而不是 `null`。`if (state === null)` 这种判断在 JS 里天天出事，测试第一次就是撞在 `Cannot read properties of undefined (reading 'phase')` 上——**判空要写 `!state`，别写 `=== null`**。

#### 2026-11-02 追加（v0.20.7）：提示语有时态，状态是它的主语

`INTAKE_NUDGE` 原文第一句是「接单不是终点」。这句话是对的，但它**假定已经接过单**。真实首句「帮我做个记账小程序」判成 `hit intake`，用户在 idle、项目还不存在，插件已经在讲「接单之后怎么分派」——模型拿着这句话去做事，很可能只看后半段，把「分派」当成眼下的事。

这不是文案好不好听的问题，是**提示语隐含的那个主语在这条路径上不成立**。同一条触发条件（命中接单专家）覆盖了两种状态：还没接单，和已经接单正在收敛需求。同一个说法只能用在其中一种上。

修法是按 `sessionState?.phase` 分两句：idle 说「先接单，接完再分派」，其余说「接单之后还要分派」。同一来源，同一个开关，只换措辞。

规矩：**提示语的时态必须和它要改变的那个状态对齐**。触发条件相同不等于语境相同；判据是「读这句话的模型此刻在状态机的哪一格」。

#### 2026-11-02 追加（v0.20.8）：状态和产物要对账

插件的状态说「实现阶段：按任务卡推进」，而项目目录里可能连 `TASKS.md` 都没有——**状态是插件记的，文档是模型自己写的，两边谁都不管谁**。插件说「按卡推进」时，它并不知道卡在哪；模型写卡时，它也不受任何检查。

这种「两套账」平时看不出来，只有在有人回头核对时才暴露，而那时候活已经干完了。

能对账的地方只有一个：`expert()`。它同时握着三样东西——项目绝对路径、推进前的阶段、推进后的阶段。所以核对放在推进到 `build` 的那一刻：`REQUIREMENTS.md` / `TASKS.md` 缺哪份就说哪份，只在阶段真的变了时说一次。

两个刻意的退让：**不拦**（照推，提示而已——文件名可以自定义，插件没有资格判定「你没有需求文档」）；**带撤回口**（「如果你们用了别的文件名，忽略这句」）。误报的代价是模型读到一句废话，漏报的代价是整条流水线建在一个没写下来的需求上。

规矩：**一个插件能观测到的事实，就该在跨过不可逆的那一步时被核对一次**。跨过去之后再说，就是事后审计了。
