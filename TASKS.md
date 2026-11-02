# TASKS — dsh-capability-router v0.20.0

> 对应 [REQUIREMENTS.md](./REQUIREMENTS.md)。每张卡可独立接手。
> 派工原则：**同一文件只由一个人写**，接口按 REQUIREMENTS.md 末尾的契约走。

---

## 依赖图

```
T1 (state.js) ──┐
                ├─→ T4 (测试) ──→ T6 (收口)
T2 (catalog+index) ┘        ↑
T3 (三个专家包 + intake) ────┘
                            └─→ T5 (文档)
```

- **T1 / T2 / T3 可并行**（三个不相交的写范围：`lib/state.js`｜`lib/catalog.js`+`lib/index.js`｜`experts/`）
- T4 在 T1/T2/T3 之后转绿；但**测试可以先按契约写、先红着跑**
- T5 在 T1–T4 之后
- T6 最后

---

## T1 · 状态机：level 与 approved

| 项 | 内容 |
|---|---|
| **谁做** | `backend` |
| **做什么** | 改 `lib/state.js`：新增 `LEVELS` 常量；`normalizeState` 认 `level` / `approved`；新增 `setLevel` / `setApproved`；`gateNote` 加 scout 分支与「level 未判定先问一句」；`stateCardText` 加「方案」「用户水平」两段；`nextStep` 在 spec 期提 PRIOR-ART |
| **输入** | [REQUIREMENTS.md](./REQUIREMENTS.md) 接口契约 · 现有 `lib/state.js`（225 行） |
| **输出** | `lib/state.js` |
| **依赖** | 无 |
| **怎么验收** | A1–A6、A12 的单测能通过；`node --check lib/state.js` 通过；老的 state 文件（无新字段）读入不抛 |

**要点**

1. `normalizeState` 不能因为 `level` 是非法值就丢弃整个 state——回落 `undefined` 即可。
2. `approved` 只认严格的 `true`；`"true"` 字符串、`1` 都算 `false`（状态文件是外部输入）。
3. `stateCardText` 总长控制住：`approved === true` 时**不显示**「方案」段。
4. `gateNote` 里 scout 分支要排在所有 worker 分支**之前**，否则 spec 阶段会先说「先别开工」。

---

## T2 · 工具参数与落盘

| 项 | 内容 |
|---|---|
| **谁做** | `backend` |
| **做什么** | 改 `lib/catalog.js`（`expertTool` 参数加 `level` / `approved`；`catalogText` 加【调研】标签）与 `lib/index.js`（`onOpen` 落盘顺序、自动 approve、写盘条件、`HINT_TEXT` 新增一问） |
| **输入** | T1 的导出签名 · 现有 `lib/catalog.js:102`、`lib/index.js:624-671` |
| **输出** | `lib/catalog.js`、`lib/index.js` |
| **依赖** | T1（签名；可先按契约写，T1 落地后联调） |
| **怎么验收** | `expert("intake",{level:"novice"})` 后 state 文件有 `level`；`{phase:"build"}` 后 `approved:true`；`{approved:false}` 能撤销；A13 的 `/api/state` 含两字段；A14 不回归 |

**要点**

1. `onOpen` 顺序固定：`openExpert` → `setLevel` → `setApproved`（显式传值优先）→ `advancePhase` → `gateNote(推进后的状态)`。
2. 推进到 `build`/`review`/`deliver` 且 `args.approved === undefined` 时自动置真。
3. 写盘条件必须包含 `level` 与 `approved` 的变化，否则「只改了水平」不会落盘。
4. `HINT_TEXT` 只加一句，别重写成一段——检查点每轮都在，越短越有效。
5. 不改 `phase` 的 enum（仍是 `spec`/`build`/`review`）。

---

## T3 · 三个专家包 + 接单改造

| 项 | 内容 |
|---|---|
| **谁做** | `docs` |
| **做什么** | 新建 `experts/research/`、`experts/reverse/`、`experts/qa/`（各 `expert.yml` + `role.md`）；改写 `experts/intake/role.md`（第一问问水平、先调 research 出 PRIOR-ART、三句话反述确认） |
| **输入** | [REQUIREMENTS.md](./REQUIREMENTS.md) 第二、四节 · 现有 `experts/intake/role.md`（36 行）· `lib/experts.js` 的校验规则 |
| **输出** | `experts/research/{expert.yml,role.md}`、`experts/reverse/{expert.yml,role.md}`、`experts/qa/{expert.yml,role.md}`、`experts/intake/role.md` |
| **依赖** | 无 |
| **怎么验收** | `node -e` 或 `npm test` 的 experts 套能扫出 10 个专家、0 个 error；A7 手测 `expert("research"/"reverse"/"qa")` 都有 role；A8 三句探针能命中 |

**要点**

1. `expert.yml` 只用 YAML 子集（扁平 key、标量、一维列表），**不支持** `|` 块。长文写 `role.md`。
2. `research` 的 `kind: scout`，`deliverables: [PRIOR-ART.md]`，`handoff: [intake, backend, frontend]`。
3. `reverse` 的 `skills` 留空（没有对口技能包），方法论全写进 `role.md`；不要为了填表硬塞不相干的技能。
4. `qa` 的 `skills`：`test-driven-development`（host，必装）、`verification-before-completion`（host，必装）。
5. 触发词要能过 T4 的探针，但**别把通用词塞进去**——`做个`/`改一下` 这类会抢别人的活（v0.18 踩过）。
6. `intake` 的 `handoff` 首位改成 `research`。

---

## T4 · 测试与探针

| 项 | 内容 |
|---|---|
| **谁做** | `qa` |
| **做什么** | 新增 `test/state-level.mjs`（A1–A6、A12）、`test/experts-v3.mjs`（A7 包校验 + 目录标签）；在 `tools/match.mjs` 的 c 集加 A8 三句探针；把新套加进 `package.json` 的 `test` 脚本；`test/web.mjs` 或 `test/panel.mjs` 加 A13 断言 |
| **输入** | [REQUIREMENTS.md](./REQUIREMENTS.md) 验收标准 · 现有 `test/state.mjs`、`test/experts.mjs` 的写法 |
| **输出** | `test/state-level.mjs`、`test/experts-v3.mjs`、`tools/match.mjs`（只加 c 集条目）、`package.json`（只改 `test` 脚本）、`test/web.mjs` 或 `test/panel.mjs` |
| **依赖** | 契约（可先写、先红）；转绿需 T1、T2、T3 |
| **怎么验收** | `npm test` 全绿；`npm run accept` a 20/20、b ≥ 70%、c 11/11；`npm run doctor` 退出码 0 |

**要点**

1. 测试**只用临时目录**，别写 `~/.dsh/capability-router`（DESIGN 坑 4：测试污染真实状态）。
2. 新探针的期望要写「应该有谁」，不是「大概是谁」——命中不到就说明词表要改，改 `expert.yml` 归 T3。
3. 现有 `test/state.mjs` 的断言若因新增字段失败（比如整对象比对），**改测试不改实现**，并在注释里写明为什么。

---

## T5 · 文档同步

| 项 | 内容 |
|---|---|
| **谁做** | `docs` |
| **做什么** | README（能力表加两行、状态表到 v0.20.0、专家数 7→10）；`docs/FEATURES.md`（level / approved / scout 三节）；DESIGN.md 新增一节「平台差异从哪来」并补 v0.20.0 决策记录；`docs/ARCHITECTURE.md` 阶段图补 scout |
| **输入** | T1–T4 的实际产物（**照代码写，不照需求写**） |
| **输出** | `README.md`、`docs/FEATURES.md`、`DESIGN.md`、`docs/ARCHITECTURE.md` |
| **依赖** | T1–T4 |
| **怎么验收** | A15；文档里出现的命令都能照抄跑通；专家数与 `experts/` 目录一致 |

**要点**

1. 文档里写的字段名、参数名必须与代码一致，抄错比不写更糟。
2. 已知限制那节要新增一条：`level` 只影响提示文案，不改专家行为定义。

---

## T6 · 收口审查

| 项 | 内容 |
|---|---|
| **谁做** | `review` |
| **做什么** | 按 REQUIREMENTS.md 的 A1–A15 逐条核对，每条给 `通过` / `不通过` / `无法判定` + 证据 |
| **输入** | 全部产物 |
| **输出** | 审查结论（结论 / 阻塞项 / 可交付部分 / 下一个动作） |
| **依赖** | T1–T5 |
| **怎么验收** | 每条标准都有证据（命令、输出、文件行号），不接受「看起来没问题」 |

---

## 派工建议

**第一批（并行）**

```
T1 + T2  → backend   （同一人，避免接口漂移；写范围 lib/state.js, lib/catalog.js, lib/index.js）
T3       → docs      （写范围 experts/**）
T4       → qa        （写范围 test/**, package.json, tools/match.mjs；先写先红）
```

**第二批**

```
T5 → docs（等 T1–T4 落地，照代码写）
```

**第三批**

```
T6 → review（等 T5）
```

**不建议并行的组合**：任何人同时改 `lib/index.js` 与 `lib/state.js`（契约会漂）；`docs` 同时接 T3 与 T5（T5 必须等实现定稿）。

---

## 遗留项（v0.20.14 盘点：L1–L7、L9 已解决；L4、L8 是刻意留下的代价，不是待办）

| # | 事 | 为什么留着 | 下一版怎么做 |
|---|---|---|---|
| L1 | **v0.20.1 已修**：项目模式下 `miss` 不再静默。原状是 `lib/index.js:793` 的 `!projectMode && (gap / gapLog)` 把「提示」和「记账」一起关掉，`phase !== "idle"` 之后缺口提示整段跳过，`gaps.jsonl` 也一起断流（实测整场零记录）。修法：去掉那个门控，拆成两个去重集合——`gapLogged`（记账，一句一次，不管说不说）与 `gapPrompts`（注入，一句一次，被状态卡压住的那轮不标记、下一步补说）；`gapText` 的 `miss` 分支按阶段换文案，不再劝接单；记账行多一个可选 `phase`。 | 已写进 `DESIGN.md` 十六节教训段。当时不修的原因是代价要先算。 | 已完成，改动落在 `lib/gap.js` / `lib/index.js` / `lib/state.js`（`PHASE_LABEL` 统一导出）/ `tools/gaps.mjs`，新增 `test/gap-project.mjs`。 |
| L2 | **已解决**：三个新专家目录在 v0.20.1 那批里一起提交了（`git add -A`，共 34 文件）。 | 留下的教训是 `npm run doctor` **只查技能不查专家数**——漏提交不会被任何检查拦下，只能靠人看 `git status`。 | 若要让这条自动兜住：给 `doctor` 加一项「仓库里 `experts/` 的目录数 == 扫描到的专家数」，但这会让它依赖 git 状态，只在开发仓库成立。暂不做。 |
| L3 | **`level` 只影响接单专家（v0.20.13 已解决）** | 原来只在 `expert()` 的 note 里带一句「用户水平：新手/老手」，九位专家的 `role.md` 不读它 | 换个专家就忘了读者是谁 | `onOpen` 返回 `addendum`，`catalog.js` 拼在 `role` 末尾（`

---

` 分隔），静态部分不动、缓存前缀仍是同一份文本。note 那句改成指路版 |
| L4 | **`reverse` 的召回代价**：`样本`/`校验`/`函数签名` 删光后，「帮我分析一下这个样本」这类句子会落空。 | 这是**换来的**，不是漏删——留着它们会抢前端/后端/数据的活。 | 若要提召回，加长词（`这个恶意样本` 之外不强求），别把短词加回 triggers。 |
| L5 | **`gateNote` 最长 181 字**，已有 200 上限断言守着（`test/state-level.mjs` 场景九）。 | 它每轮注入一次，是全插件最长的一段文案。 | 压的时候先砍「问水平」那句（礼貌），「先别开工」「直接做也算确认」是行为约束必须留。 |
| L6 | **v0.20.3 已解决**：`lib/panel.js` 新增 `foldRuns()`，按 `promptId` 把连续同句折叠成一行（`steps` 计数、`at`/`phase`/`rout`/`expert` 取最后一步、`injected` 取并集），渲染改为**先折叠再 `slice(-25)`**，步数显示成 `×55`；`collect()` 的读取上限从 200 行提到 2000（200 行在每步一行的粒度下只够两三句）。`readRuns()` 保持按行不动——`tools/match.mjs` 的 a/b 判定按句算，两边口径混了会把「命中 20 句」变成「命中 20 步」。 | 只合并**相邻**同 id：不同会话交错写进同一文件时，跨行合并会把别人那一步算进这一句。 | 已完成，断言在 `test/panel.mjs` 场景八（含「不相邻不许合并」「缺 `promptId` 不许合并」「折叠后仍要出 25 行」）。 |
| L7 | **v0.20.14 已解决**：`deliver` 不再是终点。原来 `advancePhase()` 只许往前（阶段是闸门的主语，能随手拨回等于没有闸门），代价是「交付后想小改」只能另建项目目录——项目文件、任务卡、验收记录全断在半路。现在留了一个必须显式传的入口：`expert(id, {reopen: true})`，只在 `deliver` 有效，退回 `build` 并记 `reopenedAt`。**`advancePhase()` 一行没改**——例外长在规矩外面，规矩本身不动。不在交付状态时明说「没重开」而不是静默忽略。 | 重开是唯一一次后退，不是万能回退键：重开后再传 `phase:"spec"` 照旧被拒。 | 已完成，断言在 `test/project.mjs` 场景十（退回 / 留痕 / 文案 / 状态卡 / 非交付状态不改阶段 / 重开后仍不能跳到 spec）与 `test/state.mjs` 场景六（`reopenedAt` 只认非空字符串）。 |
| L8 | **方案 X 的代价：`approved` 会漏记**。用户点头了、模型没调 `{approved:true}`，状态卡就一直显示「方案：待确认」。 | 这是刻意换的——看得见的噪音比看不见的谎话便宜。兜底靠两道：推进阶段那一刻的提醒 + 审查专家的阻塞项核对。 | 若漏记率高到噪音不可忍，再考虑方案 Y（记 `approvedBy: "user" \| "phase"` 区分来源），而不是退回自动置真。 |
| L9 | **`/api/state` 的 `runs` 每步一行（v0.20.11 已解决）** | 面板 HTML 走 `foldRuns().slice(-25)`，JSON 快照原来把 `collect()` 的原始行整包吐出（2000 行约 550 KB） | 两处口径不一致，client 半边吃它就得自己再折一遍 | 已在 `lib/web.js` 的 `snapshot()` 出口折叠：`foldRuns(data.runs).slice(-200)`，实测 86 KB → 24.6 KB。`readRuns()` 仍按步（`match.mjs` 口径不动），面板渲染仍自己折最近 25 句 |
