#!/usr/bin/env node
/**
 * 把 DSH 的会话日志 dump 成可读 JSONL。
 *
 * DSH 把会话写进 `~/.dsh/sessions/<cwd-slug>/session-<id>/session.v4.jsonl.zstd`。
 * 这个文件是**多帧 zstd 串联**的：每追加一批事件就压一帧，然后接在后面。
 * `zlib.zstdDecompressSync` 只解第一帧（通常几百字节），得到的东西毫无用处。
 *
 * 正确做法是扫所有帧头 magic（28 b5 2f fd），按相邻 magic 切片，逐帧解压再拼接。
 *
 * 用法：
 *   node tools/dump-session.mjs <session.v4.jsonl.zstd> [--out dump.jsonl] [--stats]
 *   node tools/dump-session.mjs <session-dir>            目录里唯一的 .zstd 会被选中
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 按帧头 magic 把一个 zstd 多帧文件切成单帧。 */
function splitFrames(buf) {
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += MAGIC.length;
  }
  const frames = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = offsets[k + 1] ?? buf.length;
    frames.push(buf.subarray(start, end));
  }
  return frames;
}

/** 逐帧解压后拼接。坏帧跳过并计数，不中断整体。 */
function decompressAll(buf) {
  const frames = splitFrames(buf);
  const chunks = [];
  let failed = 0;
  for (const frame of frames) {
    try {
      chunks.push(zlib.zstdDecompressSync(frame));
    } catch {
      failed += 1;
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), frames: frames.length, failed };
}

/** 找到目标文件：给目录就取里面唯一的 .zstd。 */
function resolveTarget(input) {
  const p = path.resolve(input);
  const st = fs.statSync(p);
  if (st.isFile()) return p;
  const candidates = fs.readdirSync(p).filter((name) => name.endsWith(".zstd"));
  if (candidates.length === 0) throw new Error(`${p} 里没有 .zstd 文件`);
  if (candidates.length > 1) {
    throw new Error(`${p} 里有多个 .zstd，请直接指定：${candidates.join(", ")}`);
  }
  return path.join(p, candidates[0]);
}

function stats(events) {
  const byType = new Map();
  const toolsByName = new Map();
  let turns = 0;
  let steps = 0;
  const injected = [];

  for (const event of events) {
    const type = event?.type ?? "(none)";
    byType.set(type, (byType.get(type) ?? 0) + 1);

    if (type === "turn/start") turns += 1;
    if (type === "step/start") steps += 1;

    if (type === "tool/call") {
      const name = event?.data?.name ?? "(unknown)";
      toolsByName.set(name, (toolsByName.get(name) ?? 0) + 1);
    }

    if (type === "user/message") {
      // user/message 的正文在 data.content，source 在 data.source。
      // 注意 assistant/message 的结构不同，正文在 data.message.content。
      const data = event?.data;
      const kind = data?.source?.kind;
      if (kind && kind !== "user") {
        const content = Array.isArray(data?.content) ? data.content : [];
        const text = content
          .filter((item) => item?.type === "text")
          .map((item) => item.text ?? "")
          .join("");
        const entries = Array.isArray(data?.source?.entries) ? data.source.entries.length : null;
        injected.push({ kind, length: text.length, entries });
      }
    }
  }

  const lines = [];
  lines.push(`事件总数 ${events.length}｜turn ${turns}｜step ${steps}`);
  lines.push("");
  lines.push("事件类型：");
  [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => lines.push(`  ${type.padEnd(24)} ${count}`));

  if (toolsByName.size > 0) {
    lines.push("");
    lines.push("工具调用：");
    [...toolsByName.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, count]) => lines.push(`  ${name.padEnd(24)} ${count}`));
  }

  if (injected.length > 0) {
    lines.push("");
    lines.push("非用户来源的 user 消息（注入）：");
    for (const item of injected) {
      const tail = item.entries === null ? "" : ` / ${item.entries} 条`;
      lines.push(`  ${String(item.kind).padEnd(24)} ${item.length} 字符${tail}`);
    }
  }

  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log("用法: node tools/dump-session.mjs <session.v4.jsonl.zstd | session-dir> [--out dump.jsonl] [--stats]");
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const input = argv[0];
  const outIndex = argv.indexOf("--out");
  const outPath = outIndex !== -1 ? argv[outIndex + 1] : null;
  const wantStats = argv.includes("--stats");

  const file = resolveTarget(input);
  const raw = fs.readFileSync(file);
  const { text, frames, failed } = decompressAll(raw);

  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // 半行（最后一帧可能不完整）直接丢
    }
  }

  console.log(`源文件   ${file}`);
  console.log(`压缩大小 ${raw.length.toLocaleString()} B｜帧数 ${frames}｜解压失败 ${failed} 帧`);
  console.log(`解压大小 ${text.length.toLocaleString()} 字符｜事件 ${events.length} 条`);

  if (outPath) {
    fs.writeFileSync(outPath, events.map((event) => JSON.stringify(event)).join("\n"), "utf8");
    console.log(`已写出   ${path.resolve(outPath)}`);
  }

  if (wantStats) {
    console.log("");
    console.log(stats(events));
  }
}

main();
