# 对照实验：同一句话，修复前后

> 2026-11-02。目的是回答一个问题：**v0.18.0 的修复，能不能让插件在一件真实的活里被用起来？**
> 结论：能开门、能分派、能收口——但这三件事只发生了一次，因为插件在长任务里只工作第一步。
> 那个根因已修，等重启后跑第二遍验证。

## 怎么做的

- 给子代理的 prompt 就是用户的原话，一个字没加：`我想做一款Windows记账软件，整体看起来简约大方。`
- 独立目录 `_exp-2026-11-02-ledger`，全新会话（子代理 `a80192c6`），全程只有 1 个真人轮次。
- 对照组是用例复盘里的旧运行（`session-b19fbe89`，同一句话，修复前）。

## 结果

| | 修复前（`b19fbe89`） | 修复后（`a80192c6`） |
|---|---|---|
| 首句路由 | `miss`（0 分，静默） | `hit intake`（`做一款` + `想做` = 3.5） |
| `expert()` 调用 | **0 次** | **4 次** |
| 调用链 | — | `intake → backend → frontend(build) → review(review)` |
| 需求产物 | 无 | `REQUIREMENTS.md` 72 行、`TASKS.md` 9 张卡（谁做/输入/输出/依赖/验收） |
| 收口 | 无 | `docs/REVIEW.md`（11 条逐条取证、阻塞项 0）、`docs/VERIFICATION.md` |
| 最终 phase | `idle` | `review` |
| 源码 | 3062 行 | 2394 行 TS/TSX + `dist/` 425 MB（nsis + portable） |
| 墙钟 | 61.8 min | ~50 min |

首条运行记录已经把差别说清了：

```json
{"session":"a80192c6","rout":"hit","expert":"intake","task":true,
 "cands":["intake"],"injected":["capability-router-intake","capability-router-hint"]}
```

修复前这里是 `rout:"miss"`、`cands:[]`、`injected:["capability-router-hint"]`。

## 但这不算成功案例

`runs.jsonl` 整场只写了 **1 行**，`capability-router-state` **一次都没注入**。注入总量：`capability-router-intake`×1、`capability-router-hint`×1，全在头两分钟。

原因：这个任务从头到尾只有一条 user 消息，模型自己连跑 139 步。后续步的 `messages` 里不再带 `source.kind === "user"` 的消息（该会话 `user/message` 的 kind 分布：`tool-jobs` 10、`time-context` 3、`runtime-context`、`skill-catalog`……，真正 `kind=user` 只有 1 条），`lastUserPrompt()` 返回 `undefined`，插件在这里直接返回：

```js
if (prompt === undefined) return decision;
```

**第 2 步起，插件就下班了。**

这也解释了旧用例里的现象：ON 那场 61 分钟只有 7 条 `runs`（= 7 个真人轮次），模型引用检查点恰好是第 1、2 轮。不是"说一次就够"，是**只被给了这一次机会**。

### 归因要说准

`review` 是模型自己决定的。检查点第一条写了「收口 → 先 `expert("review")`」，它在第一步读到，50 分钟后自己想起来执行。

所以这次是**文案**起了作用，不是机制。文案强到能让模型记住 50 分钟，但"能记住"不等于"会被提醒"。旧版同样的模型只被说了一次却没走到 review——差别在文案内容，不在有没有第二次提醒。

## 已修（v0.19.0）

1. **`lastPromptByAgent`**：按 `agentId` 缓存最后一次人话，后续步找不到就复用。仍是那一轮的 `promptId`，去重不受影响。
2. **`shouldInjectState()`**：状态卡从「一条消息只注入一次」改成「阶段一变立刻说，否则每 `STATE_EVERY = 10` 步补一次」，配套 `stepCounts` / `stateMarks` / `MEMO_LIMIT`。

同一轮还顺手修了两处实验暴露的小问题：

- 子代理的任务书（父代理写的，上千字）被判成 `hit docs（副：review）`——加 `MAX_ROUTE_CHARS = 400`，超长消息只注入检查点、不点名。
- `miss` 时把 0 分候选也记进 `cands`，读起来像「差一点命中」——改成只带 `score > 0`。

`test/project.mjs` 加两个场景锁住这些：场景八（第二次 pre-step 的 messages 里没有 `kind === "user"` 时，`runs.jsonl` 仍要记到第二行）、场景九（12 步里状态卡至少补一次）。

## 第二遍要看的三个数字（未跑）

| 指标 | 修复前实测 | 期望 |
|---|---|---|
| `runs.jsonl` 行数 | 1 | 十几行（每 10 步 + 阶段变化） |
| `capability-router-state` 注入次数 | 0 | 多次 |
| `review` 的触发位置 | 第 ~120 步，模型自己想起来的 | 交付那一刻被闸门叫住 |

第三个是判据：只有它从"自觉"变成"被叫住"，这次修复才算真把审查接上了。

## 复现

```bash
python tools/exp-stat.py "<session>.v4.jsonl.zstd"   # 工具分布 / expert 序列 / 注入统计
python tools/kinds.py    "<session>.v4.jsonl.zstd"   # user/message 的 source.kind 分布
```

实验产物：`../_exp-2026-11-02-ledger`（源码、`dist/`、四张截图、两份验收报告）。
