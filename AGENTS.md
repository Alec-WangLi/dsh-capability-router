# AGENTS.md — dsh-capability-router

给接手这个仓库的 agent 看的。读完这份你应该知道：这个项目是什么、每轮怎么干、踩过哪些坑、哪些「问题」是刻意的别去修。

比这份更细的背景在 `DESIGN.md`（决策与教训，按日期记）、`TASKS.md`（任务卡与遗留项 L1–L12）、`docs/ARCHITECTURE.md`（结构）。这份只装「下一个人立刻会用到」的东西。

---

## 一、这是什么

DSH 插件。**只动协议，不动实现**：它改的是「什么时候该换人、换谁、换完谁收口、交付前要有什么证据」，不是模型怎么调工具。

三条硬约束，所有设计都绕着它们：

1. **拿不到会话的工作目录** —— 项目目录只能由模型显式传 `project` 参数。
2. **注入不进会话历史** —— 每步注入是旁路的，模型看不到自己上一轮被注了什么。
3. **阶段靠模型显式调 `expert(id, {project, phase})` 推进** —— 插件不会自己去读代码猜进度。

## 二、每轮的标准流程

用户的话术是固定的：**「重启完了，先确认上一轮修复的已生效，然后…」**。

```
核对生效 → 找 bug → 修 → 变异验证 → 升版本 → 文档 → push
```

### 1. 核对生效（不许跳过，不许用推理代替）

四路证据，缺一路就可能是在验证旧代码：

```bash
# ① 进程启动时间必须晚于改动文件的 mtime
powershell -NoProfile -Command "Get-Process 'DeepSeek Harness' | Select-Object -First 1 StartTime"
ls -l --time-style=+%H:%M:%S lib/index.js lib/state.js package.json

# ② 探针真调 tool.execute / pre-step，不是只读源码
node .scratch/probeNN.mjs

# ③ 真实运行数据在写
tail -3 ~/.dsh/capability-router/runs.jsonl

# ④ 面板 / 路由真起来过
curl -s "http://127.0.0.1:<port>/capability-router/panel?lang=en" | head -3
```

进程启动时间早于 mtime = 跑的还是旧代码，这时候任何「验证通过」都是假的。

### 2. 找 bug 的方法（比读代码有效）

- **矩阵探针**：把「阶段 × 专家种类 × 语言 × reopen × 专家人数」铺开跑一遍，看哪一格不说话 / 说错话。v0.20.4 的「交付后开审查专家静默」就是这么找出来的。
- **真实账本**：`node tools/gaps.mjs`、`~/.dsh/capability-router/runs.jsonl`。真实语料比构造的用例更能暴露「哪一类句子没人接」。
- **note 噪音体检**：跑一遍完整项目生命周期，逐步打印 `expert()` 的 `note`，看这一步到底说了几句、有没有互相顶。
- **换问法验收**：不要「抽三句能不能命中」，要「十二句真实需求各归各位落得中几句」。v0.21.5 就是这么发现英文召回只到 8/12 的。

### 3. 变异验证（每个修复的强制项）

改完代码，**必须把它改坏一次，确认测试变红，再改回来**。红在对的那条断言上才算数。

```bash
cp lib/x.js /tmp/x.bak
# 打变异：把判断改 false、把分支删掉、把文案换回旧的
npm test 2>&1 | grep AssertionError      # 必须看到期望的那条 message
cp /tmp/x.bak lib/x.js && npm test 2>&1 | grep -c "✓"
```

**假绿陷阱**：一步跑不完的路径不能用来测开关——v0.20.2 的 `qa` 只跑一步就验 `gap` 开关，结果是绿的（第一步被状态卡压住，开关根本没被读到）。**被别的注入压住的那一步，不能用来测这条注入。**

### 4. 升版本

每次修 bug 都升版本，`package.json` + `README.md` 头部 + `README.md` 状态表加一行。不升的后果是用户分不清重启后跑的是哪版。

commit 信息写三段：**修了什么 → 为什么（根因）→ 测试怎么验的**。别只写「fix bug」。

### 5. 文档

| 文件 | 什么时候改 |
|---|---|
| `README.md` | 版本号、状态表一行、能力表 |
| `docs/FEATURES.md` | 用户可见行为变了 |
| `docs/ARCHITECTURE.md` | 结构/成员/接口形状变了 |
| `DESIGN.md` | **每个值得记住的教训**，按日期追加，写「错在哪 + 判据」 |
| `TASKS.md` | 遗留项状态变化 |

## 三、环境坑（都踩过，别再踩）

**Python heredoc 往 JS 里写转义序列会被吃掉转义**：

```python
# ✗ 写进文件变成真实换行 / 退格符 → SyntaxError 或正则静默失效
s.replace('X', '"\\n"')      # → 真实换行
s.replace('X', r'\b')        # → \x08 退格符（/^(why)\b/ 里的 \b 消失）
# ✓ 用拼接绕过
s.replace('X', 'String.fromCharCode(10)')
s.replace('X', 'chr(92) + "b"')
```

**探针的调用签名**（写错会撞 `TypeError: next is not a function`）：

```js
// pre-step：第三个参数是 next 回调，注入要读 out.messages.slice(1)
const out = await pre({ agent: { id: "s1" }, messages }, async () => ({ kind: "continue", messages }));
const added = out.messages.slice(1).map((m) => m.content[0].text);

// tool.execute 只有两个参数；ctx 给五个桩
plugin.apply({ logger, effect(a){a()}, on(n,h){handlers.set(n,h)}, systemPrompt:{section(){}}, skills:{register:()=>()=>{}}, tools:{register(d){tool=d}} }, {});
const r = await tool.execute({ name: "intake", project: dir }, { agent: { id: "s1" } });
```

**`scanExperts` 是对象参数**，返回 `{ experts }`（数组，不是 Map）：`scanExperts({ dirs: [dir] }).experts`。

**Windows 上 `new URL(...).pathname` 会带前导斜杠**，路径喂给 `scanExperts` 前用 `fileURLToPath()`，否则扫出 0 个专家、所有路由都 miss。

## 四、代码习惯

**文案分两层，别混**：

- **静态层保持中文**：系统提示里的目录、`expert()` 的 `description`/`parameters`、十份 `role.md`。它们进缓存前缀，翻成两份等于每个语言一套缓存键。
- **动态层跟语言走**：每步注入（`HINT_TEXT`/`ASK_TEXT`/`gapText`/`secondaryText`）、状态卡、闸门、`nextStep`、`expert()` 的 `note`、role 末尾的 `## Language` 段、面板 HTML。

**判据：一个「一句话的出口」是一个整体**。`note` 里五句翻了三句比一句不翻更糟——模型会以为剩下的中文是内容而不是提示语义。

**阶段文案按「剩下的动作」分，不按「文案长短」分**。同一句「回去确认」在 build 对、在 deliver 错（活都干完了）。

**词表用长组合词，不用短词**。同义词计 1.0 而 `minScore` 也是 1.0，孤句里 1.0 就是唯一候选——「放进 synonyms 更安全」是错的。`校验`/`样本`/`函数签名` 是这么删掉的，代价写进 L4。

**英文边界放行屈折尾巴，不放回子串**：`(s|es|ed|ing)?` 让 `crash` 认 `crashes`；但 `so` 不许命中 `slow`。

**降级要报告，不许静默丢掉**。输入不合规（相对路径、写盘失败）可以降级，但必须在 note 里说一句「这一轮只在本轮有效」。静默降级是最贵的一种 bug。

**镜像不是事实源**。面板显示状态时，有项目文件就读项目文件，会话镜像只是退路。

## 五、验收命令

```bash
npm test                              # 152 场景，全绿才算完
npm run accept                        # a 集 20/20、b 集 20/20
node tools/match.mjs --set abc        # a 20/20 · b 20/20 · c 11/11
npm run check                         # 语法
npm run doctor                        # 技能供给
node tools/gaps.mjs                   # 真实落空账本（含语言分布）
```

任何一个 exit 非 0 都不许说「修好了」。

## 六、刻意的代价（别当 bug 修）

| 编号 | 是什么 | 为什么留着 |
|---|---|---|
| **L4** | `reverse` 的召回代价：`样本`/`校验`/`函数签名` 删光后，「帮我分析一下这个样本」会落空 | 留着会抢前端/后端/数据的活，**派错比空着贵** |
| **L8** | `approved` 会漏记：用户点头了、模型没调 `{approved:true}`，状态卡一直显示「待确认」 | 看得见的噪音比看不见的谎话便宜。兜底靠推进提醒 + 审查阻塞项 |
| **L11** | 英文 `role.md` 不做：英文会话靠 `## Language` 段 | 静态层进缓存，翻两份 = 每语言一套缓存键 |

误把这些当 bug 去「修」，会把已经算过账的取舍推翻。

## 七、这个项目自己的规矩（元层）

- **不用问就该做**：用户说「继续修剩下的问题」= 自己找、自己判断、做完再说。
- **先查再答**：说「已生效」「已推送」之前必须跑命令看输出，不能靠记忆。
- **一次只问一个会改变设计的问题**，附推荐答案；能自己定的别问。
- **改完必须自己跑一遍**，不许转述别人的验证结果当自己的。
