# dsh-capability-router

> 本机自研的 DSH 插件 · v0.6.0 · 零依赖
> 告诉模型「这是个什么问题」再让它动手。

一句话：**在用户那句话后面加一条很短的提示，把「先归类、再动手」变成当轮动作**；顺带按领域把专家身份、技能目录和缺口记录管起来。

---

## 解决什么

两个具体问题，都是实测出来的：

1. **agent 拿到一句含糊的需求就直接开干**。用户说「这个功能为什么不生效」，它先跑十条命令再回答——因为它读不出这句话是「提问」还是「命令」。
2. **技能装多了挑不准**。49 个技能的目录塞在上下文里，每次都得自己判断该用哪个。

做法不是加更多规则到系统提示里（那离用户那句话太远，中间隔着几十 KB 项目规则），而是**贴着用户消息注入**。

---

## 现在能做什么

| 能力 | 开关 | 默认 | 说明 |
|---|---|---|---|
| 当轮检查点 | `hint` | 开 | 每条用户消息后注入一小段：提问直接答 / 命令有黑洞先问 / 报告接着做 |
| 专家目录 + `expert()` 工具 | `catalog` `expertTool` | 开 | 目录进系统提示（稳定前缀），`role.md` 按需取 |
| 专家路由 + 角色注入 | `experts` `role` | 开 | 一句话判给七个专家之一，命中就注入它的 `role.md`（`catalog` 开着时不做，选人交给模型） |
| 缺口提示 | `gap` | 开 | 分不清说「哪两个在抢」，跨领域说「这是三个领域」，没人接说「没有干这个的人」；闲聊不打扰 |
| 缺口记账 | `gapLog` | 开 | 落空的原话记进 `gaps.jsonl`，用来决定下一个专家造什么 |
| 长期原则段 | `intake` | 开 | 系统提示里的常驻背景，供长对话回看 |
| 技能供给体检 | `npm run doctor` | — | 专家声明的技能装没装；`host` 源不查，缺必装退出码 1 |
| 面板 | `web` | 开 | 宿主路由 `/capability-router/panel`；插件详情页与会话页「编排」tab 都嵌它 |
| 项目模式 | `project` | 开 | 有会话状态时：状态卡取代检查点，缺口闭嘴 |
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
npm test                  # 十三套 91 个场景
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

---

## 仓库结构

```text
lib/index.js      插件本体：挂载、pre-step 路由、两处注入、自检技能
lib/experts.js    专家包发现与校验（内层覆盖外层）
lib/catalog.js    专家目录（系统提示段）+ expert(name) 工具定义
lib/state.js      会话状态、阶段闸门、状态卡
lib/panel.js      只读面板的数据层与渲染（HTML）
lib/skills.js     技能目录扫描（doctor 与 panel 共用）
lib/web.js        面板的宿主路由（/panel 与 /api/state）
lib/router.js     规则匹配器：一句话判给哪个专家
lib/gap.js        缺口判定与文案
lib/doctor.js     技能供给检查（纯计算，不碰文件系统）
lib/yaml.js       YAML 子集解析器（为了零依赖手写的）
experts/<id>/     专家包：expert.yml + role.md，首批 7 个（含接单 intake、审查 review）
client/index.js   浏览器半边：插件详情页与会话页各挂一个 iframe，无构建步骤
test/             十三套 91 个场景
tools/            match（验收）· doctor（体检）· panel（只读面板）· forge（造专家）· gaps（汇总）· dump-session（会话日志）
docs/             功能说明 · 安装与排障
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
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | **下一版架构**：项目级专家编排、阶段闸门、GUI 落点、迁移路径（第 1 步已执行） |
| [docs/FEATURES.md](./docs/FEATURES.md) | 每个能力的行为、判据、消息形状、数据文件、测试矩阵、限制 |
| [docs/INSTALL.md](./docs/INSTALL.md) | 安装、挂载链路、验证、诊断、卸载、热重载的坑 |
| [DESIGN.md](./DESIGN.md) | 为什么这么设计、宿主 API 实测记录、v0.2.0 的 A/B 对照 |

---

## 状态

v0.15.0。按里程碑看：

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

下一步是真实项目跑一遍验收场景（视频监控：用户说两句 → 接单进 spec → 分派 → 审查收口），把「能跑到哪一步」摸清楚。

已知限制见 [docs/FEATURES.md](./docs/FEATURES.md) 最后一节。
