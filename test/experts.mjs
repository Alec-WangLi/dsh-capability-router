import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExpert, scanExperts } from "../lib/experts.js";
import { parseYamlSubset, toStringList } from "../lib/yaml.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "caprouter-experts-"));

function writeExpert(root, id, yaml, role) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "expert.yml"), yaml, "utf8");
  if (role !== undefined) fs.writeFileSync(path.join(dir, "role.md"), role, "utf8");
  return dir;
}

// 场景一：行内列表 + 标量类型
{
  const { data, warnings } = parseYamlSubset(
    ["name: 前端工程师", "triggers: [界面, 样式, 前端]", "port: 8080", "on: true"].join("\n"),
  );
  assert.equal(data.name, "前端工程师");
  assert.deepEqual(data.triggers, ["界面", "样式", "前端"]);
  assert.equal(data.port, 8080);
  assert.equal(data.on, true);
  assert.equal(warnings.length, 0);
}

// 场景二：块列表 + 注释 + 空行
{
  const { data, warnings } = parseYamlSubset(
    ["# 注释", "skills:", "  - a", "  - b", "", "tools: []"].join("\n"),
  );
  assert.deepEqual(data.skills, ["a", "b"]);
  assert.deepEqual(data.tools, []);
  assert.equal(warnings.length, 0);
}

// 场景三：不支持的多行文本块要报警，不能静默吞
{
  const { warnings } = parseYamlSubset(["name: x", "desc: |", "  多行"].join("\n"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /多行文本块/);
}

// 场景四：缺 name 直接判无效
{
  const root = path.join(tmpDir, "bad");
  writeExpert(root, "broken", "description: 没有名字\ntriggers: [x]\n");
  const result = loadExpert(path.join(root, "broken"));
  assert.equal(result.expert, undefined);
  assert.match(result.errors.join(";"), /name 为空/);
}

// 场景五：缺 role.md 只是告警，专家仍可用
{
  const root = path.join(tmpDir, "norole");
  writeExpert(root, "quiet", "name: 无角色\ndescription: 只注入技能\ntriggers: [安静]\nskills: [a]\n");
  const result = loadExpert(path.join(root, "quiet"));
  assert.equal(result.expert.name, "无角色");
  assert.deepEqual(result.expert.skills, ["a"]);
  assert.equal(result.expert.hasRole, false);
  assert.match(result.warnings.join(";"), /没有 role\.md/);
}

// 场景六：未知字段告警
{
  const root = path.join(tmpDir, "unknown");
  writeExpert(root, "odd", "name: 怪\ndescription: d\ntriggers: [x]\nauthor: me\n");
  const result = loadExpert(path.join(root, "odd"));
  assert.match(result.warnings.join(";"), /未知字段 author/);
}

// 场景七：仓库自带的五个专家都能读出来
{
  const result = scanExperts({ dirs: [path.join(REPO_ROOT, "experts")] });
  assert.equal(result.errors.length, 0, `不应有错误：${result.errors.join(";")}`);
  assert.equal(result.experts.length, 5, `应扫出 5 个专家，实际 ${result.experts.length}`);
  for (const expert of result.experts) {
    assert.equal(expert.hasRole, true, `${expert.id} 缺 role.md`);
    assert.ok(expert.triggers.length > 0, `${expert.id} 没有触发词`);
    assert.ok(expert.description.length > 0);
  }
  const ids = result.experts.map((expert) => expert.id).sort();
  assert.deepEqual(ids, ["backend", "data", "debug", "docs", "frontend"]);
}

// 场景八：内层目录同名覆盖外层，且坏的那份不退回旧版本
{
  const outer = path.join(tmpDir, "outer");
  const inner = path.join(tmpDir, "inner");
  writeExpert(outer, "shared", "name: 外层\ndescription: 旧\ntriggers: [旧]\n");
  writeExpert(inner, "shared", "name: 内层\ndescription: 新\ntriggers: [新]\n");
  const overridden = scanExperts({ dirs: [outer, inner] });
  assert.equal(overridden.experts.length, 1);
  assert.equal(overridden.experts[0].name, "内层");

  writeExpert(inner, "shared", "description: 没名字\ntriggers: [新]\n");
  const broken = scanExperts({ dirs: [outer, inner] });
  assert.equal(broken.experts.length, 0, "内层坏掉时不应静默回退到外层");
  assert.match(broken.errors.join(";"), /name 为空/);
}

// 场景九：toStringList 宽容处理
{
  assert.deepEqual(toStringList("单个"), ["单个"]);
  assert.deepEqual(toStringList(undefined), []);
  assert.deepEqual(toStringList([" a ", ""]), ["a"]);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("场景一 行内列表      ✓");
console.log("场景二 块列表注释    ✓");
console.log("场景三 多行块告警    ✓");
console.log("场景四 缺 name 判无效 ✓");
console.log("场景五 缺 role 告警  ✓");
console.log("场景六 未知字段告警  ✓");
console.log("场景七 五个专家      ✓");
console.log("场景八 覆盖与坏包    ✓");
console.log("场景九 toStringList  ✓");
console.log("专家包测试通过");
