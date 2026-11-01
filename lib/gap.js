/**
 * 缺口提示：匹配落空时说什么，以及什么情况下干脆不说。
 *
 * 难点不在措辞，在**克制**。「今天中午吃什么」也匹配不到专家，但它不需要任何人说
 * 「没有干这个的人」。所以先判一件事：这句像不像一件要交付的活。
 *
 * 判法还是规则，不调模型：看有没有「任务形态」的词（帮我 / 做个 / 改成 / 排查……）。
 * 宁可漏报——漏报的代价是少一句提示，误报的代价是每句闲聊都被插一段废话。
 */

/** 任务形态的词：出现任意一个，就认为用户是在派活，而不是在聊天。 */
const TASK_HINTS = [
  "帮我", "帮忙", "给我", "替我",
  "做个", "做一个", "写个", "写一个", "加个", "加一个", "搞个", "生成",
  "实现", "搭建", "接入", "对接", "部署", "迁移", "重构", "改成", "换成",
  "排查", "定位", "修一下", "修复", "优化", "整理", "分析", "设计", "评估", "统计",
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

/**
 * 生成缺口提示。
 * @param {{kind: string, expert?: object, candidates?: object[]}} verdict 路由结论
 * @param {{experts: object[]}} catalog
 * @param {string} text 用户原话
 * @returns {string | undefined} 不该说话时返回 undefined
 */
export function gapText(verdict, catalog, text) {
  if (verdict.kind === "hit") return undefined;

  const names = catalog.experts.map((expert) => expert.name);

  if (verdict.kind === "ambiguous") {
    const [left, right] = verdict.candidates ?? [];
    if (left === undefined || right === undefined) return undefined;
    return `【能力路由 · 分不清】
这句话同时落在「${left.expert.name}」和「${right.expert.name}」的地盘上，两边都说得通。
挑一个开始做就行——选错改起来不贵；真拿不准就问一句再动手，别两边各做一半。`;
  }

  // miss：只有像「一件活」的时候才开口，闲聊不打扰。
  if (!looksLikeTask(text)) return undefined;
  const existing = names.length === 0 ? "（当前一个专家包都没有）" : names.join("、");
  return `【能力路由 · 没有对口的专家】
现有专家：${existing}——都不是干这个的。
直接告诉用户「我手上没有干这个的人」，并说清缺的是什么；不要拿相近的技能硬凑，也不要假装做过。
如果这活以后会反复出现，可以提议给它建一个专家包（\`expert.yml\` + \`role.md\`），人审之后再落盘。`;
}
