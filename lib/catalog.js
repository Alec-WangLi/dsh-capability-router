/**
 * 专家目录：把「有哪些工作方式」放进系统提示，用一个工具按需取详情。
 *
 * 与 v1 的区别是**决定权的位置**：v1 用规则替模型选人（选错就没救），
 * 这里只把目录摆出来，选谁、什么时候换人由模型自己判断，插件只负责
 * 「目录稳定（前缀可缓存）+ 详情按需（不占常驻上下文）」。
 *
 * 两段产物：
 *   catalogText()  常驻、稳定，进系统提示
 *   expertTool()   按需、返回 role.md 全文
 */

/**
 * 渲染进系统提示的专家目录。
 * @param {object[]} experts scanExperts() 的结果
 * @returns {string}
 */
export function catalogText(experts) {
  if (experts.length === 0) return "";
  const blocks = experts.map((expert) => {
    const kind = expert.kind ?? "worker";
    // 入口与收口标在名字后面：目录里七个人看起来一样平，模型就会随手挑一个开工，
    // 而这两个的位置其实有讲究——新活从接单进，交付从审查出。
    const tag = kind === "intake" ? "【入口】" : kind === "reviewer" ? "【收口】" : kind === "scout" ? "【调研】" : "";
    const head = `- **${expert.name}**${tag}（${expert.id}，${kind}）：${expert.description}`;
    const lines = [head];
    const required = (expert.skillDeps ?? []).filter((dep) => dep.required).map((dep) => dep.name);
    const optional = (expert.skillDeps ?? []).filter((dep) => !dep.required).map((dep) => dep.name);
    if (required.length > 0) lines.push(`  主力技能：${required.join("、")}`);
    if (optional.length > 0) lines.push(`  备用技能：${optional.join("、")}`);
    if ((expert.deliverables ?? []).length > 0) lines.push(`  产出：${expert.deliverables.join("、")}`);
    if ((expert.handoff ?? []).length > 0) lines.push(`  常交给：${expert.handoff.join("、")}`);
    return lines.join("\n");
  });

  return `## 可用专家（能力路由）

本机装着这些工作方式。它们是**可选身份**，不是白名单：同一件事需要几种视角时按阶段换人，别把一个角色套到底。

${blocks.join("\n")}

用 \`expert(name)\` 取某位专家的完整工作方式（角色提示词、交付物、交接对象）；id 与中文名都认。

五条规矩：

1. **新活先接单**。新项目、新功能、新交付物——先 \`expert("intake")\` 把需求收敛成 \`REQUIREMENTS.md\` + \`TASKS.md\`，再按卡分派。需求没定就把活派下去，等于让人猜。
2. **接单不是终点**。接完单自己一个人全做了，团队还是只有一个人：按任务卡逐条交给对应领域的专家。
3. **跨界的部分交给对的人**。自己领域外的活，用 \`expert()\` 取对方再交接，别硬扛。
4. **交付先审查**。说「做完了 / 可以用了」之前先 \`expert("review")\` 按验收标准逐条核对。没真跑起来的东西别写「完成」。
5. **没有对口的就说缺人**。别假装能办——缺口说出来才有机会补专家。`;
}

/**
 * 找到专家：id 精确匹配优先，其次中文名，其次大小写不敏感。
 * @param {object[]} experts
 * @param {string} query
 * @returns {object|undefined}
 */
export function findExpert(experts, query) {
  const text = String(query ?? "").trim();
  if (text === "") return undefined;
  const lower = text.toLowerCase();
  return (
    experts.find((expert) => expert.id === text) ??
    experts.find((expert) => expert.name === text) ??
    experts.find((expert) => expert.id.toLowerCase() === lower) ??
    experts.find((expert) => expert.name.toLowerCase() === lower)
  );
}

/**
 * 渲染一次取用的结果。
 * @param {{found: boolean} & Record<string, unknown>} value
 * @returns {string}
 */
export function renderExpertHit(value) {
  if (!value.found) {
    const available = Array.isArray(value.available) && value.available.length > 0 ? value.available.join("、") : "无";
    return `没有这个专家。现有：${available}`;
  }
  const lines = [`# ${value.name}（${value.id}，${value.kind}）`];
  if (typeof value.note === "string" && value.note !== "") lines.push(`\n> ${value.note}`);
  if (value.deliverables?.length > 0) lines.push(`\n该产出：${value.deliverables.join("、")}`);
  if (value.handoff?.length > 0) lines.push(`常交给：${value.handoff.join("、")}`);
  if (value.skills?.length > 0) lines.push(`技能：${value.skills.join("、")}`);
  lines.push(`\n${value.role?.trim() ? value.role.trim() : "（这个专家没有 role.md，只按上面的元信息工作）"}`);
  return lines.join("\n");
}

/**
 * 构造 `expert` 工具定义。
 *
 * 不用 `defineTool`：它是宿主包里的函数，本插件零依赖、也不该在自己在
 * 的目录里解析宿主依赖。这里直接给出宿主 `ctx.tools.register()` 要的形状
 * （parameters 与 output.schema 都是标准 JSON Schema，render 返回内容块）。
 *
 * @param {object[]} experts
 * @param {{onOpen?: (expert: object, exec: unknown, args: object) => ({note?: string}|undefined)}} [options]
 *   `onOpen` 在命中后调用：插件用它推进会话阶段，并拿到一句阶段提醒（提示级闸门）。
 * @returns {object}
 */
export function expertTool(experts, options = {}) {
  return {
    name: "expert",
    description:
      "取一位专家的完整工作方式（role.md 角色提示词 + 交付物 + 交接对象 + 技能）。用于按需切换身份，别一次把所有人取回来。name 支持 id 或中文名。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "专家 id 或中文名，例如 backend、后端工程师" },
        project: {
          type: "string",
          description: "可选：项目根目录的绝对路径。传了就把阶段记在这个项目里（.capability-router/state.json），多个会话接手同一个项目时共用一个阶段。",
        },
        phase: {
          type: "string",
          enum: ["spec", "build", "review", "deliver"],
          description: "可选：显式推进阶段。需求文档交付后传 build，实现完成、交给审查时传 review，审查通过、交付之后传 deliver。只能往前走。",
        },
        level: {
          type: "string",
          enum: ["novice", "pro"],
          description: "可选：用户想听多细。接单第一问就问，问完记下来：novice 讲细节与理由，pro 直接给结论与命令。",
        },
        reopen: {
          type: "boolean",
          description: "已交付的项目要回头改时传 true：阶段从 deliver 退回 build，并在状态里记下 reopenedAt。普通推进不用它——阶段只能往前走，重开是唯一一次后退，且必须显式、留痕。",
        },
        approved: {
          type: "boolean",
          description: "可选：方案是否已被用户确认。只在用户明确点头、或说「直接做」时才传 true——推进阶段不等于用户拍板，不会自动置真。传 false 可撤销。只是提示，不拦截。",
        },
      },
      required: ["name"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          found: { type: "boolean" },
          id: { type: "string" },
          name: { type: "string" },
          kind: { type: "string" },
          role: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          handoff: { type: "array", items: { type: "string" } },
          deliverables: { type: "array", items: { type: "string" } },
          available: { type: "array", items: { type: "string" } },
          note: { type: "string" },
        },
        required: ["found"],
      },
      render: (_args, value) => [{ type: "text", text: renderExpertHit(value) }],
    },
    execute(args, exec) {
      const hit = findExpert(experts, args?.name);
      if (hit === undefined) {
        return { found: false, available: experts.map((expert) => expert.id) };
      }
      let note;
      let addendum;
      try {
        const opened = options.onOpen?.(hit, exec, args ?? {});
        note = opened?.note;
        addendum = opened?.addendum;
      } catch {
        /* 钩子失败不该让取专家这件事失败 */
      }
      return {
        found: true,
        id: hit.id,
        name: hit.name,
        kind: hit.kind ?? "worker",
        // 水平适配段追加在角色提示词末尾：静态部分一个字不改，缓存前缀仍是同一份文本。
        role: addendum === undefined ? (hit.role ?? "") : `${hit.role ?? ""}

---

${addendum}`,
        skills: hit.skills ?? [],
        handoff: hit.handoff ?? [],
        deliverables: hit.deliverables ?? [],
        ...note === undefined ? {} : { note },
      };
    },
  };
}
