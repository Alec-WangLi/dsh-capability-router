# REQUIREMENTS — dsh-capability-router v0.20.0

> 接单专家产出 · 2026-11-02
> 基线：v0.19.0（`npm test` 全绿，`npm run accept` a 20/20、b 20/20）

---

## 一、目标

**让 agent 在动手之前先摸清「用户到底要什么、市面有没有现成的、用户能听懂多深」，再按任务卡分派给领域专家，收口时按同一份验收标准逐条核对。**

一句话定位（来自本轮讨论）：Agent 之间的差距不在模型和工具，而在**对自然语言的理解精度**与**对工具的编排强度**。这两样都在提示层，所以插件只做协议：阶段、闸门、验收、证据。

---

## 二、范围

### 做什么

| # | 能力 | 说明 |
|---|---|---|
| 1 | **调研专家 `research`** | 新增专家包，`kind: scout`。产出 `PRIOR-ART.md`，三段结论：谁能直接用 / 谁能改着用 / 都不行为什么。接单流程强制先调它。 |
| 2 | **逆向与安全专家 `reverse`** | 新增专家包，`kind: worker`。脱壳、破解校验、协议还原、样本分析、hook。 |
| 3 | **测试专家 `qa`** | 新增专家包，`kind: worker`。用例、回归、覆盖率、冒烟、E2E。补齐「完成度」的最后一环。 |
| 4 | **用户水平 `level`** | 项目状态新增字段 `level: "novice" \| "pro" \| undefined`。接单第一问就问，用 `expert(id, {level})` 落盘；状态卡显示「用户水平：新手/老手/未判定」。 |
| 5 | **方案确认 `approved`** | 项目状态新增 `approved: boolean`，默认 `false`。spec 阶段状态卡显示「方案：待确认」，并提示「用户说『直接做』才算确认」；~~推进到 build 自动置 `true`~~；`expert(id,{approved:false})` 可撤销。**软提示，不拦截。**（v0.20.2 收敛：**只有显式 `{approved:true}` 才置真**，推进阶段不改它，只在不确认时补一句提醒） |
| 6 | **接单流程改造** | `experts/intake/role.md` 增加三段：第一问问水平、先出 `PRIOR-ART.md` 再写需求、把需求反述成三句话让用户点头。 |
| 7 | **检查点同步** | 「命令·新活」出口补一句：接单第一问是问用户想听多细，并用 `expert("intake",{level:...})` 记下。 |
| 8 | **面板暴露** | `/api/state` 的 JSON 含 `level` 与 `approved`；项目卡/会话卡能看出「方案待确认」。 |

### 明确不做

- **不做硬闸门**。未确认方案时只提示，不拒绝推进——用户说「直接做」是最常见的确认方式，硬拦会打断他。
- **不动匹配器算法**。新增三位专家只加词表，不改权重、不改 `multi`/`ambiguous` 判据。
- **不做「按 level 自动改写 role.md」**。角色提示词是静态的；水平只影响状态卡与闸门文案，不改专家的行为定义。
- **不引入新依赖**。仍然零运行时依赖。
- **不改 `expert()` 的既有参数语义**（`project` / `phase` 行为不变）。
- **不做需求评审之外的「方案好不好」评判**。`review` 只核「实现是否满足已确认需求」。

---

## 三、验收标准

每条都必须可测，且给出验证方式。

| # | 标准 | 怎么验 |
|---|---|---|
| **A1** | 新项目 `expert("intake")` 之后，`.capability-router/state.json` 含 `"approved": false` 且无 `level`；状态卡文本含「方案：待确认」「用户水平：未判定」 | 单测：构造 state 调 `stateCardText` |
| **A2** | `expert("intake",{level:"novice"})` 后 state 的 `level === "novice"`，状态卡含「用户水平：新手」；`{level:"pro"}` 显示「老手」 | 单测 + `onOpen` 钩子测 |
| **A3** | `expert("intake",{phase:"build"})` 后 `approved` **仍为 `false`**（推进阶段不等于用户拍板），且返回的 note 含「还没记为确认」；同一阶段重复交卷、或不传 `phase` 只开专家，note **不含**这句话 | 单测 `test/project.mjs` |
| **A3b** | `expert("review")` 在 build 上由 `openExpert` 隐式把阶段推到 review，这条路径同样出「还没记为确认」——最常走的一步不能静默 | 单测 `test/project.mjs` |
| **A4** | `expert("intake",{approved:false})` 后 `approved === false`，状态卡重新出现「待确认」 | 单测 |
| **A5** | spec 阶段打开 `backend`，返回 note 含「先别开工」；若 `level` 未判定，同一 note 还含「先问一句用户想听多细」 | 单测 `gateNote` |
| **A6** | spec 阶段打开 `research`，note 含 `PRIOR-ART.md` 且**不含**「先别开工」 | 单测 `gateNote` |
| **A7** | `expert("research")` / `expert("reverse")` / `expert("qa")` 均 `found: true`，`kind` 分别为 `scout` / `worker` / `worker`，`role` 非空 | 单测 + 手测 |
| **A8** | 三句新探针均命中正确专家：「这 exe 怎么校验激活码」→ `reverse`；「写一套回归用例盖住登录流程」→ `qa`；「先查市面上有没有现成的记账软件」→ `research` | 加进 `tools/match.mjs` 的 c 集 |
| **A9** | 既有 a 集 20/20 不回归，b 集 ≥ 70%（当前 20/20） | `npm run accept` |
| **A10** | `npm test` 全绿，且新增测试套覆盖 A1–A8；新套已加入 `package.json` 的 `test` 脚本 | `npm test` |
| **A11** | `npm run doctor` 退出码 0（三位新专家的必装技能都在） | `npm run doctor` |
| **A12** | 旧 `state.json`（无 `level`/`approved`）读入不报错，视为未判定 / `false` | 单测：喂一个 v0.19 形状的 state |
| **A13** | `/api/state` 返回的 JSON 每一项含 `level` 与 `approved` | `test/web.mjs` 或 `test/panel.mjs` 加断言 |
| **A14** | `enabled: false` 时不注入、不扫描、不挂钩，行为与未安装一致 | 现有 `test/smoke.mjs` 场景保持通过 |
| **A15** | README 状态表到 v0.20.0；能力表新增「用户水平」「方案确认」两行；FEATURES.md 有对应小节；DESIGN.md 加一节「平台差异从哪来」 | 人工核对 + review |
| **A16** | `expert()` 的 `phase.enum` 含 `deliver`。模型只读 `tool.parameters`，读不到 `PHASES`——schema 里没有这一步，模型根本走不进去 | 单测 `test/project.mjs` A7 断言 `phaseEnum.includes("deliver")` |

---

## 四、假设（我替你定的，可反驳）

1. **`level` 只有一个值，不记翻转历史**。用户先要细节后要结论时，直接覆盖即可；记历史的价值低于实现成本。
2. ~~**`approved` 一旦推进到 build 就为真**。宣布「需求确认完了、开工」本身即视为用户拍板——否则每个项目都要多一轮显式确认，用户会烦。~~
   **v0.20.2 推翻**：这条把「模型挪阶段」记成了「用户点头」，而前者零成本、后者要花一次对话。改成只认显式 `{approved:true}`（决策记录见 `DESIGN.md` 第十六节第 1 条修正）。
3. **`PRIOR-ART.md` 放项目根**，与 `REQUIREMENTS.md` 同级。理由：它是接单的输入物，不是实现产物，不该塞进 `docs/`。
4. **`kind: scout` 是新取值**，只用于 research。目录里给「【调研】」标签，不进【入口】/【收口】。
5. **接单强制先调 research 靠 role.md 约束**，插件不做流程强拦截——与现有「闸门是提示级」保持一致。
6. **状态卡加两个字段后仍是一行**。控制在 120 字内，超出就砍「在场专家」的显示。

---

## 五、依赖

| 依赖 | 谁提供 | 状态 |
|---|---|---|
| v0.19.0 基线全绿 | 本仓库 | 已有（2026-11-02 实测） |
| 宿主 `ctx.tools.register` 的 JSON Schema 参数 | DSH Desktop 0.2.1 | 已有（`lib/catalog.js:102`） |
| 项目级状态文件 `.capability-router/state.json` | `lib/state.js:60` | 已有 |
| `research` 技能（本地） | 技能目录 | 已有 |
| `test-driven-development` / `verification-before-completion`（宿主） | 技能目录 | 已有 |

---

## 六、未决

| 未决 | 阻塞哪张卡 | 默认处理 |
|---|---|---|
| 「用户水平」是否也要注入到 role 消息里（不只状态卡） | T2 | 先只进状态卡；role 注入留到下一版，避免破缓存 |
| 面板是否要可视化（不只 JSON） | T5 | 最小实现：JSON 有字段即可；可视化留给下一版 |
| reverse 专家是否需要自带技能包 | T3 | 暂不造技能，`role.md` 承载方法论（零依赖原则） |
| `PRIOR-ART.md` 要不要进 review 的验收清单 | T3 / T6 | 进——「有没有查过现成的」是需求质量的一部分 |

---

## 附：接口契约（实现者按此并行，别打架）

**`lib/state.js`**

```js
export const LEVELS = ["novice", "pro"];

// normalizeState 返回对象新增两个字段（缺省不抛）：
//   approved: boolean            // 恒在，缺省 false，只认严格 true
//   level?: "novice" | "pro"     // 未判定时**不带这个键**（不是 level: undefined）
//   ↑ 2026-11-02 实现收敛后的措辞：带 undefined 键会被 JSON.stringify 丢掉，
//     外部消费方（面板）反而要写两套判断。省略键 + 消费方补 null 更干净，
//     lib/panel.js:59-67 就是这么做的。验收按这条读，不按「两个键恒在」读。

export function setLevel(state, level)        // → { state, error? }  非法 level 不改 state、给 error
export function setApproved(state, approved)  // → { state, changed }
```

- `stateCardText` 形状：`【能力路由 · 项目模式】阶段：<中文>（<英文>）｜方案：<待确认|已确认>｜用户水平：<新手|老手|未判定>｜在场专家：<…>｜下一步：<…>`
  - `approved === true` 时不显示「方案」段（已确认是常态，不值得占字）。
- `gateNote` 新增分支：`kind === "scout"` 时分阶段——`idle`/`spec` 给「先出 PRIOR-ART.md（谁能直接用 / 谁能改着用 / 都不行为什么）」，`build`/`review`/`deliver` 给「调研在需求阶段已经做完，现在是 X，别再回到选型上」；spec 阶段 `kind === "worker"` 且 `level === undefined` 时追加「先问一句用户想听多细」；`approved !== true` 时追加「用户说『直接做』也算确认」。
  - ↑ 2026-11-02 审查后收敛：原契约写「不论阶段」，实测 deliver 阶段说「再决定需求怎么写」自相矛盾（需求早写完了），故按阶段分岔。验收读这一条。

**`lib/catalog.js`**

- `expertTool` 的 `parameters.properties` 增加：
  - `level: { type: "string", enum: ["novice","pro"] }`
  - `approved: { type: "boolean" }`
- `onOpen(expert, exec, args)` 的 `args` 已含这两个字段，签名不变。
- `catalogText` 的标签：`intake → 【入口】`、`reviewer → 【收口】`、`scout → 【调研】`。

**`lib/index.js`**

- `onOpen` 顺序：先 `openExpert` → 再 `setLevel`/`setApproved`（显式参数优先）→ 再 `advancePhase` → 再按**推进后**状态算 `gateNote`。
- 推进阶段**不**自动置 `approved`。只有阶段真的变了（含 `openExpert` 的隐式推进）且推进到 `build`/`review`/`deliver` 而 `approved` 不是 `true` 时，note 追加一条补记提醒；提醒与 `gateNote` 同时成立时**拼接**，不互相覆盖。
- 写盘判定条件从「phase 或 experts 变化」扩成「phase / experts / level / approved 任一变化」。
- `HINT_TEXT` 的「命令 · 新活」出口追加：`接单第一问：用户想听细节还是直接上？问完用 expert("intake",{level:"novice"|"pro"}) 记下。`
