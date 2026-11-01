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
    const head = `- **${expert.name}**（${expert.id}，${kind}）：${expert.description}`;
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

三条规矩：

1. **大活先确认需求再挑人**。需求没定就把活派下去，等于让人猜。
2. **跨界的部分交给对的人**。自己领域外的活，用 \`expert()\` 取对方再交接，别硬扛。
3. **没有对口的就说缺人**。别假装能办——缺口说出来才有机会补专家。`;
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
 * @returns {object}
 */
export function expertTool(experts) {
  return {
    name: "expert",
    description:
      "取一位专家的完整工作方式（role.md 角色提示词 + 交付物 + 交接对象 + 技能）。用于按需切换身份，别一次把所有人取回来。name 支持 id 或中文名。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "专家 id 或中文名，例如 backend、后端工程师" },
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
        },
        required: ["found"],
      },
      render: (_args, value) => [{ type: "text", text: renderExpertHit(value) }],
    },
    execute(args) {
      const hit = findExpert(experts, args?.name);
      if (hit === undefined) {
        return { found: false, available: experts.map((expert) => expert.id) };
      }
      return {
        found: true,
        id: hit.id,
        name: hit.name,
        kind: hit.kind ?? "worker",
        role: hit.role ?? "",
        skills: hit.skills ?? [],
        handoff: hit.handoff ?? [],
        deliverables: hit.deliverables ?? [],
      };
    },
  };
}
