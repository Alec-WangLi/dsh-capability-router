# 安装与排障

适用版本：v0.6.0 · 宿主 DSH Desktop 0.2.1

---

## 一、先认清一件事：源码只有一份

插件不需要复制到多个位置。本机现在这份是「一份源码 + 两级 junction」：

```text
<源码目录>                                        ← 唯一源码（git 仓库）
  ⇐ C:\dev\dsh-capability-router                 ← junction，不含空格的稳定别名
  ⇐ ~/.dsh/profiles/desktop/node_modules/dsh-capability-router   ← profile 安装位
```

`~/.dsh/plugins/` 下**不要**再建副本：运行时根本不扫那个目录（已 grep 全运行时确认）。

---

## 二、正式安装（GUI）

唯一受支持的动作：**DSH → 插件 → 添加插件**，输入源码目录的**绝对路径**（相对路径会被拒：`a local path must be absolute`）。

它走 `dsh-plugin-manager` 的 `reconcile()`，四件事：

1. 把包登记进 profile 的 `package.json` `dependencies` 与 `pnpm-lock.yaml`；
2. 校验包内 patch 能解析；
3. 把包名推进 `dsh.profile.bundles`；
4. 重启后按 bundle 层加载。

手写链接不做登记，插件面板看不见、版本兼容校验也不跑。

带空格的路径 pnpm 11 能吃（`link:C:/Users/…/DSH-capability-router dev` 解析正常）；不想敲长路径就用 `C:\dev\dsh-capability-router` 别名。

### 为什么包必须声明 `dsh.bundle`

不声明会直接被拒：

```text
这个包没有声明组合包，无法作为插件安装：dsh-capability-router declares no dsh.bundle
```

来源是 `dsh-plugin-manager/lib/index.js:1866` 的 `not-a-bundle` 分支；`reconcile()` 在 `:332-341` 要求有 `dsh.bundle.patch` 才把包加进 `dsh.profile.bundles`。

本包已声明：

```json
"dsh": {
  "bundle": { "patch": "cordis.patch.yml" },
  "compatibility": { "dsh": ">=0.2.1-rc.1 <0.3.0", "profiles": ["desktop", "web"] }
}
```

包内 `cordis.patch.yml` 就是加载入口：

```yaml
- insert:
    - id: capability-router
      name: dsh-capability-router
```

### patch 的应用顺序

```text
各 bundle 的 patch  →  profile 的 cordis.patch.yml  →  ~/.dsh/cordis.patch.yml
```

`readProfilePatches` 按这个顺序合并（`dsh-app-boot`）。**所以 profile 自己的 patch 里不要再写同一条 insert**——同一 id 会挂两次，检查点会重复注入。

⚠️ **`insert` 不能省。** 不带 `insert` 的 patch 是「按 id 覆盖已存在条目」；新 id 匹配不到时 `applyEntryPatches` 只输出一条 warn 就跳过，插件静默不加载，日志里也翻不到。

---

## 三、手动兜底（GUI 不可用时）

三步，缺一不可：

1. 建 junction（管理员或开发者模式）：

   ```bash
   cmd //c "mklink /J %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-capability-router C:\dev\dsh-capability-router"
   ```

   在 Git Bash / WSL 的 bash 里直接 `mklink` 会因引号被吞而失败，用 `cmd //c` 或 PowerShell 的 `New-Item -ItemType Junction`。

2. profile 的 `package.json` 里 `dependencies` 加 `"dsh-capability-router": "link:C:/dev/dsh-capability-router"`。

3. profile 的 `cordis.patch.yml` 末尾加那条 `insert`。

这样能跑起来，但插件面板不会认它（没有 lock 登记）。等 GUI 可用时按第二节重装一次，把两处手工痕迹清掉。

---

## 四、验证装对了没有

| 检查 | 命令 | 通过的样子 |
|---|---|---|
| 裸名能解析 | 在 profile 目录 `node -e "require.resolve('dsh-capability-router')"` | 指向源码目录的 `lib/index.js` |
| 自检技能在 | 对话里问「有哪些专家」或 `/capability-router` | 能看到五个专家与当前开关状态 |
| 挂钩在工作 | `config.json` 设 `"debug": true` 后重启 | `trace.jsonl` 有持续新行，`promptId` 非空 |
| 注入在工作 | 发一句领域话（如「登录页的样式乱了」） | 下一轮回答里出现该专家的角色设定 |

---

## 五、诊断

`config.json` 里 `"debug": true`，每次 `pre-step` 往 `trace.jsonl` 追加一行：

```json
{"at":"…","p":1,"d":2,"keys":"kind|messages","pkeys":"messages|turn|step|signal|agent",
 "lastKind":"runtime-context","promptId":"…"}
```

- `p` = `payload.messages` 长度，`d` = `decision.messages` 长度
- `pkeys` = payload 有哪些键，用来确认消息挂在哪
- `promptId` 有值 = 找到了真人消息

文件超 64 KB 自动只留后一半。查完把 `debug` 改回 `false`。

---

## 六、两个实测出来的坑

### 坑 1：改 `lib/` 源码必须重启

改 YAML 会触发配置重载，`apply()` 确实又跑一遍（`trace.jsonl` 里有 `event:"apply"`）。但**重载出来的那个实例，`pre-step` 拿到的 payload 与 decision 里 `messages` 都是空的**：

```json
{"at":"…08:50:22","p":0,"d":0,"keys":"kind|messages","lastKind":null,"promptId":null}
```

事件还在触发（每步一条记录），只是没有消息，`lastUserPrompt()` 找不到用户那句话，于是什么也不注入。重启之后立刻正常。

**结论：改 YAML 用来验证条目挂没挂上；改源码只能重启。**

### 坑 2：`p=0` 不等于没挂钩

`p=0` 是「挂钩在、payload 空」。判断办法是看 `trace.jsonl` 有没有持续新记录：有记录说明 handler 在跑。

---

## 七、卸载

1. 从 profile 的 `cordis.patch.yml` 删掉那条 `insert`（如果当初手写过）；
2. 删 junction：

   ```bash
   cmd /c rmdir "C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-capability-router"
   ```

   不带 `/s` 只删链接，不动源码——别用 `rm -rf`。

3. 重启。

源码目录、`~/.dsh/capability-router/` 下的状态文件都可以留着，不影响任何东西。
