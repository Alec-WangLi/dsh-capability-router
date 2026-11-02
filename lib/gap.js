/**
 * 缺口提示：匹配落空时说什么，以及什么情况下干脆不说。
 *
 * 难点不在措辞，在**克制**。「今天中午吃什么」也匹配不到专家，但它不需要任何人说
 * 「没有干这个的人」。所以先判一件事：这句像不像一件要交付的活。
 *
 * 判法还是规则，不调模型：看有没有「任务形态」的词（帮我 / 做个 / 改成 / 排查……）。
 * 宁可漏报——漏报的代价是少一句提示，误报的代价是每句闲聊都被插一段废话。
 *
 * 2026-11-02 真实用例复盘后改了三处（docs/REAL-TEST-2026-11-02.md）：
 *   - 任务词表补了「做一款 / 想做 / 搞一个 / 开发 / 从零……」。真实首句是
 *     「我想做一款Windows记账软件」，旧词表一个都没收，整场静默。
 *   - 落空时不再先说「没有干这个的人」。全新项目几乎必然落空（触发词是「界面」「接口」，
 *     而用户说的是「做一款记账软件」），先说没人等于把最常见的场景说错。有接单专家就先接单。
 *   - 「分不清」从「挑一个开始做就行」改成「问一句再动手」。原话术在鼓励硬选。
 */

/** 任务形态的词：出现任意一个，就认为用户是在派活，而不是在聊天。 */
const TASK_HINTS = [
  "帮我", "帮忙", "给我", "替我",
  "做个", "做一个", "做一款", "想做个", "想做", "想要个", "要个", "弄个",
  "搞个", "搞一个", "搭一个", "开个", "接个",
  "写个", "写一个", "加个", "加一个", "生成",
  "实现", "搭建", "接入", "对接", "部署", "迁移", "重构", "改成", "换成",
  "排查", "定位", "修一下", "修复", "优化", "整理", "分析", "设计", "评估", "统计",
  "开发", "从零", "整套", "交个", "上线",
  "怎么", "如何", "为什么", "需要", "支持", "能不能", "可不可以",
];

/**
 * 这句像不像一件活。
 * @param {string} text 用户原话
 * @returns {boolean}
 */
export function looksLikeTask(text) {
  const haystack = String(text ?? "").toLowerCase();
  if (haystack.trim() === "") return false;
  return TASK_HINTS.some((hint) => haystack.includes(hint));
}

/** 真派活才有的词：出现任意一个，这句话就是在要东西，哪怕它带着问号。 */
const COMMAND_HINTS = [
  "帮我", "帮忙", "给我", "替我",
  "做个", "做一个", "做一款", "想做个", "搞个", "搭一个",
  "写个", "写一个", "加个", "加一个", "改成", "换成", "换成",
  "实现", "搭建", "接入", "对接", "部署", "迁移", "重构",
  "排查", "修一下", "修复", "优化", "整理", "分析", "设计", "评估", "统计",
  "开发", "从零", "整套", "上线",
];

/**
 * 「要一个不一样的结果」的特征——委婉请求和真提问的分界线。
 *
 * 「能不能把这个按钮改大一点」「这个可以做成深色主题吗」句式上是疑问，要做的是改动；
 * 「能不能离线用」「支持多语言吗」句式一样，要的是答案。差别不在疑问词，在**有没有一个
 * 要变的量**：处置式（把…改/换/删）、改变动作（做成/调成/变）、程度补语（一点/一些/大点）。
 *
 * 判错的代价不对称：把命令判成提问，注入会劝它「别改代码」，该干的活停住；把提问判成
 * 命令，只是少一句提醒。所以这条排除宁可宽——有改变特征就按活儿算。
 */
const CHANGE_HINTS = [
  "把", "做成", "调成", "变", "重做", "挪",
  "一点", "一些", "点儿", "点吧", "大点", "小点", "淡点", "深点", "快点", "慢点", "长点", "短点",
];

/**
 * 这段话自己点名了要谁干。
 *
 * 派单书（「你现在的身份是后端工程师（用 `expert("backend")` 取完整工作方式）」）本来就把人
 * 指定好了。可它同时提到前端、测试、审查——按词面算，`matchExpert` 判它跨领域是对的；
 * 按语义算，再选一次人是错的：**选人这件事已经做完了**。
 *
 * 真实缺口账本里 5 条 `multi` 全是这种派单书，注入的是「按主领域开工，交付时把副的那部分
 * 一起交」——可后端工程师不该顺手把前端也做了，那是另一个会话的活。
 *
 * @param {string} text 用户那句话
 * @param {object[]} experts `scanExperts()` 的结果
 * @returns {object|undefined} 被点名的专家
 */
export function explicitExpert(text, experts) {
  const raw = String(text ?? "");
  if (raw === "") return undefined;
  const byCall = /expert\(\s*["'`]([A-Za-z][A-Za-z0-9_-]*)["'`]/.exec(raw);
  if (byCall !== null) {
    const id = byCall[1].toLowerCase();
    const hit = (experts ?? []).find((expert) => String(expert.id).toLowerCase() === id);
    if (hit !== undefined) return hit;
  }
  // 中文派单不一定带 `expert("…")`：「身份：审查专家」「你是后端工程师」。
  // 派单书爱用 markdown 加粗（`身份：**审查专家**`），先去掉标记再比，
  // 否则「身份：**审查专家**」这种最常见的样子一条都认不出来。
  const plain = raw.replace(/[*_`]/g, "");
  for (const expert of experts ?? []) {
    for (const tag of [expert.name, expert.id]) {
      if (typeof tag !== "string" || tag === "") continue;
      if (plain.includes(`身份：${tag}`) || plain.includes(`身份是${tag}`) || plain.includes(`你是${tag}`)) {
        return expert;
      }
    }
  }
  return undefined;
}

/**
 * 这句话是不是在要一个答案，而不是在派活。
 *
 * 与 `looksLikeTask` 是两个问题，不能互相顶替：那个问「像不像一件活」，把「怎么 / 如何 /
 * 为什么」也算成活——对缺口提示是对的（「怎么实现 X」确实要人干），但对「提问还是命令」
 * 就是错的（「这个按钮为什么没反应」是要解释，不是要改动）。
 *
 * 判据两条同时成立：① 有疑问形态（问号结尾，或疑问词）；② 没有真派活的动词。
 * 第二条是护栏——「导出为什么失败？帮我修一下」既有问号又有「帮我」，那是活。
 *
 * @param {string} text 用户原话
 * @returns {boolean}
 */
export function looksLikeQuestion(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return false;
  const asks = /[?？]\s*$/.test(raw) || /(为什么|怎么|如何|能不能|可不可以|是不是|会不会|有没有|吗)/.test(raw);
  if (!asks) return false;
  const haystack = raw.toLowerCase();
  if (COMMAND_HINTS.some((hint) => haystack.includes(hint))) return false;
  if (CHANGE_HINTS.some((hint) => haystack.includes(hint))) return false;
  return true;
}

/**
 * 命中时的「副领域」提示：头名已经明确，但同一句话里还有一半活没主。
 * @param {{expert?: object, secondary?: object}} verdict
 * @returns {string|undefined}
 */
export function secondaryText(verdict) {
  const main = verdict.expert;
  const second = verdict.secondary;
  if (main === undefined || second === undefined) return undefined;
  return `【能力路由 · 主次】
主要是「${main.name}」（${second.expert.name} 那边也占了一部分）。
按主领域开工，但**交付前把 ${second.expert.name} 那部分一起处理掉**——别只交一半。
需要两份产出就分两次 \`expert()\`，别自己硬扛另一边的活。`;
}

/**
 * 生成缺口提示。
 * @param {{kind: string, expert?: object, candidates?: object[]}} verdict 路由结论
 * @param {{experts: object[]}} catalog
 * @param {string} text 用户原话
 * @param {{phase?: string, phaseLabel?: string}} [options] 项目模式下的阶段（idle 或缺省＝非项目模式）
 * @returns {string | undefined} 不该说话时返回 undefined
 */
export function gapText(verdict, catalog, text, options = {}) {
  if (verdict.kind === "hit") return undefined;
  // 已经点名了人：选人这一步做完了，不需要再说「该选谁」。
  if (verdict.kind === "explicit") return undefined;

  const experts = catalog.experts ?? [];
  const names = experts.map((expert) => expert.name);
  const intake = experts.find((expert) => expert.kind === "intake");

  if (verdict.kind === "multi") {
    const [main, ...rest] = verdict.candidates ?? [];
    if (main === undefined) return undefined;
    const others = rest.map((row) => `${row.expert.name}(${row.score})`).join("、");
    const intakeLine =
      intake === undefined
        ? ""
        : `
如果是新项目（不是改既有东西），先 \`expert("${intake.id}")\` 拆任务卡，再按卡分派。`;
    return `【能力路由 · 跨领域】
主：${main.expert.name}（${main.score}）；副：${others}。
按主领域开工，但**交付时把副的那部分一起交**——别只做一半，也别自己一个领域一个领域串着硬扛。${intakeLine}
两边分量接近（分差 < 0.5）时，先问用户一句哪边更急，问完再动手。`;
  }

  if (verdict.kind === "ambiguous") {
    const [left, right] = verdict.candidates ?? [];
    if (left === undefined || right === undefined) return undefined;
    return `【能力路由 · 分不清】
这句话同时落在「${left.expert.name}」和「${right.expert.name}」的地盘上，两边都说得通。
别硬选：先问用户一句「更偏 ${left.expert.name} 还是 ${right.expert.name}？」，给 2~3 个具体选项，一次问完。
用户点完再开工——选错的代价不是改代码，是整段活白做；但也别为了省这一问，两边各做一半。`;
  }

  // miss：只有像「一件活」的时候才开口，闲聊不打扰。
  if (!looksLikeTask(text)) return undefined;

  // 项目模式（phase 不是 idle）：单已经接过了，再劝一次 `expert("intake")` 是错的——
  // 用「先自己判断：按卡继续，还是这块该补人」代替。hit / multi / ambiguous 逐字不变。
  const phase = options.phase;
  if (phase !== undefined && phase !== "idle") {
    const label = options.phaseLabel ?? phase;
    return `【能力路由 · 没命中具体专家】
这句没落到某位专家的触发词上；项目已在「${label}」阶段。
先自己判断：按任务卡继续做，还是这块确实该补一个专家——别硬派给沾边的，派错了它会把错的 role.md 注进上下文。`;
  }

  // 全新项目几乎必然落空（触发词是「界面」「接口」，用户说的是「做一款记账软件」）。
  // 先说「没人干这个」是把最常见的场景判错，所以有接单专家时它才是第一句。
  if (intake !== undefined) {
    return `【能力路由 · 没命中具体专家】
这句话没有直接落到某位专家的触发词上，但**不等于没人接**：先 \`expert("${intake.id}")\` 接单，
让它把模糊需求收敛成 \`REQUIREMENTS.md\` + \`TASKS.md\`，再按任务卡分派给领域专家。
拆完如果确实有没人接的部分，再对用户说「这块我手上没有对应的人」，并说清缺的是什么——不要拿相近的技能硬凑。`;
  }

  const existing = names.length === 0 ? "（当前一个专家包都没有）" : names.join("、");
  return `【能力路由 · 没有对口的专家】
现有专家：${existing}——都不是干这个的。
直接告诉用户「我手上没有干这个的人」，并说清缺的是什么；不要拿相近的技能硬凑，也不要假装做过。
如果这活以后会反复出现，可以提议建一个专家包：\`node tools/forge.mjs <id> --name <名字> --description <一句话> --triggers <词,词>\` 生成骨架，改完 \`role.md\`、人审过再落盘，重启后生效。`;
}
