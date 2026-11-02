/**
 * 缺口账本记语言（v0.21.3）。
 *
 * 为什么要这个：`gaps.jsonl` 回答的是「哪些话没人接」。英文适配之后，
 * 同样的账本还要回答「英文语料落空率是多少」——那是补不补英文词表的
 * 唯一依据。没有这个字段，英文落空和中文落空在账本上长得一模一样。
 *
 * 英文才记：中文是基线，旧行没有这个键就按中文读。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gap-lang-"));
process.env.DSH_HOME = HOME;

const plugin = await import("../lib/index.js");
const handlers = new Map();
plugin.apply(
  {
    logger: { warn() {}, info() {} },
    effect(apply) { apply(); },
    on(name, handler) { handlers.set(name, handler); return () => {}; },
    systemPrompt: { section() {} },
    skills: { register: () => () => {} },
    tools: { register() {} },
  },
  {},
);

const pre = handlers.get("agent/pre-step");
const say = async (id, text) => {
  const messages = [{ role: "user", id: `g${Math.random().toString(16).slice(2, 8)}`, content: [{ type: "text", text }], source: { kind: "user" } }];
  await pre({ agent: { id }, messages }, async () => ({ kind: "continue", messages }));
};

await say("sess-gap-en", "convert the purple widget into a blue one");
await say("sess-gap-zh", "把紫色的那个小部件转成蓝色的");

const file = path.join(HOME, "capability-router", "gaps.jsonl");
const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const english = rows.find((row) => row.text.startsWith("convert the purple widget"));
const chinese = rows.find((row) => row.text.startsWith("把紫色的那个"));

assert.ok(english !== undefined, "英文落空要记账");
assert.equal(english.lang, "en", "英文落空要在账本上标出来");
assert.ok(chinese !== undefined, "中文落空要记账");
assert.equal(Object.hasOwn(chinese, "lang"), false, "中文是基线，旧行没有这个键，新行也别加");

// 谁说出来的：`tools/gaps.mjs` 要把语言分布报出来。账本记了没人读等于没记——
// 补不补英文词表，看的就是这一行的比例。
{
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["tools/gaps.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DSH_HOME: HOME },
    encoding: "utf8",
  });
  assert.match(out, /按语言：中文 1 条 \/ 英文 1 条/, "要报出中英各几条");
  assert.match(out, /非中文占 50%/, "要报出非中文的占比——那是补词表的判据");
}

console.log("gap-lang: ok");
