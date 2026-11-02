/**
 * 匹配器验收脚本。
 *
 * 两套句子：
 *   a —— 按触发词写的「标准说法」，用来做回归：改打分规则时它不能掉。
 *   b —— 自然口语，故意不照着触发词写，用来做验收：DESIGN 落地路线第 3 步要求 > 70%。
 *
 *   node tools/match.mjs            # 两套都跑
 *   node tools/match.mjs --set b    # 只跑自然说法
 *   node tools/match.mjs --json
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { expertDirs, scanExperts } from "../lib/experts.js";
import { describeMatch, matchExpert } from "../lib/router.js";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** expected 为 null = 应该没人接；"ambiguous" = 应该分不清；其它 = 应该是这个专家 id。 */
const SET_A = [
  ["这个页面的样式在窄屏下全乱了", "frontend"],
  ["帮我把这个按钮的交互改顺一点", "frontend"],
  ["React 组件为什么渲染两次", "frontend"],
  ["接口返回 500，日志里只有一行 timeout", "backend"],
  ["给用户表加个索引，查询太慢了", "backend"],
  ["这个服务部署上去之后老是重启", "backend"],
  ["数据库事务和缓存双写怎么保证一致", "backend"],
  ["把这次的设计文档补一下", "docs"],
  ["帮我写个周报，说说这周做了啥", "docs"],
  ["把 README 改得能看懂一点", "docs"],
  ["启动就崩溃，什么都没打印", "debug"],
  ["跑测试的时候偶发失败，十次里两次", "debug"],
  ["内存一直涨，怀疑泄漏", "debug"],
  ["帮我把这个 Excel 汇总成一张表", "data"],
  ["这几个 PDF 合并成一册", "data"],
  ["把这堆数据做成 PPT 汇报", "data"],
  ["帮我做视频监控系统", null],
  ["今天中午吃什么", null],
  ["帮我写一下这个接口的文档", "ambiguous"],
  ["这个页面的数据处理太慢了", "ambiguous"],
];

const SET_B = [
  ["登录页点不动", "frontend"],
  ["这个表怎么只有三列", "data"],
  ["部署脚本挂了好几次", "backend"],
  ["写个邮件跟客户解释延迟", "docs"],
  ["帮我把这段代码改成异步", "backend"],
  ["这个动画有点卡", "frontend"],
  ["帮我把会议纪要整理一下", "docs"],
  ["怎么把 PDF 里的表导出来", "data"],
  ["帮看看这段 SQL 为什么慢", "ambiguous"],
  ["生成的报告打不开", "ambiguous"],
  ["首页加载白屏了", "debug"],
  ["这个接口超时的时候会重试吗", "backend"],
  ["帮我总结一下这次事故", "docs"],
  ["表格里日期格式不统一", "data"],
  ["这个组件的 props 改了没刷新", "frontend"],
  ["缓存没生效，每次都是全量查", "backend"],
  ["帮我把这段需求写成文档", "docs"],
  ["服务重启后内存暴涨", "ambiguous"],
  ["帮我做个报价单", "data"],
  ["这段文字太长了，帮我精简一下", "docs"],
];


/** 调参时没看过的 8 句：只用来观察泛化，不进验收分子。 */
const SET_C = [
  ["这个弹窗关不掉", "frontend"],
  ["接口文档更新了吗", "ambiguous"],
  ["帮我把这张表做成图表", "data"],
  ["线上挂了，先看看日志", "debug"],
  ["需求评审的会议纪要和周报", "docs"],
  ["这个数字对不上，帮我核一下", null],
  ["这段配置为什么没起作用", "debug"],
  ["客户投诉说页面打不开", "frontend"],
  // v0.20.0 加的三位专家（A8）：期望写死，命中不到就是 expert.yml 的词表要改（归 T3）。
  ["这 exe 怎么校验激活码的", "reverse"],
  ["写一套回归用例把登录流程盖住", "qa"],
  ["先查查市面上有没有现成的记账软件", "research"],
];

const SETS = { a: SET_A, b: SET_B, c: SET_C };

const wanted = process.argv.find((arg) => arg.startsWith("--set="))?.slice(6) ?? (process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : "ab");
const chosen = [...new Set(wanted.split(""))].filter((key) => SETS[key] !== undefined);
if (chosen.length === 0) {
  console.error("--set 只认 a / b / c");
  process.exit(2);
}

const stateDir = path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? "", ".dsh"), "capability-router");
const { experts, warnings, errors } = scanExperts({ dirs: expertDirs(stateDir) });

if (experts.length === 0) {
  console.error("没有扫到任何专家包，先检查 experts/ 目录");
  process.exit(1);
}

function runSet(name) {
  const rows = SETS[name].map(([text, expected]) => {
    const result = matchExpert(text, experts);
    const ok =
      expected === "ambiguous"
        ? result.kind === "ambiguous"
        : expected === null
          ? result.kind === "miss"
          : result.kind === "hit" && result.expert.id === expected;
    const got = result.kind === "hit" ? result.expert.id : result.kind;
    return { text, expected: expected ?? "miss", got, ok, detail: describeMatch(result) };
  });
  const correct = rows.filter((row) => row.ok).length;
  return { name, rows, correct, total: rows.length, rate: correct / rows.length };
}

const results = chosen.map(runSet);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ experts: experts.length, warnings, errors, results }, null, 2));
} else {
  for (const result of results) {
    console.log(`\n=== 句子集 ${result.name} ===`);
    for (const row of result.rows) {
      if (row.ok) continue;
      console.log(`✗ ${row.text}`);
      console.log(`   期望 ${String(row.expected).padEnd(10)} 得到 ${String(row.got).padEnd(10)} ${row.detail}`);
    }
    console.log(`命中率 ${result.correct}/${result.total} = ${(result.rate * 100).toFixed(0)}%`);
  }
  console.log("");
  console.log("目标：b 集 > 70%，a 集作为回归不得低于 90%");
  if (warnings.length > 0) console.log(`专家包告警 ${warnings.length} 条：${warnings.slice(0, 3).join("; ")}`);
  if (errors.length > 0) console.log(`专家包错误 ${errors.length} 条：${errors.join("; ")}`);
  const failed = results.some((result) => result.name === "b" && result.rate <= 0.7) || results.some((result) => result.name === "a" && result.rate < 0.9);
  if (failed) process.exitCode = 1;
}
