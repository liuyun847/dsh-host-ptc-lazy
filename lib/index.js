/**
 * dsh-host-ptc-lazy —— 给「ptc 预设」的签名懒加载。
 *
 * ## 它解决什么
 * ptc 会话里 `tools` 字段只有一个 `run_code`，但工具签名（SDK）整段渲染进系统提示词：
 * 本机实测 **164,023 字符 ≈ 5.1 万 token**，而且第 17.5k 字符之后全是 SDK。每场会话首请求
 * 都要为没派上用场的组付全价。
 *
 * 本插件把那一段换成一个**逐字恒定**的 stub，并把签名改成按需注入：
 * 模型在 run_code 里调用 `load_<组>_tools`，签名作为一条 user 消息追加到**对话尾部**。
 * 尾部注入不改请求前缀 ⇒ 不触发全量缓存失效。
 *
 * ## 两个实现约束（都是实测踩出来的）
 * 1. **不能靠 `systemPrompt.section()` 遮蔽**：同名段从预设作用域注册时与全局那一段冲突
 *    （报"already registered"），实测系统提示词里仍是全量 SDK。改用 `system-prompt/assemble`
 *    水线：拿到已渲染的 `sections` 后把 `tools:sdk` 换掉，整条水线按作用域过滤，只有本预设的
 *    会话会经过这里。
 * 2. **不能按包名挂载**：预设的行由预设作用域导入，按包名的解析基线不是本 profile 的
 *    node_modules（实测停在 "never started" = 入口导入失败、cordis 不建 fiber）。预设行
 *    用文件 URL 指向本文件；本文件因此**零宿主依赖**（只 import `node:crypto` 与同目录纯函数），
 *    工具定义与消息对象都手写。
 *
 * ## 失败语义
 * 配置非法 / 加载器注册失败：只打 error、**不抛错**。水线里替换失败也只是原样返回装配体 ⇒
 * 最坏回到原生 ptc 行为（全量 SDK），多付 token，但会话照常可用。
 *
 * @module dsh-host-ptc-lazy
 */

import { randomUUID } from 'node:crypto'

import { resolveConfig } from './config.js'
import { buildIndex, buildStub, renderGroupManifest } from './manifest.js'

/** 插件名：日志前缀用这个短名。 */
export const name = 'ptc-lazy-sdk'

/** 依赖的系统服务：工具注册表 + 系统提示词注册表。 */
export const inject = ['tools', 'systemPrompt']

/** 版本号：与 README / 日志保持一致。 */
const VERSION = '0.2.0'

/** 入口工具的参数 schema（空对象；注册表要的是已编译的 JSON Schema）。 */
const NO_PARAMETERS = Object.freeze({ type: 'object', properties: {}, additionalProperties: false })

/** 被替换的系统提示词段名（`dsh-tools` 的 `sdkSection` 注册的就是这个名字）。 */
const SDK_SECTION = 'tools:sdk'

/**
 * 造某一组的加载器工具定义。
 *
 * 它只做两件事：从注册表现渲染该组签名、把签名作为一条 user 消息推到对话尾部。
 * **不碰 layering 的放行表**：ptc 下 `run_code` 本来就能调所有工具，不存在"摘除"。
 *
 * @param {object} ctx - 插件所在作用域。
 * @param {{name: string, prefix: string, skill: string | null, entryName: string}} group - 该组配置。
 * @returns {object} 可直接交给 `ctx.tools.register()` 的定义。
 */
function makeLoader(ctx, group) {
  return {
    name: group.entryName,
    description: `Load the ${group.name} tool signatures (${group.prefix}*) into this conversation.`,
    parameters: NO_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string' },
          tools: { type: 'number' },
        },
        required: ['group', 'tools'],
      },
      // 落进会话历史的一行：只报数量，不 dump 清单（清单在紧随其后的那条 user 消息里）。
      render: (_args, value) => [{
        type: 'text',
        text: `已注入 ${value?.tools ?? 0} 个 ${value?.group ?? group.name} 工具签名（见下一条消息）。`,
      }],
    },
    async execute(_args, exec) {
      const scope = exec?.agent
      if (scope === undefined) {
        throw new Error(`${group.entryName} 只能在会话内调用：宿主没有把 exec.agent 交给工具`)
      }
      if (typeof exec.deferContext !== 'function') {
        throw new Error(`${group.entryName} 不可用：exec.deferContext 缺席，本工具无法把签名追加到对话尾部`)
      }
      const schemas = ctx.tools.sdkSchemas(scope)
      const picked = schemas.filter((schema) => typeof schema?.name === 'string' && schema.name.startsWith(group.prefix))
      if (picked.length === 0) {
        throw new Error(`注册表里没有前缀为 ${group.prefix} 的工具（MCP 还没起？）—— 未注入任何签名`)
      }
      exec.deferContext({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: renderGroupManifest(group, picked) }],
        // 复用已登记的消息来源：MessageSourceMap 是封闭联合，'ptc-mode' 是其中一项。
        source: { kind: 'ptc-mode' },
      })
      return { group: group.name, tools: picked.length }
    },
  }
}

/**
 * 把装配体里 `tools:sdk` 段的文本换成 stub。
 *
 * 纯函数：不改输入，没有匹配就返回原引用（水线的幂等前提）；顺序、插值标记等字段原样保留。
 *
 * @param {object} assembly - `system-prompt/assemble` 下游产物。
 * @param {string} stub - 逐字恒定的替换文本。
 * @returns {object} 原装配体，或换过段文本的新装配体。
 */
export function replaceSdkSection(assembly, stub) {
  if (assembly === null || typeof assembly !== 'object' || !Array.isArray(assembly.sections)) return assembly
  let changed = false
  const sections = assembly.sections.map((section) => {
    if (section?.name !== SDK_SECTION || section.text === stub) return section
    changed = true
    return { ...section, text: stub }
  })
  return changed ? { ...assembly, sections } : assembly
}

/**
 * 插件入口。
 *
 * @param {object} ctx - 作用域上下文。
 * @param {unknown} config - 预设行里的 `config`。
 */
export function apply(ctx, config) {
  /** 双写日志：cordis logger + stdout（看门狗只收 stdout，两路都留）。 */
  const log = (fn, message) => {
    const line = `[${name}] ${message}`
    try { ctx.logger?.[fn]?.(line) } catch { /* logger 异常时忽略 */ }
    try {
      if (fn === 'error') console.error(line)
      else if (fn === 'warn') console.warn(line)
      else console.log(line)
    } catch { /* stdout 不可用时静默 */ }
  }

  const resolved = resolveConfig(config)
  if (!resolved.ok) {
    log('error', `配置非法 ⇒ 本预设按原生 ptc 行为运行（全量 SDK，多付 token）：${resolved.reason}`)
    return
  }
  const { groups } = resolved
  const fallbackStub = buildStub(groups)

  /**
   * 每个会话（agent 作用域对象）只算一次索引：同一会话内逐字恒定是硬约束，
   * 注册表中途变化（装插件）也不能让系统提示词悄悄变脸。WeakMap 随作用域回收。
   * @type {WeakMap<object, string>}
   */
  const indexByScope = new WeakMap()

  /** 取该会话的系统提示词替换文本：核心工具索引 + 按组加载。 */
  const textFor = (scope) => {
    if (scope === null || typeof scope !== 'object') return fallbackStub
    const cached = indexByScope.get(scope)
    if (cached !== undefined) return cached
    let text = fallbackStub
    try {
      text = buildIndex(groups, ctx.tools.sdkSchemas(scope))
    } catch (error) {
      log('warn', `核心工具索引渲染失败（${error?.message ?? String(error)}）⇒ 回退成纯 stub`)
    }
    indexByScope.set(scope, text)
    return text
  }

  // ⓪ 签名段替换：走装配水线而不是 `systemPrompt.section()`（理由见模块文档第 1 条）。
  //    监听器注册在预设作用域里，宿主的装配水线按作用域过滤 ⇒ 只有本预设的会话会经过。
  let replaced = 0
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const nextAssembly = replaceSdkSection(assembly, textFor(context?.scope))
    if (nextAssembly !== assembly) replaced += 1
    return nextAssembly
  })

  // ① 每组一个加载器：只在模型真的用到该组时，才把签名付进对话。
  //    `tools.register` 落在本作用域层（实测不会泄漏到别的预设）。
  let registered = 0
  for (const group of groups) {
    try {
      ctx.tools.register(makeLoader(ctx, group))
      registered += 1
    } catch (error) {
      log('error', `加载器 ${group.entryName} 注册失败：${error?.message ?? String(error)}`)
    }
  }

  log('info', `v${VERSION} 已挂载：签名段改由装配水线替换；加载器 `
    + `${groups.map((group) => group.entryName).join('、')}（注册成功 ${registered}/${groups.length}）`)
}
