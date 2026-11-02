/**
 * 两种语言，一份判据。
 *
 * 插件判断的东西（这句是提问还是命令、这句像不像一件活、该不该开工）跟语言无关；
 * 但**说的话**跟语言有关。英文会话里塞中文提示，模型也许读得懂，用户读不懂；
 * 日志、面板、状态文件也会变成两种语言混排，事后没人愿意看。
 *
 * 判据只判一件事：这句用户话里有没有汉字。
 *   - 有汉字            → "zh"（哪怕夹着英文单词，说话的仍是中文用户）
 *   - 没汉字但有字母    → "en"
 *   - 都没有（空串、纯标点、纯数字）→ undefined，交给调用方沿用上一次的判定
 *
 * 返回 undefined 而不是 "zh" 是有意的：`？？？` 不携带语言信息，
 * 拿它去改判定等于让一串标点把会话切成英文。
 */

/** 汉字（含扩展 A 区，够用；不追求覆盖生僻字）。 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
/** 拉丁字母。 */
const LATIN = /[A-Za-z]/;

/**
 * 判这句用户话是哪种语言。
 * @param {unknown} text 用户原话
 * @returns {"zh"|"en"|undefined} undefined 表示这句没有语言信息
 */
export function detectLang(text) {
  const raw = String(text ?? "");
  if (raw.trim() === "") return undefined;
  if (HAN.test(raw)) return "zh";
  const letters = (raw.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 2) return undefined;
  // 贴一行代码 / 一条报错 / 一个路径，不该把中文会话切成英文。
  // 判据不是「有没有拉丁字母」——`const x = 1;` 也有，而且全是。
  // 看的是**符号密度**和**有没有空白分隔**：
  //   `const x = 1;`  字母 5、符号 2（= ;） → 代码，不猜
  //   `app.use(router);` 字母 13、符号 4（( ) . ;） → 代码，不猜
  //   `src/lib/index.js` 一整串没有空白 → 标识符 / 路径，不猜
  //   `add a delete button` 有空白、没符号 → 英文
  const marks = (raw.match(/[{}()\[\];=<>+\-*\|&!@#$%^~`]/g) ?? []).length;
  if (marks >= letters * 0.2) return undefined;
  if (!/\s/.test(raw.trim())) return undefined;
  return "en";
}

/**
 * 按语言二选一。`lang` 不是 "en" 时一律给中文——默认语言是中文，
 * 判不出来的时候宁可回到默认，也别半路切英文。
 */
export function t(lang, zh, en) {
  return lang === "en" ? en : zh;
}

/** 阶段英文名。中文名在 `lib/state.js` 的 `PHASE_LABEL`。 */
export const PHASE_LABEL_EN = {
  idle: "idle",
  spec: "spec",
  build: "build",
  review: "review",
  deliver: "deliver",
};

/** 用户水平英文名。 */
export const LEVEL_LABEL_EN = {
  novice: "novice",
  pro: "experienced",
};

/** 专家类别英文名（目录、note 里用）。 */
export const KIND_LABEL_EN = {
  intake: "intake",
  worker: "specialist",
  scout: "scout",
  reviewer: "reviewer",
};
