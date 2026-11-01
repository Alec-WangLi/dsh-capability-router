import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogText, expertTool } from "./catalog.js";
import { expertDirs, renderExpertList, scanExperts } from "./experts.js";
import { gapText } from "./gap.js";
import { matchExpert } from "./router.js";
import {
  advancePhase,
  gateNote,
  newState,
  openExpert,
  projectStateFile,
  readState,
  stateCardText,
  stateFile,
  writeState,
} from "./state.js";
import { attachWebPanel } from "./web.js";

/** 插件标识，必须与 package.json 的 name 一致。 */
export const name = "dsh-capability-router";

/**
 * 依赖的宿主服务。
 * systemPrompt 用来注入「能力路由」的长期原则与专家目录；skills 用来注册自检技能；
 * tools 用来注册 expert(name)——按需取某位专家的完整工作方式。
 */
export const inject = ["systemPrompt", "skills", "tools"];

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const STATE_DIR = path.join(DSH_HOME, "capability-router");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const RUNS_FILE = path.join(STATE_DIR, "runs.jsonl");

/** 本插件注入消息的 source.kind，用来做去重与辨识。 */
const HINT_KIND = "capability-router-hint";
/** 专家角色提示词注入的 source.kind。 */
const ROLE_KIND = "capability-router-role";
/** 缺口提示（分不清 / 没人接）注入的 source.kind。 */
const GAP_KIND = "capability-router-gap";
/** 项目模式的状态卡注入的 source.kind。 */
const STATE_KIND = "capability-router-state";

const DEFAULTS = {
  /** 总开关。关掉后不注入任何东西，行为与未安装完全一致。 */
  enabled: true,
  /** 是否注入系统提示里的长期原则段。 */
  intake: true,
  /** 是否在每条用户消息后追加一次当轮检查点。 */
  hint: true,
  /** 是否扫描专家包。关掉后自检技能不再列专家，匹配器也不会启用。 */
  experts: true,
  /** 是否把专家目录写进系统提示（稳定前缀，可被 prefix cache 命中）。 */
  catalog: true,
  /** 是否注册 expert(name) 工具，按需取 role.md 全文。 */
  expertTool: true,
  /**
   * 项目模式：打开接单专家后写会话状态，之后每步注入一行状态卡，
   * 并把当轮检查点降级（两条协议同时喊话会撕注意力，见 ARCHITECTURE 第三节）。
   */
  project: true,
  /** 把每次 pre-step 的结论记进 runs.jsonl（会话、阶段、命中、注入类型）。 */
  runs: true,
  /**
   * 把只读面板挂到宿主 Web 服务上（`/capability-router/panel` 与 `/api/state`）。
   * 同源、同端口：远程访问时地址天然正确，client 半边 iframe 直接吃。
   */
  web: true,
  /** 命中专家后注入它的 role.md。 */
  role: true,
  /** 匹配落空（分不清 / 没人接）时提示一句；闲聊不触发。 */
  gap: true,
  /** 把落空的句子记到 gaps.jsonl，用来决定先造哪个专家。 */
  gapLog: true,
  /** 提示词段的排序位；dsh-purge 的尾段在 5100，这里排在它前面。 */
  order: 5000,
  /** 打开后在 <STATE_DIR>/trace.jsonl 记每次 pre-step 的现场，排查挂钩用。 */
  debug: false,
};

/**
 * 常驻在系统提示里的长期原则。
 * 它离用户那句话很远，作用只是「背景设定」；真正起作用的是 HINT_TEXT。
 */
const INTAKE_TEXT = `## 能力路由

两件事：需求有空白先问清楚，能力对不上先说出来。

**问清楚**：遇到会改变实现方向的空白，一次只问一个问题，附上你的推荐答案。需求已经明确就直接做，不为走流程反复确认。

**说清楚**：技能目录只是摘要，要按某个技能的指令做事，先用 skill 工具把它加载出来。手上没有对应能力就直说「我手上没有对应能力」，并指出缺什么——不要拿相近的技能硬凑，也不要假装做过。`;

/**
 * 每条用户消息后面紧跟的一次性检查点。
 * 这段话的作用不是「告诉模型一条规则」，而是在它即将开口的那一刻，
 * 把「这句话是提问还是命令」摆到眼前。
 */
const HINT_TEXT = `【能力路由 · 当轮检查】

先归类用户这句话，再决定动作：

- **提问**（要答案）：直接答。不要顺手改代码，不要先跑一堆命令验证。
- **命令**（要动作）：有一个会改变实现方向的黑洞就问，一次只问一个，附上推荐答案；没有就开工。
- **报告**（是继续）：接着做，别重新评估已经定下的事。

开工前扫一眼技能目录：对口就加载完整指令再动手；不对口就说「我手上没有对应能力」并说缺什么。`;

/** 读配置；文件缺失或损坏时回落到默认值。 */
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* 首次运行没有配置文件属正常情况 */
  }
  return {};
}

/** 合并写回配置，返回合并后的完整对象。 */
export function saveConfig(patch) {
  const next = { ...DEFAULTS, ...readConfig(), ...patch };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * 找出最后一条「真人说的话」。
 * 系统注入的 agent-instructions / runtime-context / skill-catalog / time-context
 * 也是 user 角色，靠 source.kind 区分。
 */
function lastUserPrompt(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.source?.kind === "user") return message;
  }
  return undefined;
}

/** 这一条用户消息是否已经注入过检查点。 */
function hasHintFor(messages, promptId) {
  return messages.some(
    (message) =>
      message?.source?.kind === HINT_KIND && message.source.forPrompt === promptId,
  );
}

/**
 * 已注入过检查点的用户消息 id。
 * 只靠 messages 去重不够稳：注入的消息不一定出现在下一步的 messages 里，
 * 那种情况下每跑一步都会再追加一条，一轮能堆出几十条。
 * 消息 id 是 UUID，跨会话不会撞，所以这里直接按 id 记账，不需要按 agent 分桶。
 */
const hintedPrompts = new Set();
const HINT_LEDGER_LIMIT = 500;

function markHinted(promptId) {
  hintedPrompts.add(promptId);
  if (hintedPrompts.size > HINT_LEDGER_LIMIT) {
    const keep = [...hintedPrompts].slice(-Math.floor(HINT_LEDGER_LIMIT / 2));
    hintedPrompts.clear();
    for (const id of keep) hintedPrompts.add(id);
  }
}

/** 已经注入过角色提示词的用户消息 id。 */
const rolePrompts = new Set();

function markRole(promptId) {
  rolePrompts.add(promptId);
  if (rolePrompts.size > HINT_LEDGER_LIMIT) {
    const keep = [...rolePrompts].slice(-Math.floor(HINT_LEDGER_LIMIT / 2));
    rolePrompts.clear();
    for (const id of keep) rolePrompts.add(id);
  }
}

/** 已经注入过状态卡的用户消息 id。 */
const statePrompts = new Set();

function markState(promptId) {
  statePrompts.add(promptId);
  if (statePrompts.size > HINT_LEDGER_LIMIT) {
    const keep = [...statePrompts].slice(-Math.floor(HINT_LEDGER_LIMIT / 2));
    statePrompts.clear();
    for (const id of keep) statePrompts.add(id);
  }
}

/** 构造一条缺口提示消息。 */
function gapMessage(text, promptId) {
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text }],
    source: { kind: GAP_KIND, form: "notice", forPrompt: promptId },
  });
}

/** 已经注入过缺口提示的用户消息 id。 */
const gapPrompts = new Set();

function markGap(promptId) {
  gapPrompts.add(promptId);
  if (gapPrompts.size > HINT_LEDGER_LIMIT) {
    const keep = [...gapPrompts].slice(-Math.floor(HINT_LEDGER_LIMIT / 2));
    gapPrompts.clear();
    for (const id of keep) gapPrompts.add(id);
  }
}

/** 构造一条检查点消息，形状与宿主 createUserMessage 的产物一致。 */
function hintMessage(promptId) {
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text: HINT_TEXT }],
    source: { kind: HINT_KIND, form: "notice", forPrompt: promptId },
  });
}

/** 项目模式的状态卡。 */
function stateMessage(promptId, state) {
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text: stateCardText(state) }],
    source: { kind: STATE_KIND, form: "notice", forPrompt: promptId, phase: state.phase },
  });
}

/** 从用户消息里取出纯文本。 */
function promptText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** 构造一条专家角色消息。角色是背景，不是命令，所以只用一段普通正文。 */
function roleMessage(expert, promptId) {
  return Object.freeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text: `【能力路由 · 当前专家：${expert.name}】\n\n${expert.role.trim()}` }],
    source: { kind: ROLE_KIND, form: "notice", forPrompt: promptId, expert: expert.id },
  });
}

/**
 * 把每次注入记到 hints.jsonl。
 * pre-step 注入的消息不进会话历史，光看会话文件证明不了它跑过，所以留一份落地记录；文件超过 64 KB 时只保留最近一半。
 */
function recordHint(promptId) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, "hints.jsonl");
    fs.appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), promptId })}\n`,
      "utf8",
    );
    if (fs.statSync(file).size > 64 * 1024) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`, "utf8");
    }
  } catch {
    /* 记账失败不影响注入 */
  }
}

/** 追加一行到状态目录下的 jsonl，超过 64 KB 时只保留最近一半。 */
function appendLedger(file, line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(file, `${line}\n`, "utf8");
    if (fs.statSync(file).size > 64 * 1024) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`, "utf8");
    }
  } catch {
    /* 记账失败不影响注入 */
  }
}

/**
 * 记一次 pre-step 的结论：会话、阶段、命中、注入了什么。
 * 只记判断不记原话——原话在 gaps.jsonl 里，两件事分开看。
 */
function recordRun(info) {
  appendLedger(RUNS_FILE, JSON.stringify(info));
}

/**
 * 记一次「没人接」的句子，用来回答「该先造哪个专家」。
 * 只记原话与结论，不记上下文——gaps.jsonl 是要被人拿去看的。
 */
function recordGap(verdict, text) {
  appendLedger(
    path.join(STATE_DIR, "gaps.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      kind: verdict.kind,
      text: text.slice(0, 200),
      candidates: (verdict.candidates ?? []).map((row) => row.expert.id),
    }),
  );
}

/** 打开 debug 时记每次 pre-step 的现场，用来判断挂钩有没有跑起来。 */
function recordTrace(info) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, "trace.jsonl");
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...info })}\n`, "utf8");
    if (fs.statSync(file).size > 64 * 1024) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`, "utf8");
    }
  } catch {
    /* 诊断失败不影响注入 */
  }
}

function describeState(config, catalog) {
  const onOff = (value) => (value ? "开" : "关");
  const expertCount = catalog?.experts.length ?? 0;
  return [
    `- 长期原则段：${onOff(config.intake)}`,
    `- 当轮检查点：${onOff(config.hint)}`,
    `- 专家角色注入：${onOff(config.role)}`,
    `- 缺口提示：${onOff(config.gap)}（记账 ${onOff(config.gapLog)} → gaps.jsonl）`,
    `- 专家包：${onOff(config.experts)}（${expertCount} 个：${catalog?.experts.map((expert) => expert.id).join("、") || "无"}）`,
    `- 专家目录（系统提示）：${onOff(config.catalog)}`,
    `- expert(name) 工具：${onOff(config.expertTool)}`,
    `- 项目模式：${onOff(config.project)}（状态卡 + 闸门 + sessions/*.json）`,
    `- 运行记录：${onOff(config.runs)}（runs.jsonl）`,
    `- 面板路由：${onOff(config.web)}（/capability-router/panel）`,
    `- 调试记录：${onOff(config.debug)}（trace.jsonl）`,
    `- 配置文件：\`${CONFIG_FILE}\``,
  ].join("\n");
}

function selfSkillContent(config, catalog) {
  const problems = [...(catalog?.errors ?? []), ...(catalog?.warnings ?? [])];
  const problemBlock =
    problems.length === 0
      ? ""
      : `\n### 专家包告警\n\n${problems.map((line) => `- ${line}`).join("\n")}\n`;
  return `# capability-router

本机自研的能力路由插件。当前状态：

${describeState(config, catalog)}

## 它现在做什么

五处动作，分工不同：

1. **长期原则段**（系统提示）——背景设定，讲「需求有空白先问、能力对不上先说」。位置靠后，容易被大段项目规则淹没。
2. **当轮检查点**（\`agent/pre-step\`）——每条用户消息后面紧跟一段，把「这句话是提问还是命令」摆到模型眼前。这一处才是真正会改变行为的地方。
3. **专家路由**（\`agent/pre-step\`）——拿用户那句原话做规则匹配：命中就注入该专家的 \`role.md\`。分不清或没人接时不硬选。
4. **缺口提示**（\`agent/pre-step\`）——分不清就点出是哪两个专家在抢；一个都没命中且这句话像在派活，就说「没有干这个的人」。判断「像不像一件活」也是规则，闲聊不打扰。
5. **专家目录 + \`expert(name)\` 工具**（系统提示 + 工具）——v0.9 的入口：目录常驻、详情按需。它跟前面四条不是一回事：前四条是插件替模型判断，这一条是把判断权交回去。

外加一个自检技能：你能读到这段文字，说明 \`ctx.skills.register()\` 链路是通的。

专家声明的技能装没装，跑 \`npm run doctor\` 就知道（\`source: host\` 的依赖不查，那是跟着 DSH 一起装的）。

## 已识别的专家

${renderExpertList(catalog?.experts ?? [])}

专家包放在两处，同名 id 以内层（用户目录）为准：

\`\`\`text
<包内>/experts/<id>/        随插件发布，改它要动源码
${STATE_DIR}\\experts\\<id>/   用户自建或覆盖，改这里即时生效
  expert.yml   name / description / triggers / skills / tools
  role.md      命中后注入的角色提示词
  skills/      可选，专家自带的技能
\`\`\`
${problemBlock}
## 它之后要做什么

已经能记账了：每次没人接（或分不清）的原话写进 \`gaps.jsonl\`，\`node tools/gaps.mjs\` 聚合出「哪个领域反复没人接」，据此决定先造哪个专家。之后的方向是把「造专家」也变成一条命令能跑完的闭环——现在已经有一半（\`tools/forge.mjs\` 生成骨架 + 当场校验），缺的是从缺口记录直接起草 \`expert.yml\`。


## 怎么调整

改 \`${CONFIG_FILE}\`，下一次会话生效：

\`\`\`json
{
  "intake": true,
  "hint": true,
  "role": true,
  "experts": true,
  "gap": true,
  "gapLog": true,
  "catalog": true,
  "expertTool": true,
  "project": true,
  "runs": true
}
\`\`\`

- \`intake\`：关掉就不再注入系统提示里的原则段。
- \`hint\`：关掉就不再追加当轮检查点。两者都关等于插件隐身。
- \`role\`：命中专家后注入 \`role.md\`。
- \`gap\`：分不清 / 没人接时提示一句；闲聊不触发。
- \`gapLog\`：把落空的原话记进 \`gaps.jsonl\`，用 \`node tools/gaps.mjs\` 看哪个领域最缺人。
- \`catalog\` / \`expertTool\`：专家目录进系统提示、注册 \`expert(name)\` 工具。两者都关等于回到「插件替模型选人」。
- \`project\`：项目模式下状态卡取代检查点，缺口闭嘴。
- \`runs\`：把每次 pre-step 的判断记进 \`runs.jsonl\`。

## 造一个专家

匹配落空且这活会反复出现时，用工具生成骨架：

\`\`\`bash
node tools/forge.mjs rtsp --name 流媒体工程师 \\
  --description "摄像头接入、推流、回放与存储" \\
  --triggers 摄像头,推流,RTSP,回放,目标检测 --skills pdf
\`\`\`

它会写进 \`<状态目录>/experts/<id>/\`，写完当场用同一个扫描器校验，不通过就不落盘。必填参数缺一个就报错退出——不猜触发词、不编描述，猜出来的措辞会被直接接受，那比生成失败更糟。

落地顺序：改 \`role.md\`（骨架只是占位）→ 人审 → 重启 DSH（专家包在挂载时扫描）。

## 排查

目录里看不到 \`capability-router\` 这个技能，说明插件没挂上。先去 profile 的 \`cordis.patch.yml\` 确认挂载项用的是 \`insert\`——不带 \`insert\` 的 patch 只能改已有条目，新 id 会被静默跳过。
`;
}

function selfSkill(config, catalog) {
  return {
    name: "capability-router",
    description:
      "能力路由插件自身的说明与开关：当前注入状态、已识别的专家包、怎么调整开关。当用户问「你怎么选的技能」「某个技能为什么没出现」「有哪些专家」「怎么让技能按需加载」时加载。",
    content: selfSkillContent(config, catalog),
    source: "capability-router",
    provider: "capability-router",
    invocation: { modelInvocable: true, userInvocable: true },
  };
}

/**
 * 挂载插件。任何一步失败都只记告警，不向上抛——插件挂载异常会拖垮宿主启动。
 */
export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULTS, ...readConfig(), ...config };
  if (!resolved.enabled) return;

  /** 专家包在挂载时扫一次：它是磁盘状态，不随对话变化，每次会话重扫就够。 */
  const catalog = resolved.experts
    ? scanExperts({ dirs: expertDirs(STATE_DIR) })
    : { experts: [], warnings: [], errors: [] };

  if (resolved.debug) {
    recordTrace({
      event: "apply",
      inject: resolved.hint ? "hint" : "no-hint",
      experts: catalog.experts.map((expert) => expert.id),
      expertProblems: catalog.errors.length + catalog.warnings.length,
    });
  }

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`capability-router: ${message}`);
    } catch {
      /* 日志自身失败不影响挂载 */
    }
  };

  if (resolved.intake) {
    try {
      ctx.effect(
        () =>
          ctx.systemPrompt.section({
            name: "capability-intake",
            order: resolved.order,
            interpolate: false,
            text: INTAKE_TEXT,
          }),
        "capability-router: 能力路由原则",
      );
    } catch (error) {
      warn(`原则段注册失败 ${error?.message ?? error}`);
    }
  }

  const catalogSection = resolved.catalog && catalog.experts.length > 0 ? catalogText(catalog.experts) : "";
  if (catalogSection !== "") {
    try {
      ctx.effect(
        () =>
          ctx.systemPrompt.section({
            name: "capability-experts",
            order: resolved.order + 1,
            interpolate: false,
            text: catalogSection,
          }),
        "capability-router: 专家目录",
      );
    } catch (error) {
      warn(`专家目录注册失败 ${error?.message ?? error}`);
    }
  }

  if (resolved.expertTool && catalog.experts.length > 0 && ctx.tools !== undefined) {
    try {
      const definition = expertTool(catalog.experts, {
        onOpen: (expert, exec, args) => {
          if (!resolved.project) return undefined;
          const sessionId = exec?.agent?.id;
          const explicitProject =
            typeof args?.project === "string" && path.isAbsolute(args.project) ? args.project : undefined;
          const sessionState = typeof sessionId === "string" && sessionId !== "" ? readState(stateFile(STATE_DIR, sessionId)) : undefined;
          // 项目优先：同一项目的多个会话共用一份阶段（多代理协作时这是常态）。
          const projectDir = explicitProject ?? sessionState?.project;
          const file = projectDir === undefined ? (sessionId === undefined ? undefined : stateFile(STATE_DIR, sessionId)) : projectStateFile(projectDir);
          if (file === undefined) return undefined;
          const before = readState(file) ?? newState(sessionId ?? projectDir);

          // 显式推进：模型交卷时说一声（expert("intake", { phase: "build" })）。
          // 不这么做的话 spec 之后没有出口——没有谁能在文件系统层面替它判「需求确认完了」。
          let after = openExpert(before, expert);
          let phaseError;
          const target = typeof args?.phase === "string" ? args.phase : undefined;
          if (target !== undefined) {
            const moved = advancePhase(after, target);
            after = moved.state;
            phaseError = moved.error;
          }
          if (after.phase !== before.phase || after.experts.length !== before.experts.length) {
            writeState(file, projectDir === undefined ? after : { ...after, project: projectDir });
          }
          // 会话文件永远留一份指针（+ 阶段镜像），pre-step 才能知道这个会话属于哪个项目。
          if (typeof sessionId === "string" && sessionId !== "") {
            writeState(stateFile(STATE_DIR, sessionId), {
              ...(sessionState ?? newState(sessionId)),
              phase: after.phase,
              experts: after.experts,
              ...projectDir === undefined ? {} : { project: projectDir },
            });
          }
          // 闸门要按「推进之后」的状态判：需求确认完、阶段已进 build 时再说「先别开工」就是自相矛盾。
          const note = phaseError === undefined ? gateNote(after, expert) : `⚠️ 阶段没有推进：${phaseError}`;
          return note === undefined ? undefined : { note };
        },
      });
      ctx.effect(() => ctx.tools.register(definition), "capability-router: expert 工具");
    } catch (error) {
      warn(`expert 工具注册失败 ${error?.message ?? error}`);
    }
  }

  // 面板路由：挂在宿主 Web 服务上，与插件同版本、同源。
  if (resolved.web) {
    const options = { stateDir: STATE_DIR, dshHome: DSH_HOME };
    try {
      if (typeof ctx.inject === "function") {
        ctx.inject(["webServer"], (sub) => attachWebPanel(sub, options, warn));
      } else if (ctx.webServer !== undefined) {
        attachWebPanel(ctx, options, warn);
      }
    } catch (error) {
      warn(`面板挂载失败 ${error?.message ?? error}`);
    }
  }

  if (resolved.hint || resolved.role || resolved.gap) {
    try {
      ctx.on("agent/pre-step", async (payload, next) => {
        const decision = await next();
        if (decision.kind === "reject") return decision;
        try {
          const fromPayload = Array.isArray(payload?.messages) ? payload.messages : [];
          const fromDecision = Array.isArray(decision?.messages) ? decision.messages : [];
          const messages = fromDecision.length > 0 ? fromDecision : fromPayload;
          const prompt = lastUserPrompt(messages);

          // 只对「真人那句话」判一次专家：系统注入的消息不参与路由。
          const text = prompt === undefined ? "" : promptText(prompt);
          let verdict = { kind: "miss", candidates: [] };
          if (resolved.experts && catalog.experts.length > 0 && text !== "") {
            verdict = matchExpert(text, catalog.experts);
          }

          if (resolved.debug) {
            recordTrace({
              p: fromPayload.length,
              d: fromDecision.length,
              keys: Object.keys(decision ?? {}).join("|"),
              pkeys: Object.keys(payload ?? {}).join("|"),
              lastKind: messages[messages.length - 1]?.source?.kind ?? null,
              promptId: prompt?.id ?? null,
              rout: verdict.kind,
              expert: verdict.expert?.id ?? null,
            });
          }

          if (prompt === undefined) return decision;

          // 项目模式：会话有状态就从文件读。插件不猜阶段，只读事实。
          const sessionId = typeof payload?.agent?.id === "string" ? payload.agent.id : undefined;
          const sessionState =
            resolved.project && sessionId !== undefined ? readState(stateFile(STATE_DIR, sessionId)) : undefined;
          const projectState =
            sessionState?.project !== undefined
              ? readState(projectStateFile(sessionState.project)) ?? sessionState
              : sessionState;
          const projectMode = projectState !== undefined && projectState.phase !== "idle";

          const additions = [];
          // 目录（v2）在场时不再做规则角色注入：选人交给模型，再注入一次是在唱反调。
          if (resolved.role && !resolved.catalog && verdict.kind === "hit" && verdict.expert.hasRole && !rolePrompts.has(prompt.id)) {
            markRole(prompt.id);
            additions.push(roleMessage(verdict.expert, prompt.id));
          }
          // 缺口提示与缺口记账共用同一个判据：先算出「这句该不该有人接」的结论，
          // 不开口的句子（闲聊天）也不记账——否则记录里全是「今天吃什么」。
          if (!projectMode && (resolved.gap || resolved.gapLog) && verdict.kind !== "hit" && !gapPrompts.has(prompt.id)) {
            const note = gapText(verdict, catalog, text);
            if (note !== undefined) {
              markGap(prompt.id);
              if (resolved.gapLog) recordGap(verdict, text);
              if (resolved.gap) additions.push(gapMessage(note, prompt.id));
            }
          }
          if (projectMode && !statePrompts.has(prompt.id)) {
            markState(prompt.id);
            additions.push(stateMessage(prompt.id, projectState));
          }
          // 项目模式下检查点降级：状态卡已经说了该干什么，再追加三分法会撕注意力。
          if (resolved.hint && !projectMode && !hintedPrompts.has(prompt.id) && !hasHintFor(messages, prompt.id)) {
            markHinted(prompt.id);
            recordHint(prompt.id);
            additions.push(hintMessage(prompt.id));
          }

          if (resolved.runs) {
            recordRun({
              at: new Date().toISOString(),
              session: sessionId ?? null,
              phase: projectState?.phase ?? "idle",
              promptId: prompt.id ?? null,
              rout: verdict.kind,
              expert: verdict.expert?.id ?? null,
              injected: additions.map((message) => message.source?.kind ?? "unknown"),
            });
          }

          if (additions.length === 0) return decision;
          return { ...decision, messages: [...messages, ...additions] };
        } catch (error) {
          warn(`路由失败 ${error?.message ?? error}`);
          return decision;
        }
      });
    } catch (error) {
      warn(`pre-step 挂钩失败 ${error?.message ?? error}`);
    }
  }

  try {
    ctx.effect(() => ctx.skills.register(selfSkill(resolved, catalog)), "capability-router: 自检技能");
  } catch (error) {
    warn(`自检技能注册失败 ${error?.message ?? error}`);
  }
}
