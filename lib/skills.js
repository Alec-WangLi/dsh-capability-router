/**
 * 本机装了哪些技能：扫技能目录，看每个子目录里有没有 SKILL.md。
 *
 * 单独一个模块，因为两处都要用：`tools/doctor.mjs` 拿它做供给体检，
 * `tools/panel.mjs` 拿它渲染面板。体检本身（lib/doctor.js）保持纯计算，不碰文件。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 默认技能目录：用户目录下的 skills，加上额外传入的绝对路径。
 * @param {string} dshHome
 * @param {string[]} [extra]
 * @returns {string[]}
 */
export function defaultSkillDirs(dshHome, extra = []) {
  return [path.join(dshHome, "skills"), ...extra];
}

/**
 * 扫描技能目录。
 * @param {string[]} dirs
 * @returns {Map<string, string>} 技能名 → 目录绝对路径
 */
export function discoverSkills(dirs) {
  const found = new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      let files;
      try {
        files = fs.readdirSync(child);
      } catch {
        continue;
      }
      if (files.some((file) => file.toLowerCase() === "skill.md")) found.set(entry.name, child);
    }
  }
  return found;
}
