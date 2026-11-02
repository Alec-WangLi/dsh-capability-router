# dsh-capability-router

> 本机自研的 DSH 插件 · v0.20.4 · 零依赖
> 让 agent 先确认「这是个什么问题、手上能力够不够」，再动手。

一句话：**检查点贴在用户消息后面，专家目录常驻系统提示、`expert(name)` 按需取详情，项目阶段记在项目里而不是会话里。**

---

## 解决什么

两个具体问题，都是实测出来的：

1. **agent 拿到一句含糊的需求就直接开干**。用户说「这个功能为什么不生效」，它先跑十条命令再回答——因为它读不出这句话是「提问」还是「命令」。
2. **技能装多了挑不准**。49 个技能的目录塞在上下文里，每次都得自己判断该用哪个。
3. **多专家协作没有交接协议**。用户说「做个视频监控系统」，它要么自己硬扛，要么分不清该找谁、做到哪一步算完——没有需求文档、没有任务卡、没有阶段。

做法不是加更多规则到系统提示里（那离用户那句话太远，中间隔着几十 KB 项目规则），而是**贴着用户消息注入**。

---

## 现在能做什么

| 能力 | 开关 | 默认 | 说明 |
|---|---|---|---|
| 当轮检查点 | `hint` | 开 | 每条用户消息后注入一小段：提问直接答 / 新活先接单 / 修先定位 / 报告接着做 / **收口先审查** / 拿不准问一句 |
| 专家目录 + `expert()` 工具 | `catalog` `expertTool` | 开 | 目录进系统提示（稳定前缀，入口 / 收口 / 调研标成【入口】/【收口】/【调研】），`role.md` 按需取 |
| 专家路由 + 角色注入 | `experts` `role` | 开 | 一句话判给十个专家之一，命中就注入它的 `role.md`（`catalog` 开着时不做，选人交给模型） |
| 缺口提示 | `gap` | 开 | 分不清说「哪两个在抢」，跨领域说「这是三个领域」，主次说「副的那半也有人管」，没人接**先说先接单**；闲聊不打扰 |
| 缺口记账 | `gapLog` | 开 | 落空的原话记进 `gaps.jsonl`，用来决定下一个专家造什么 |
| 长期原则段 | `intake` | 开 | 系统提示里的常驻背景，供长对话回看 |
| 技能供给体检 | `npm run doctor` | — | 专家声明的技能装没装；`host` 源不查，缺必装退出码 1 |
| 面板 | `web` | 开 | 宿主路由 `/capability-router/panel`；插件详情页与会话页「编排」tab 都嵌它 |
| 项目模式 | `project` | 开 | 阶段记在项目里（`<项目>/.capability-router/state.json`），状态卡取代检查点；缺口提示让位一步（状态卡那轮不说，下一轮补），缺口记账照常 |
| 阶段推进 | `expert(id, {phase})` | — | 交卷时显式推进（`spec → build → review → deliver`）；只能往前走，允许跨格（多会话接手） |
| 用户水平 | `expert(id, {level})` | — | 记下用户想听多细（`novice` 讲细节与理由 / `pro` 直接给结论）；只改状态卡与闸门文案，不改专家 `role.md` |
| 方案确认 | `expert(id, {approved})` | — | 方案是否已被用户点头；**推进阶段不会自动置真**，只认显式 `true`（用户说「直接做」也算），传 `false` 可撤销。**软提示，不拦截** |
| 运行记录 | `runs` | 开 | 每次 pre-step 一行写进 `runs.jsonl`（阶段、命中、注入了什么） |

细节、判据、代价都在 **[docs/FEATURES.md](./docs/FEATURES.md)**。

---

## 快速开始

**装**（GUI 是唯一受支持的方式）：

```text
DSH → 插件 → 添加插件 → 输入源码目录的绝对路径 → 重启
```

包内已有 `cordis.patch.yml`，装完自动加载。手动兜底、卸载、排障见 **[docs/INSTALL.md](./docs/INSTALL.md)**。

**验**：发一句领域话（比如「登录页的样式在窄屏下全乱了」），下一轮回答里应能看到该专家的角色设定；再问「这个功能为什么不生效？」，它应该先判断这句话要什么、再动手。

---

## 一屏用法

```bash
npm test                  # 十八套 141 个场景
npm run check             # 语法检查
npm run accept            # 匹配器验收集（a 回归 + b 口语）
node tools/match.mjs --set c   # 泛化探针

npm run doctor            # 专家的技能依赖装齐了没
npm run panel             # 只读面板：会话阶段 / 最近 25 步 / 缺口队列 / 技能供给
npm run gaps              # 哪个领域反复没人接
node tools/gaps.mjs --json

node tools/forge.mjs rtsp --name 流媒体工程师 \
  --description "摄像头接入、推流、回放与存储" \
  --triggers 摄像头,推流,RTSP,回放,目标检测
```

`forge` 写完当场校验（读不出来就不落盘），然后手改 `role.md` → 人审 → 重启。

---

## 配置

`~/.dsh/capability-router/config.json`，缺的字段用内置默认值：

```json
{
  "enabled": true,
  "intake": true,
  "hint": true,
  "experts": true,
  "catalog": true,
  "expertTool": true,
  "project": true,
  "runs": true,
  "role": true,
  "gap": true,
  "gapLog": true,
  "order": 5000,
  "debug": false
}
```

`enabled: false` 时行为与未安装完全一致。改完要**重启**（配置不热生效）。

---

## 已知限制

1. **体检只查存在性**：`npm run doctor` 数得出技能在不在，查不了版本，也判断不了质量。`host` 源的依赖一律放行。
2. **匹配是规则**：词表覆盖不到的说法会落空。落空会记账，攒够了再决定是补词表还是造专家。
3. **注入不进会话历史**：只作用于当步上下文；事后回看会话看不到，只能查 `hints.jsonl`。
4. **角色注入还没有 A/B**：检查点有对照数据（[DESIGN.md](./DESIGN.md) 第十节），角色注入目前只验证了「确实注入了」。
5. **阶段要靠模型显式推进**：`spec → build` 没有可观察的事实（插件拿不到会话工作目录），模型不调 `expert(id, {phase})` 就会一直停在原阶段。
6. **`level` 只改提示文案**：它进状态卡与闸门文案，**不改专家的 `role.md`**——角色提示词是静态文件，同一个专家对新手和老手说的是同一段话。
7. **方案确认是软闸门**：模型一次都不调 `expert()` 时，`level` 和 `approved` 这两条链完全不生效。插件没有拦截工具调用的钩子。

---

## 仓库结构

```text
lib/index.js      插件本体：挂载、pre-step 路由、两处注入、自检技能
lib/experts.js    专家包发现与校验（内层覆盖外层）
lib/catalog.js    专家目录（系统提示段）+ expert(name) 工具定义
lib/state.js      项目级阶段、闸门、状态卡（会话文件只留指针）
lib/panel.js      只读面板的数据层与渲染（HTML）
lib/skills.js     技能目录扫描（doctor 与 panel 共用）
lib/web.js        面板的宿主路由（/panel 与 /api/state）
lib/router.js     规则匹配器：一句话判给哪个专家
lib/gap.js        缺口判定与文案
lib/doctor.js     技能供给检查（纯计算，不碰文件系统）
lib/yaml.js       YAML 子集解析器（为了零依赖手写的）
experts/<id>/     专家包：expert.yml + role.md，10 个（含接单 intake【入口】、审查 review【收口】、调研 research【调研】）
client/index.js   浏览器半边：插件详情页与会话页各挂一个 iframe，无构建步骤
test/             十八套 141 个场景
tools/            match（验收）· doctor（体检）· panel（只读面板）· forge（造专家）· gaps（汇总）· dump-session（会话日志）
docs/             功能说明 · 架构 · 验收实录 · 安装与排障
DESIGN.md         设计取舍、宿主 API 实测、踩过的坑
```

`tools/dump-session.mjs` 解决一个很具体的问题：DSH 的会话日志是多帧 zstd 串联，`zlib.zstdDecompressSync` 只解第一帧。这个工具按帧头切片逐帧解压再拼接：

```bash
node tools/dump-session.mjs ~/.dsh/sessions/<slug>/session-<id> --stats
```

---

## 文档

| 文件 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | v2 架构：项目级专家编排、阶段闸门、GUI 落点；八步迁移路径（已全部落地） |
| [docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md) | **验收实录**：让插件自己跑一个视频监控项目，六轮流水、暴露的 5 个协议问题与修法、没验到的东西 |
| [docs/FEATURES.md](./docs/FEATURES.md) | 每个能力的行为、判据、消息形状、数据文件、测试矩阵、限制 |
| [docs/INSTALL.md](./docs/INSTALL.md) | 安装、挂载链路、验证、诊断、卸载、热重载的坑 |
| [DESIGN.md](./DESIGN.md) | 为什么这么设计、宿主 API 实测记录、v0.2.0 的 A/B 对照 |

---

## 状态

v0.20.2。按里程碑看：

| 版本 | 内容 |
|---|---|
| v0.6.0 | 检查点（有 A/B 对照）、专家路由、角色注入、缺口提示与记账、造专家 |
| v0.7.0 | 收窄（`narrow`）退役——它服务错了对象，且撞上宿主的作用域分层天花板 |
| v0.8.0 | 专家包 v2（`kind` / `handoff` / `deliverables` + 技能依赖声明）+ `npm run doctor` 供给体检 |
| v0.9.0 | 专家目录进系统提示 + `expert(name)` 工具：判断权从插件交回模型 |
| v0.10.0 | 项目模式：会话阶段、提示级闸门、`runs.jsonl`；目录在场时旧的角色注入退场 |
| v0.11.0 | 入口与收口两个专家：接单（`REQUIREMENTS.md` + `TASKS.md`）与审查（按同一份标准核对） |
| v0.12.0 | `npm run panel` 只读面板：会话阶段 / 最近 25 步 / 缺口队列 / 技能供给 |
| v0.13.0 | 匹配器 `multi`：跨领域不再硬选一个；匹配器彻底降级为提示 |
| v0.14.0 | 面板挂上宿主路由，加 client 半边：插件详情页与会话页「编排」tab |
| v0.15.0 | 阶段有了显式出口（`expert(id, {phase})`，只能往前走一格）；面板会话卡显示中文阶段名 |
| v0.16.0 | 面板分范围：详情页看全部会话，会话页「编排」只看当前会话（`?session=`） |
| v0.16.1–2 | 闸门提示按推进后的状态判；阶段允许跨格前进（新会话接手既有项目），拒绝时明确报错 |
| v0.17.0 | 阶段改为**项目级**：`expert(id, {project})` 指定项目根，多个会话共用一个阶段 |
| v0.17.1–2 | 项目状态文件标注清楚；同阶段推进改为幂等（重复交卷不再报错） |
| v0.18.0 | 按 [真实用例复盘](./docs/REAL-TEST-2026-11-02.md) 修：检查点六出口（含接单/收口）、入口专家让位、主次提示、落空先接单、`deliver` 阶段、目录五条规矩、`runs.jsonl` 加 `task`/`cands`/`secondary` |
| v0.19.0 | 按 [对照实验](./docs/EXPERIMENT-2026-11-02.md) 修长任务：找不到人话时复用上一次的（原来第 2 步起整场静默）、状态卡按步数补（原来只说一次）、超 400 字的消息不点名、落空候选不再带 0 分项 |
| v0.20.0 | 三位新专家（调研 `research`、逆向与安全 `reverse`、测试 `qa`，合计 10 位）；`expert()` 加 `level` 与 `approved` 两个参数并落进 `state.json`；新增 `kind: scout`（目录【调研】标签、spec 阶段不被「先别开工」拦）；状态卡多出「方案 / 用户水平 / 空闲」三态；`/api/state` 与 `readSessions()` 补齐 `approved`（布尔）与 `level`（`null` / `novice` / `pro` 三态）；接单流程改成「先问水平 → 先出 `PRIOR-ART.md` → 三句话反述确认」 |
| v0.20.1 | 修「项目模式下缺口提示静默」（L1）：缺口块不再被 `!projectMode` 整段关掉，拆成**记账**与**注入**两个去重集合——记账一句一次（`gaps.jsonl` 每行可带 `phase`），注入一句一次且被状态卡压住时**顺延到下一步**；`miss` 在项目模式下换成带阶段名的文案，不再劝接单；`PHASE_LABEL` 统一从 `lib/state.js` 导出，删掉 `lib/index.js` 与 `lib/panel.js` 的两份副本；`tools/gaps.mjs` 汇总每条带「阶段 a/b」；新增 `test/gap-project.mjs`（十八套 141 个场景） |

| v0.20.2 | 修两个协议层漏洞：**`deliver` 从死阶段里放出来**（`expert()` 的 `phase` enum 缺它，模型只能看见 schema 看不见 `PHASES`，于是文案、面板配色、自动确认分支全在等一个进不去的状态）；**`approved` 不再被推进阶段顶替**——原来「推进到 build 即视为用户拍板」把模型的挪阶段记成了用户的点头，状态卡上「方案：待确认」在那一瞬间自动消失，而 `approved` 在十份 `role.md` 里零引用、审查从没核过。现在只认显式 `{approved:true}`，推进时补一句提醒，审查角色加核对项 |
| v0.20.3 | 修两处「数据有了但看不见」：**运行表按句折叠**——`runs.jsonl` 是每步一行，实测单句 55 步，原来 `slice(-25)` 直接截行，表里只剩一句话的一小段；现在先折叠再截断，25 行是 25 句，步数挂在路由列 `×55`，读取上限同步从 200 行提到 2000。**用户水平传给干活专家**——以前只有 `experts/intake/role.md` 读 `level`，其余九位拿到的是静态提示词；现在每次打开专家都在 note 末尾带一句「新手先解释术语 / 老手直接给命令」，不改 `role.md` 是为了不破前缀缓存 |
| v0.20.4 | 补一个同族空洞：**交付之后叫审查专家，以前一句话都不说**。`deliver` 是终点（进得去、出不来），交付后想复核是正当需求，但「交付后又改过」（改动没有验收记录）和「原样复核」是两件不同的事，静默等于让模型替用户决定。现在闸门要求先说清核的是哪一版 |

**已经真跑过一轮验收**：让插件自己接了「家庭四路视频监控」项目，从一句话走到接单专家出 `REQUIREMENTS.md`+`TASKS.md`、实现专家交 T1、审查专家按 A1–A12 收口（判「修完再交」，抓出 2 个 P0），修复后复核通过。全过程、暴露的 5 个协议问题与修法记在 **[docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md)**。

没验的是真实硬件条件下的动态条目（真实摄像头拉流、断电重启、7 天淘汰、手机首帧延迟…）——那要真机部署。

已知限制见 [docs/FEATURES.md](./docs/FEATURES.md) 最后一节。
