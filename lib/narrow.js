/**
 * 技能目录收窄。
 *
 * 宿主的 `ctx.skills` 没有「排除某个技能」的接口：目录是由各 provider 交候选、
 * 按 rank → providerOrder → localOrder 排序、同名的先到先得（`dsh-skill/lib/index.js:520`）。
 * 所以收窄只能这么干：对要收起来的技能，交一份**同名候选**、rank 取 -1 压过原 provider，
 * 把 invocation.modelInvocable 置为 false。名字还在，用户仍能 /name 调用。
 *
 * 三个必须守住的点：
 *   1. 不能封锁。模型看不见的技能，用户按名字还得能加载——所以 get() 要回落到原 provider，
 *      做法是临时把本 provider 的 list() 置空再查一次，让原候选重新胜出。
 *   2. 目录是全量替换的，每变一次宿主重发一整条目录消息。所以只在专家真的换了才动。
 *   3. 宿主对重名会打 warn（"ignored because a higher-priority skill already exists"）。
 *      它只在目录缓存失效时才会走排序，所以平时的代价是零，集中在切换专家那一刻。
 *
 * 实机结论（2026-11-01，DSH Desktop 0.2.1）：**只对全局层的技能生效**。
 * provider 会被注册进调用方所在的作用域层（`dsh-skill/lib/index.js:147` registerProvider
 * → `this.layers.effect(this.ctx, …)`），而读目录时按 `[global, ...scope chain]` 合并，
 * 靠后的层覆盖同名条目（`collectFresh`）。本插件挂在 profile 上，只能写全局层，
 * 于是全局层的冒名候选压不过作用域层里的同名技能。
 * 实测：本机 49 个技能里只有 8 个被真正收起（插件自带的 office ×7 与
 * diagnose-windows-sandbox-acl），用户目录下的 29 个纹丝不动。
 * rank: -1 只在同一层内有效，跨层无效——这是机制的天花板，不是参数没调好。
 */

/** provider 名：会在宿主的告警里出现，取成一眼能认出来的。 */
export const NARROW_PROVIDER = "capability-router";

/** 本插件自己的自检技能永远不收。 */
const SELF_SKILL = "capability-router";

/**
 * 造一个收窄器。
 * @param {object} options
 * @param {object} options.skills 宿主的 ctx.skills
 * @param {(message: string) => void} [options.warn]
 */
export function createNarrower({ skills, warn = () => {} }) {
  /** 当前被收起的技能名。 */
  const state = {
    active: false,
    hidden: new Set(),
    suppress: false,
    catalog: [],
    revision: 0,
  };

  /** 读一次完整目录（不含本插件自己的技能），留作冒名候选的模板。 */
  async function refreshCatalog() {
    try {
      const list = await skills.list({});
      if (Array.isArray(list)) {
        state.catalog = list.filter((skill) => skill.name !== SELF_SKILL);
      }
    } catch (error) {
      warn(`读技能目录失败 ${error?.message ?? error}`);
    }
    return state.catalog;
  }

  function shadow(skill) {
    return {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      invocation: { modelInvocable: false, userInvocable: skill.invocation?.userInvocable ?? true },
      source: "capability-router",
      provider: NARROW_PROVIDER,
      rank: -1,
    };
  }

  const provider = {
    name: NARROW_PROVIDER,
    async list() {
      if (state.suppress || !state.active || state.hidden.size === 0) return [];
      const byName = new Map(state.catalog.map((skill) => [skill.name, skill]));
      return [...state.hidden]
        .map((name) => byName.get(name))
        .filter((skill) => skill !== undefined)
        .map(shadow);
    },
    /**
     * 被收起的技能仍要能被 /name 加载。
     * 先把本 provider 的 list 静音、让宿主重算一次目录，此时原 provider 胜出，再取。
     */
    async get(name, options) {
      if (!state.active || !state.hidden.has(name)) return undefined;
      state.suppress = true;
      try {
        skills.invalidateCache?.();
        return await skills.get(name, options);
      } finally {
        state.suppress = false;
      }
    },
  };

  let control;
  try {
    control = skills.registerProvider(() => provider);
  } catch (error) {
    warn(`注册收窄 provider 失败 ${error?.message ?? error}`);
  }

  /**
   * 设定要收起的技能。
   * @param {string[]} names
   * @returns {boolean} 状态是否真的变了（宿主目录要不要重发由调用方决定）
   */
  function setHidden(names) {
    const next = new Set(names.filter((name) => typeof name === "string" && name !== SELF_SKILL));
    const same = next.size === state.hidden.size && [...next].every((name) => state.hidden.has(name));
    if (same) {
      state.active = next.size > 0;
      return false;
    }
    state.hidden = next;
    state.active = next.size > 0;
    state.revision += 1;
    // 宿主的目录是缓存住的，不主动失效的话下一次读到的还是旧目录——收窄会静默不生效。
    try {
      skills.invalidateCache?.();
    } catch (error) {
      warn(`目录失效失败 ${error?.message ?? error}`);
    }
    return true;
  }

  /** 恢复完整目录。 */
  function clear() {
    return setHidden([]);
  }

  return { state, provider, get control() { return control; }, refreshCatalog, setHidden, clear };
}

/**
 * 从目录里算「该收哪些」。
 * @param {object[]} catalog `refreshCatalog()` 的结果
 * @param {{keep: string[], alwaysVisible?: string[]}} options keep = 该专家要用到的技能
 * @returns {string[]}
 */
export function planHidden(catalog, { keep, alwaysVisible = [] }) {
  const keepSet = new Set([...keep, ...alwaysVisible, SELF_SKILL]);
  return catalog.map((skill) => skill.name).filter((name) => !keepSet.has(name));
}
