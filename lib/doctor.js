/**
 * 技能供给检查：专家的 `skills` 只是名字引用，装没装是另一件事。
 *
 * 这个模块只做纯计算，不碰文件系统——文件去哪读由调用方（tools/doctor.mjs）决定，
 * 这样测试可以用假目录，也不把「DSH_HOME 长什么样」写死在插件里。
 *
 * 原则：技能源码永不进本插件。专家的 `skills/` 目录是唯一例外（随专家包发布），
 * 其余一律要求用户自己装，之后由 DSH 的技能管理器升级。
 */

/**
 * 检查每个专家的技能依赖是否有着落。
 * @param {object[]} experts scanExperts() 的结果
 * @param {Set<string>|string[]} installed 已装技能名集合（不含专家自带）
 * @returns {{rows: object[], missingRequired: string[], missingOptional: string[]}}
 */
export function checkSupply(experts, installed) {
  const have = installed instanceof Set ? installed : new Set(installed);
  const rows = [];

  for (const expert of experts) {
    const own = new Set(expert.ownSkills ?? []);
    const deps = (expert.skillDeps ?? []).map((dep) => {
      const bundled = own.has(dep.name);
      const source = dep.source ?? "unknown";
      // source: host = 跟着 DSH 一起装的（office/pdf/playwright 这类），
      // 不在用户的技能目录里，但一定存在，所以按「有着落」处理，不产生假红。
      const unchecked = source === "host";
      return {
        name: dep.name,
        required: dep.required,
        source,
        bundled,
        unchecked,
        present: unchecked || bundled || have.has(dep.name),
      };
    });
    rows.push({
      id: expert.id,
      name: expert.name,
      kind: expert.kind ?? "worker",
      handoff: expert.handoff ?? [],
      deliverables: expert.deliverables ?? [],
      deps,
      missingRequired: deps.filter((dep) => dep.required && !dep.present),
      missingOptional: deps.filter((dep) => !dep.required && !dep.present),
    });
  }

  const missingRequired = [...new Set(rows.flatMap((row) => row.missingRequired.map((dep) => dep.name)))];
  const missingOptional = [...new Set(rows.flatMap((row) => row.missingOptional.map((dep) => dep.name)))];
  return { rows, missingRequired, missingOptional };
}

/**
 * 供给检查的退出码：有必装项缺席就非零。
 * @param {{missingRequired: string[]}} report
 * @returns {number}
 */
export function doctorExitCode(report) {
  return report.missingRequired.length === 0 ? 0 : 1;
}

/**
 * 渲染成人类可读的文本。
 * @param {{rows: object[], missingRequired: string[], missingOptional: string[]}} report
 * @param {{installedCount?: number, expertCount?: number}} [meta]
 * @returns {string}
 */
export function renderReport(report, meta = {}) {
  const lines = [];
  const expertCount = meta.expertCount ?? report.rows.length;
  const installedCount = meta.installedCount ?? 0;
  lines.push(`技能供给检查：专家 ${expertCount} 个，已装技能 ${installedCount} 个`);

  for (const row of report.rows) {
    const head = `\n${row.id}  ${row.name}（${row.kind}）`;
    lines.push(head);
    if (row.deps.length === 0) {
      lines.push("  （没有声明技能依赖）");
      continue;
    }
    for (const dep of row.deps) {
      const mark = dep.present ? "✓" : dep.required ? "✗" : "·";
      const where = dep.unchecked ? "宿主自带" : dep.bundled ? "专家自带" : dep.present ? dep.source : `缺（${dep.source}）`;
      const need = dep.required ? "必装" : "可选";
      lines.push(`  ${mark} ${dep.name.padEnd(34, " ")} ${need}  ${where}`);
    }
    if (row.handoff.length > 0) lines.push(`  常交给：${row.handoff.join("、")}`);
    if (row.deliverables.length > 0) lines.push(`  该产出：${row.deliverables.join("、")}`);
  }

  lines.push("");
  if (report.missingRequired.length === 0) {
    lines.push("必装技能都有着落。");
  } else {
    lines.push(`缺 ${report.missingRequired.length} 个必装技能：${report.missingRequired.join("、")}`);
    lines.push("装法：让 Agent 用它的技能管理装，或把这些专家的 required 改成 false（不推荐，等于承认这套角色凑不齐）。");
  }
  if (report.missingOptional.length > 0) {
    lines.push(`另有 ${report.missingOptional.length} 个可选技能没装：${report.missingOptional.join("、")}`);
  }
  return lines.join("\n");
}
