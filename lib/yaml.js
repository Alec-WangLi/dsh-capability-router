/**
 * 极简 YAML 子集解析器。
 *
 * 为什么不用现成的库：本插件的卖点之一是零依赖，装到任何 profile 里都不会跟宿主的
 * 依赖树打架。专家包只需要「扁平 key + 标量 + 一维列表」，用不着完整 YAML。
 *
 * 支持：
 *   key: 值               标量（自动去引号，true/false/null/数字转成对应类型）
 *   key: [a, b, c]        行内列表
 *   key:                  后跟缩进 "- item" 的块列表
 *   # 整行注释、空行
 *
 * 不支持（遇到会进 warnings，不静默吞）：
 *   多行文本块（| 或 >）、二级以上的嵌套映射、锚点与别名、流式映射 {a: b}
 */

const KEY_LINE = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/;

function parseScalar(raw) {
  const text = raw.trim();
  if (text === "") return "";
  if (text === "[]") return [];
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => stripQuotes(item.trim()));
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return stripQuotes(text);
}

function stripQuotes(text) {
  if (text.length >= 2) {
    const head = text[0];
    const tail = text[text.length - 1];
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * 解析一份 YAML 子集文档。
 * @param {string} text 文件内容
 * @returns {{data: Record<string, unknown>, warnings: string[]}}
 */
export function parseYamlSubset(text) {
  const data = {};
  const warnings = [];
  let pending = null; // 上一个 "key:" 后面可能挂块列表
  let inBlock = false; // 跳过多行文本块的残留内容

  const lines = String(text ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indented = line.length !== line.trimStart().length;

    if (trimmed.startsWith("- ")) {
      if (inBlock) continue;
      if (pending === null) {
        warnings.push(`第 ${index + 1} 行：列表项没有归属的 key，已忽略`);
        continue;
      }
      const value = parseScalar(trimmed.slice(2));
      const bucket = data[pending];
      if (!Array.isArray(bucket)) data[pending] = [];
      data[pending].push(value);
      continue;
    }

    const match = KEY_LINE.exec(trimmed);
    if (match === null) {
      if (inBlock) continue;
      warnings.push(`第 ${index + 1} 行：无法解析，已忽略`);
      continue;
    }

    if (inBlock) {
      // 多行块的正文，整段丢弃。
      if (indented) continue;
      inBlock = false;
    }
    if (indented) {
      warnings.push(`第 ${index + 1} 行：不支持嵌套映射，已忽略`);
      continue;
    }

    const [, key, rest] = match;
    const value = rest.trim();
    if (/^[|>][-+]?$/.test(value)) {
      warnings.push(`第 ${index + 1} 行：不支持多行文本块，请写单行或改用 role.md`);
      data[key] = "";
      inBlock = true;
      pending = null;
      continue;
    }
    if (value === "") {
      // 可能是空值，也可能是块列表的表头；先按块列表准备，收尾时再定。
      data[key] = [];
      pending = key;
      continue;
    }
    data[key] = parseScalar(value);
    pending = null;
  }

  return { data, warnings };
}

/** 把任意值规整成字符串数组；非数组按空数组处理。 */
export function toStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}
