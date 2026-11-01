# 功能说明

这份文件回答一个问题：**这个插件现在到底会做什么、在什么条件下做、有什么代价。**

设计取舍与宿主 API 的实测记录在 [DESIGN.md](../DESIGN.md)；安装与排障在 [INSTALL.md](./INSTALL.md)。

适用版本：v0.6.0 · 宿主 DSH Desktop 0.2.1（`@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.5）

---

## 一、它插在哪

所有动作都挂在一个钩子上：`agent/pre-step`。它是瀑布式（waterfall）的——先 `await next()` 拿到上游的结论，再决定要不要往 `decision.messages` 末尾追加消息。

```text
用户发一句话
   ↓
agent/pre-step（本插件在这里）
   ├─ 1. 找「真人那句话」（source.kind === "user"）
   ├─ 2. 规则匹配 → 命中哪个专家
   ├─ 3. 命中 → 注入该专家 role.md           （role，默认开）
   ├─ 4. 落空 → 判「像不像一件活」           （gap，默认开）
   ├─ 5. 落空 → 记账到 gaps.jsonl            （gapLog，默认开）
   ├─ 6. 命中 → 按专家收窄技能目录           （narrow，默认关）
   └─ 7. 每条消息 → 追加一段当轮检查点       （hint，默认开）
   ↓
模型看到的上下文
```

另有一条独立通道 `ctx.systemPrompt.section()`，注入长期原则段（`intake`，默认开）。

---

## 二、能力清单

| 能力 | 开关 | 默认 | 注入消息的 `source.kind` | 落盘 |
|---|---|---|---|---|
| 长期原则段 | `intake` | 开 | —（进系统提示） | — |
| 当轮检查点 | `hint` | 开 | `capability-router-hint` | `hints.jsonl` |
| 专家路由 + 角色注入 | `experts` + `role` | 开 | `capability-router-role` | — |
| 缺口提示 | `gap` | 开 | `capability-router-gap` | — |
| 缺口记账 | `gapLog` | 开 | — | `gaps.jsonl` |
| 技能目录收窄 | `narrow` | **关** | —（改目录） | — |
| 诊断记录 | `debug` | 关 | — | `trace.jsonl` |
| 总开关 | `enabled` | 开 | — | — |

`enabled: false` 时插件只挂一个空壳：不注入、不扫描、不挂钩，行为与未安装完全一致。

---

## 三、长期原则段（`intake`）

`ctx.systemPrompt.section()` 注册一段系统提示，`order: 5000`（排在 dsh-purge 的尾段 5100 之前）。

内容是「能力路由」的长期协议：需求有空白先问、能力对不上先说、开工前扫技能目录。它的作用是**背景设定**——模型在长对话里回头翻上下文时还能找到依据。

代价：常驻，每轮都在提示里。大概 200 字。

---

## 四、当轮检查点（`hint`）

每条用户消息后面紧跟一条消息，形状与宿主自己造的用户消息一致：

```js
{
  role: "user",
  id: randomUUID(),
  content: [{ type: "text", text: HINT_TEXT }],
  source: { kind: "capability-router-hint", form: "notice", forPrompt: <该用户消息 id> }
}
```

正文是让模型先归类再动作：**提问**直接答、**命令**有黑洞先问一个、**报告**接着做。

三个实现细节：

- **怎么认出「真人那句话」**：`source.kind === "user"`。`agent-instructions`、`runtime-context`、`skill-catalog`、`time-context` 也都是 `user` 角色，只能靠 kind 区分。
- **怎么去重**：`forPrompt` + 模块级 `Set`（上限 500，超出只留后一半）。工具调用跑多少步，同一条用户消息只注入一次。
- **注入的消息不进会话历史**：`pre-step` 追加的消息只活在当步上下文里，所以 `hints.jsonl` 是唯一的落地证据。

---

## 五、专家路由（`experts`）

### 专家包

一个目录就是一个专家：

```text
<包内>/experts/<id>/                          随插件发布（改它要动源码）
<DSH_HOME>/capability-router/experts/<id>/    用户自建或覆盖，同名 id 以内层为准
  expert.yml     name / description / triggers / synonyms / skills / tools
  role.md        命中后注入的角色提示词
  skills/        可选，专家自带技能
```

`expert.yml` 用 YAML 子集解析（`lib/yaml.js`）：扁平 key、标量、一维列表。不支持多行块 `|`/`>`、嵌套映射、锚点——要长文本写进 `role.md`。

校验规则：

| 情况 | 结果 |
|---|---|
| `name` / `description` / `triggers` 任一为空 | 判无效，进 errors，该专家不出现 |
| 缺 `role.md` | 只告警，命中后只注入技能集 |
| 未知字段 | 告警，忽略 |
| 内层同名包坏了 | **直接消失，不退回包内旧版本** |

最后一条是刻意的：少一个专家，比悄悄用错一个专家好。

自带五个：`frontend` 前端工程师、`backend` 后端工程师、`docs` 文档与写作、`debug` 排障工程师、`data` 数据与办公。

### 匹配算法

纯规则，不调模型（`lib/router.js`）：

```text
触发词命中    每个 1 + (词长-1) × 0.5   单专家上限 2.5
同义词命中    每个 1.0                  单专家上限 2.0（已当触发词命中过的不重复计）
描述命中      每个 0.5                  单专家上限 1.5

最高分 < 1.0           → miss
最高分 − 次高分 < 0.35 → ambiguous（列前两名）
否则                   → hit
```

三个设计点：

- **按词长加权**，让「数据库」压过「数据」、「设计文档」压过「文档」。笼统词盖过具体词是最常见的错路由来源。
- **triggers 与 synonyms 分工**：`triggers` 写「这个领域叫什么」，`synonyms` 写「用户会怎么说」（登录、按钮、表单这种）。同义词权重低一档，命中两个才顶得上一个触发词。
- **不重复计分**：同一个词既在触发词表又在同义词表时只按触发词算。这条是修 bug 修出来的——「太慢了」曾因为重复计分把分数从 1.5 抬到 2.5，抢了别的专家。

三种结论都是正常结果。**`ambiguous` 不是错误**：分差太小的时候说「像是 A 也可能是 B」，比硬选一个错的好。

### 验收集

```bash
npm run accept               # a 集（按触发词写的回归）+ b 集（自然口语，门槛 70%）
node tools/match.mjs --set c # c 集（未参与调参的泛化探针）
```

当前：a 20/20、b 20/20、c 8/8。

b 集有三句曾判「不一致」，复核后是期望写错了、程序判得对，已改期望并留证：「SQL 为什么慢」→ ambiguous（两个信号都是 1.0）、「总结这次事故」→ docs（触发词 1.5 压过同义词 1.0）、「缓存没生效」→ backend（「没生效」≠ 触发词「不生效」，后来补进 synonyms）。

---

## 六、角色注入（`role`）

命中专家后，把该专家的 `role.md` 作为一条 user 消息追加：

```js
{
  role: "user",
  id: randomUUID(),
  content: [{ type: "text", text: "【能力路由 · 当前专家：前端工程师】\n\n# 角色：前端工程师…" }],
  source: { kind: "capability-router-role", form: "notice", forPrompt: <用户消息 id>, expert: "frontend" }
}
```

- 一条用户消息只注入一次（独立账本 `rolePrompts`）。
- 没命中、缺 `role.md`、或 `experts: false` 时不注入。
- **实机验证过**：2026-11-01 在 DSH Desktop 0.2.1 上收到过完整的 `frontend` 角色消息。

和检查点的区别：检查点说的是「怎么处理这句话」，角色说的是「你是谁、按什么标准交活」。两者可以同时出现，顺序是**角色在前、检查点在后**。

---

## 七、缺口提示（`gap`）

匹配落空时说一句，分两种：

**分不清**（`ambiguous`）：

```text
【能力路由 · 分不清】
这句话同时落在「前端工程师」和「排障工程师」的地盘上，两边都说得通。
挑一个开始做就行——选错改起来不贵；真拿不准就问一句再动手，别两边各做一半。
```

**没人接**（`miss`，且这句话像在派活）：

```text
【能力路由 · 没有对口的专家】
现有专家：后端工程师、数据与办公、排障工程师、文档与写作、前端工程师——都不是干这个的。
直接告诉用户「我手上没有干这个的人」，并说清缺的是什么；不要拿相近的技能硬凑，也不要假装做过。
如果这活以后会反复出现，可以提议建一个专家包：`node tools/forge.mjs <id> --name … --triggers …` 生成骨架…
```

### 「像不像一件活」

`miss` 不设防地说话会变成噪音——「今天中午吃什么」也匹配不到专家。所以加了一道闸（`lib/gap.js` 的 `looksLikeTask`）：出现任务形态的词才开口（帮我、做个、改成、排查、怎么、能不能……）。

宁可漏报：漏报的代价是少一句提示，误报的代价是每句闲聊都被插一段废话。

实测 10 句日常说法，触发 5/10：派活的 4 句开口，闲聊 3 句静默，另外 3 句直接命中专家。

`ambiguous` 不设这道闸：分不清本身就是信号，而且此时两边都说得通，说清哪两个在抢比让模型自己蒙一个更有用。

去重与 `hint` 共用同一套账本机制。

---

## 八、技能目录收窄（`narrow`，默认关）

### 想做什么

命中某专家后，把该专家用不到的技能设成 `modelInvocable: false`：模型看不见，用户仍可 `/name` 调用。

### 怎么做

宿主没有「排除技能」的接口，只能**冒名接管**：对每个要收的技能交一份同名候选，`rank: -1` 压过原 provider。排序规则是 `rank → providerOrder → localOrder`，同名的先到先得（`dsh-skill/lib/index.js:519-521`）。

三条守住的边界：

1. **不封锁**：`provider.get()` 把本 provider 的 `list()` 临时静音、让宿主重算目录，此时原 provider 胜出，拿到正文再返回。被收起的技能照常能 `/name` 加载。
2. **逃生口**：匹配落空立刻恢复完整目录，不需要用户记命令。
3. **少动目录**：记住当前专家，同一专家不重算。目录消息是全量替换的，每变一次 prefix cache 重算一次。

### 实机结论：只对插件层的技能生效

2026-11-01 真机跑了一遍（49 个技能，命中 `frontend` 后应该只剩 5 个）：**只收起 8 个**——插件自带的 `office ×7` 与 `diagnose-windows-sandbox-acl`；用户目录下 29 个技能纹丝不动。

原因在宿主的层语义：

- `registerProvider` 把 provider 注册进**调用方所在的作用域层**（`dsh-skill/lib/index.js:147-178`）；
- 读目录时按 `[global, ...scope chain]` 合并，**靠后的层覆盖同名条目**（`:298-310`）；
- 本插件挂在 profile 上，只能写全局层，因此压不过作用域层里的同名用户技能。

`rank: -1` 只在同一层内决定同名胜负，跨层无效。这不是参数没调好，是机制的天花板。

**所以它现在默认关闭，且只该被理解为「收插件带来的噪音技能」。** 要按专家收窄用户技能，需要宿主提供作用域挂载点或目录过滤钩子。

打开它有额外代价：每个被覆盖的技能一条 `ignored because a higher-priority skill already exists` 告警（只在目录缓存失效时出现），目录全量重发一次。

---

## 九、缺口记账（`gapLog`）与汇总

每次「没人接」或「分不清」时，把原话记进 `<STATE_DIR>/gaps.jsonl`：

```json
{"at":"2026-11-01T10:01:00.000Z","kind":"miss","text":"帮我做视频监控系统","candidates":[]}
```

关键约束：**记账与「要不要开口」用同一个判据**。闲聊既不提示也不记账——否则记录里全是「今天中午吃什么」，没法用来决定造什么专家。

汇总：

```bash
npm run gaps                 # 去重后按次数排序
node tools/gaps.mjs --all    # 全量
node tools/gaps.mjs --json   # 机读
```

```text
× 2  帮我做视频监控系统
      没人接  ·  最近 2026-11-01T10:01:00.000Z
× 1  帮我写一下这个接口的文档
      分不清/backend|docs  ·  最近 2026-11-01T10:03:00.000Z
```

同一句话出现三次，就是三次都没找到人接——那是「该造专家」的信号，不是「该改匹配」的信号。坏行会被跳过，不会让整份文件读不出来。

---

## 十、造专家（`tools/forge.mjs`）

```bash
node tools/forge.mjs rtsp --name 流媒体工程师 \
  --description "摄像头接入、推流、回放与存储" \
  --triggers 摄像头,推流,RTSP,回放,目标检测 --skills pdf
```

| 参数 | 说明 |
|---|---|
| `<id>`（位置参数） | kebab-case，只允许 `a-z 0-9 -` |
| `--name` | 必填，专家名 |
| `--description` | 必填，一句话说明干什么、什么时候找它 |
| `--triggers` | 必填，逗号分隔 |
| `--synonyms` / `--skills` | 可选 |
| `--dir` | 默认 `<DSH_HOME>/capability-router/experts/<id>/` |
| `--force` | 覆盖已存在的同名专家 |
| `--dry-run` | 只打印，不落盘 |

三条硬约束：

1. **必填就必填**：缺一个直接退出（exit 2）。不猜触发词、不编描述——猜出来的措辞会被人直接接受，比生成失败更糟。
2. **写完当场校验**：用同一个 `loadExpert` 读一遍，读不出来就不落盘。
3. **不覆盖**：同名目录存在时要求 `--force`。

`role.md` 是骨架（工作方式 / 边界 / 交付），必须按领域重写。落地顺序：改 `role.md` → 人审 → 重启 DSH（专家包在挂载时扫描）。

---

## 十一、数据文件

都在 `<DSH_HOME>/capability-router/`（默认 `~/.dsh/capability-router/`）：

| 文件 | 内容 | 写入时机 | 截断 |
|---|---|---|---|
| `config.json` | 用户配置，缺省字段用内置默认值 | 手动 / `saveConfig()` | — |
| `hints.jsonl` | 每次检查点注入一行（`at` + `promptId`） | 注入时 | 超 64 KB 只留后一半 |
| `gaps.jsonl` | 每次落空一行（`at` / `kind` / `text` / `candidates`） | 落空且像派活时 | 同上 |
| `trace.jsonl` | `debug: true` 时每次 pre-step 的现场 | 每步 | 同上 |
| `experts/` | 用户自建或覆盖的专家包 | `tools/forge.mjs` | — |

JSONL 追加是同步写、失败静默——记账失败不能影响注入。

---

## 十二、与宿主的契约（实现必须知道的）

| 事实 | 出处 |
|---|---|
| `pre-step` 是瀑布，先 `await next()` 再决定追加 | `dsh-agent` 事件定义 |
| `decision.messages` 为空时退回 `payload.messages` | 实测，见 DESIGN 坑 2 |
| 追加的消息**不进会话历史** | DESIGN 坑 3 |
| `payload.messages` 可能为 0 长度（热重载后的实例） | DESIGN 坑 1（`p=0` 不等于没挂钩） |
| 技能目录消息是全量替换、按 digest 去重 | `dsh-tool-skill/lib/index.js:931` |
| provider 按调用方作用域分层，读目录时靠后的层覆盖 | `dsh-skill/lib/index.js:109-120、298-310` |

时序上的一个已知现象：收窄是在 `await next()` **之后**算的，所以目录变化要到**下一步**才反映出来；而角色与缺口是直接追加到 `decision.messages` 的，当步就可见。

---

## 十三、测试

```bash
npm test     # 八套 62 个场景，串行
npm run check # 六个源文件的语法检查
```

| 套件 | 场景 | 覆盖 |
|---|---|---|
| `test/smoke.mjs` | 12 | 注入、去重、透传、开关组合、角色、缺口、记账 |
| `test/experts.mjs` | 9 | YAML 子集、扫描、校验、内层覆盖 |
| `test/router.mjs` | 9 | 打分、三种结论、中英匹配边界 |
| `test/gap.mjs` | 8 | 任务判定、三种文案出口 |
| `test/narrow.mjs` | 8 | 收窄语义、仍可按名加载、幂等、注册失败兜底 |
| `test/route.mjs` | 5 | 集成：一句话进来后模型看到什么变了 |
| `test/forge.mjs` | 7 | 必填、id 规范、生成即可读、生成即可命中、覆盖确认 |
| `test/gaps.mjs` | 4 | 合并计数、坏行容错、机读输出 |

所有测试把 `DSH_HOME` 指到临时目录。**这个隔离必须在 `import` 插件之前设置**，否则假 promptId 会写进真实的 `hints.jsonl`。

---

## 十四、已知限制

1. **收窄跨不了层**：只能收插件层技能，用户技能压不动（第八节）。
2. **匹配是规则**：词表覆盖不到的说法会落空。落空的句子会被记账，用 `npm run gaps` 看高频缺口——那是补词表还是造专家的判断依据。
3. **不出现在会话历史**：注入只作用于当步上下文。事后回看会话，看不到检查点与角色消息，只能查 `hints.jsonl`。
4. **角色注入还没有 A/B**：检查点那版有对照数据（DESIGN 第十节），角色注入目前只有「确实注入了」的证据，没有「确实改变了行为」的证据。
