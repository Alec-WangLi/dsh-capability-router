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
 *
 * 两条实测补丁（2026-11-02 真实用例复盘，见 docs/REAL-TEST-2026-11-02.md）：
 *
 *   1. **入口专家不参加竞争**。接单专家的触发词里有「需求」「项目」这种通用词，
 *      结果把「把这个需求文档改成给老板看的版本」判成了接单（4.0 压过文档的 3.5）。
 *      它是「没人接时去哪儿」的出口，不是抢活的人：只要有别的专家过线，就排到后面。
 *      副作用是好的——入口专家可以放心写宽词，写宽了也不会抢活。
 *
 *   2. **主次**。头名领先、次名也明显过线时，不是「分不清」，是「顺带还要干另一半」。
 *      这种情况仍判 hit，但带上 secondary，由上层提醒「别只做一半」。
 *      词面有包含关系时不算（"数据" 被 "数据库" 包含只是噪音，不是第二个领域）。
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
 * 次名是否被头名的命中词「包含」——「数据」落在「数据库」里只是词面噪音。
 * @param {string[]} bigger 头名的命中词
 * @param {string[]} smaller 次名的命中词
 * @returns {boolean}
 */
function coveredBy(bigger, smaller) {
  const big = bigger.map((term) => String(term).toLowerCase());
  return smaller.some((term) => {
    const small = String(term).toLowerCase();
    return big.some((other) => other.includes(small));
  });
}

/**
 * 计算「副领域」：头名领先但次名仍明显过线时，这部分活也得有人干。
 * @returns {object|undefined}
 */
function secondaryOf(top, second, minScore) {
  if (top === undefined || second === undefined) return undefined;
  if (second.score < minScore * 1.5) return undefined;
  if (coveredBy(top.hits, second.hits)) return undefined;
  return second;
}

/**
 * 匹配一个专家。
 * @param {string} text 用户原话
 * @param {object[]} experts `scanExperts()` 的结果
 * @param {{minScore?: number, margin?: number, multiMin?: number}} options
 * @returns {{kind: "hit"|"ambiguous"|"multi"|"miss", expert?: object, candidates: object[], secondary?: object}}
 */
export function matchExpert(text, experts, options = {}) {
  const minScore = options.minScore ?? 1;
  const margin = options.margin ?? 0.35;
  // 三个以上专家同时过线 = 这件事跨领域，不是「分不清」也不是「没人接」。
  const multiMin = options.multiMin ?? 3;

  const scored = experts.map((expert) => ({ expert, ...scoreExpert(text, expert) }));

  // 入口专家不参加竞争：有别的专家过线时，它排到那些专家之后。
  const hasRival = scored.some((row) => (row.expert.kind ?? "worker") !== "intake" && row.score >= minScore);
  const ranked = scored
    .map((row) => ({ ...row, demoted: hasRival && (row.expert.kind ?? "worker") === "intake" }))
    .sort(
      (left, right) =>
        Number(left.demoted) - Number(right.demoted) ||
        right.score - left.score ||
        left.expert.id.localeCompare(right.expert.id),
    );
  // 之后的判定只看还在场上的人：「分不清」和「跨领域」都不该被让位的入口专家搅局。
  const active = ranked.filter((row) => !row.demoted);

  const [top, second] = active;
  if (top === undefined || top.score < minScore) {
    // 落空时只带「真的沾了点边」的候选（分数 > 0）。
    // 全部为 0 还带上前两名，记录里会显示成 `rout:"miss", cands:["backend","data"]`，
    // 复盘时读起来像「差一点就命中后端」——实际一个字都没沾。
    return { kind: "miss", candidates: ranked.filter((row) => row.score > 0).slice(0, 2) };
  }
  // 「跨领域」要求每个涉及的专家都明显过线（1.5 倍阈值），不是刚够 1.0 的词面噪音。
  const strong = active.filter((row) => row.score >= minScore * 1.5);
  // 「跨领域」要满足两个条件，缺一不可：够多（默认 3 个以上过线）、够平（头名不满头名两倍）。
  // 只看数量会把「给用户表加个索引，查询太慢了」这种明确的后端活判成跨领域——
  // 那里的 data / debug 只是词面噪音，不是第二个领域。
  if (strong.length >= multiMin) {
    return { kind: "multi", candidates: strong };
  }
  if (second !== undefined && top.score - second.score < margin) {
    return { kind: "ambiguous", candidates: [top, second] };
  }
  const secondary = secondaryOf(top, second, minScore);
  if (secondary === undefined) {
    return { kind: "hit", expert: top.expert, candidates: [top] };
  }
  return { kind: "hit", expert: top.expert, candidates: [top], secondary };
}

/** 把匹配结果压成一行，供日志和自检技能使用。 */
export function describeMatch(result) {
  if (result.kind === "hit") {
    const tail = result.secondary === undefined ? "" : `（副：${result.secondary.expert.name}）`;
    return `命中「${result.expert.name}」${tail}`;
  }
  if (result.kind === "multi") {
    const names = result.candidates.map((row) => row.expert.name).join("、");
    return `跨领域：${names}`;
  }
  if (result.kind === "ambiguous") {
    const names = result.candidates.map((row) => `${row.expert.name}(${row.score})`).join(" 或 ");
    return `分不清：${names}`;
  }
  return "没有对口专家";
}
