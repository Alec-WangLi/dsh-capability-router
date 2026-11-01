/**
 * 规则匹配器：一句话 → 该由哪个专家接。
 *
 * 不用模型，不读会话历史，只看这一句用户原话和专家包里的 triggers / description。
 * 理由写在 DESIGN 六.1：判断要可解释、可复现，出错了能指出是哪条触发词干的。
 *
 * 打分规则：
 *   - 触发词命中：权重随词长增长（1 + (len - 1) * 0.5，上限 2.5）。
 *     「数据库」比「数据」值钱，正是为了让更具体的词压过更笼统的词。
 *   - 描述命中：描述里按标点切出的词，每个 +0.5，最多 1.5。
 *     描述是用来兜底的，不该单独决定归属。
 *   - 中文按子串匹配，英文按词边界匹配（避免 CSS 命中 CSS3 之外的意外，也避免 React 命中 Reactive）。
 *
 * 三种结论：hit（定了）、ambiguous（分差太小，列前两名让人挑）、miss（没人接）。
 * 刻意保留 ambiguous：硬选一个错的，比说「像是 A 也可能是 B」更糟。
 */

const CJK = /[\u4e00-\u9fff]/;
const DESCRIPTOR_SPLIT = /[、，,。．;；:：\s/|]+/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 触发词权重：长词更值钱。 */
export function termWeight(term) {
  const length = [...String(term)].length;
  return Math.min(2.5, 1 + Math.max(0, length - 1) * 0.5);
}

/** 英文按词边界匹配，中文按子串匹配。 */
function termHit(haystack, term) {
  if (term === "") return false;
  if (CJK.test(term)) return haystack.includes(term);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * 给单个专家打分。
 * @returns {{score: number, hits: string[], described: string[]}}
 */
export function scoreExpert(text, expert) {
  const haystack = String(text ?? "").toLowerCase();
  const hits = [];
  const synonyms = [];
  let score = 0;

  for (const trigger of expert.triggers) {
    const term = String(trigger).toLowerCase();
    if (termHit(haystack, term)) {
      score += termWeight(term);
      hits.push(trigger);
    }
  }

  // 同义词：固定 1.0，总量封顶 2.0——口语词能单独定案，但堆再多也压不过一个正经触发词。
  // 已经当触发词命中过的词不再重复计分，否则「慢」这种两处都写的词会凭空翻倍。
  const matched = new Set(hits.map((hit) => String(hit).toLowerCase()));
  let synonymScore = 0;
  for (const synonym of expert.synonyms ?? []) {
    const term = String(synonym).toLowerCase();
    if (matched.has(term)) continue;
    if (termHit(haystack, term)) {
      const add = Math.min(1, 2 - synonymScore);
      if (add <= 0) break;
      synonymScore += add;
      synonyms.push(synonym);
    }
  }

  const described = [];
  const words = new Set(String(expert.description ?? "").split(DESCRIPTOR_SPLIT).map((word) => word.trim().toLowerCase()).filter((word) => [...word].length >= 2));
  let bonus = 0;
  for (const word of words) {
    if (termHit(haystack, word)) {
      const add = Math.min(0.5, 1.5 - bonus);
      if (add <= 0) break;
      bonus += add;
      described.push(word);
    }
  }

  return { score: Number((score + synonymScore + bonus).toFixed(2)), hits, synonyms, described };
}

/**
 * 匹配一个专家。
 * @param {string} text 用户原话
 * @param {object[]} experts `scanExperts()` 的结果
 * @param {{minScore?: number, margin?: number}} options
 * @returns {{kind: "hit"|"ambiguous"|"miss", expert?: object, candidates: object[]}}
 */
export function matchExpert(text, experts, options = {}) {
  const minScore = options.minScore ?? 1;
  const margin = options.margin ?? 0.35;

  const ranked = experts
    .map((expert) => ({ expert, ...scoreExpert(text, expert) }))
    .sort((left, right) => right.score - left.score || left.expert.id.localeCompare(right.expert.id));

  const [top, second] = ranked;
  if (top === undefined || top.score < minScore) {
    return { kind: "miss", candidates: ranked.slice(0, 2) };
  }
  if (second !== undefined && top.score - second.score < margin) {
    return { kind: "ambiguous", candidates: [top, second] };
  }
  return { kind: "hit", expert: top.expert, candidates: [top] };
}

/** 把匹配结果压成一行，供日志和自检技能使用。 */
export function describeMatch(result) {
  if (result.kind === "hit") return `命中「${result.expert.name}」`;
  if (result.kind === "ambiguous") {
    const names = result.candidates.map((row) => `${row.expert.name}(${row.score})`).join(" 或 ");
    return `分不清：${names}`;
  }
  return "没有对口专家";
}
