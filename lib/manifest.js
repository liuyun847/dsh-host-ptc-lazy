/**
 * 纯函数：系统提示词 stub 与「组签名清单」的渲染。
 *
 * 为什么单独成文件：这两段文本是**用户可见的提示词内容**，要能用 `node --test` 直接钉住
 * —— 尤其是 stub：它必须逐字恒定（同一个配置永远渲染出同一串字节），否则每次装配都等于
 * 改系统提示词，缓存立刻作废，本插件就没有存在意义了。
 *
 * @module dsh-host-ptc-lazy/manifest
 */

/** 单条工具说明截断长度（字符）：签名才是主体，描述只留一句便于识别。 */
export const DESCRIPTION_LIMIT = 140

/** 单个参数签名截断长度（字符）：防止把整棵 schema 摊进清单。 */
const SIGNATURE_LIMIT = 400

/**
 * 把 JSON Schema 折成一行人读的类型标签。
 *
 * 只处理本机工具定义里实际出现的形态（enum / anyOf / array / object / 标量）；
 * 认不出来的按 `any` 处理 —— 清单是**提示**，不是校验器，宁可少写也不能抛错。
 *
 * @param {unknown} schema - 某个属性的 JSON Schema 片段。
 * @returns {string} 类型标签。
 */
export function typeLabel(schema) {
  if (schema === null || typeof schema !== 'object') return 'any'
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((item) => typeLabel(item)).join(' | ')
  if (schema.type === 'array') return `${typeLabel(schema.items)}[]`
  if (schema.type === 'object' || schema.properties !== undefined) {
    const properties = schema.properties ?? {}
    const keys = Object.keys(properties)
    if (keys.length === 0) return '{}'
    const shown = keys.slice(0, 8).map((key) => `${key}: ${typeLabel(properties[key])}`)
    return `{ ${shown.join(', ')}${keys.length > shown.length ? ', …' : ''} }`
  }
  return typeof schema.type === 'string' ? schema.type : 'any'
}

/**
 * 把工具的 `parameters`（JSON Schema 的 object 根）折成 `(a: number, b?: string)`。
 *
 * @param {unknown} parameters - 工具参数 schema。
 * @returns {string} 括号形式的参数签名。
 */
export function parameterSignature(parameters) {
  const properties = parameters?.properties ?? {}
  const required = new Set(Array.isArray(parameters?.required) ? parameters.required : [])
  const parts = Object.entries(properties).map(([name, schema]) => {
    return `${name}${required.has(name) ? '' : '?'}: ${typeLabel(schema)}`
  })
  const joined = `(${parts.join(', ')})`
  return joined.length <= SIGNATURE_LIMIT ? joined : `${joined.slice(0, SIGNATURE_LIMIT - 1)}…)`
}

/**
 * 压成单行并截断：工具 description 里常有多段 Markdown，清单里只要第一眼能认出的那句。
 *
 * @param {unknown} text - 原始描述。
 * @param {number} [limit] - 截断长度。
 * @returns {string} 单行描述。
 */
export function oneLine(text, limit = DESCRIPTION_LIMIT) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * 渲染系统提示词里的 stub —— **必须逐字恒定**。
 *
 * 内容只依赖配置（组名 / 前缀 / 技能），不依赖会话状态；这正是它安全的前提：
 * 同一个会话从第一轮到最后一轮拿到的是同一串字节。
 *
 * @param {Array<{name: string, prefix: string, skill: string | null, entryName: string}>} groups
 *   已解析的组配置。
 * @returns {string} 段文本。
 */
export function buildStub(groups) {
  const lines = [
    '# 工具签名按需加载',
    '',
    '`run_code` 是本会话唯一可以直接调用的工具；直接调用其它工具会得到 UNKNOWN_TOOL。',
    '',
    '各组的工具签名**不在**系统提示词里。第一次用到某组时，在 run_code 里调用对应的加载器，'
      + '签名会作为一条消息追加到对话末尾：',
    '',
  ]
  for (const group of groups) {
    const skill = group.skill === null ? '' : `；完整说明见技能 ${group.skill}`
    lines.push(`- \`await tools.${group.entryName}({})\` —— ${group.name} 组（前缀 ${group.prefix}${skill}）`)
  }
  lines.push('')
  lines.push('压缩之后签名可能被压缩掉，需要时重新调用即可；重复调用没有副作用。')
  return lines.join('\n')
}

/**
 * 渲染某一组的工具清单（注入到对话尾部的那条消息的正文）。
 *
 * 只依赖 `sdkSchemas` 的结果，不读上下文状态 ⇒ 同一组在同一注册表状态下渲染结果恒定。
 *
 * @param {{name: string, prefix: string, skill: string | null}} group - 组配置。
 * @param {Array<{name: string, description?: string, parameters?: unknown}>} schemas
 *   该组工具的 `{ name, description, parameters }`（`ctx.tools.sdkSchemas(scope)` 的子集）。
 * @returns {string} 清单正文。
 */
export function renderGroupManifest(group, schemas) {
  const lines = [
    `# ${group.name} 组工具签名（前缀 ${group.prefix}，共 ${schemas.length} 个）`,
    '',
    '在 run_code 里用 `await tools.<名字>({ ... })` 调用；参数名与类型见每行括号。'
      + (group.skill === null ? '' : `完整用法与注意事项见技能 ${group.skill}。`),
    '',
  ]
  for (const schema of schemas) {
    const description = oneLine(schema.description)
    const signature = parameterSignature(schema.parameters)
    lines.push(`- ${schema.name}${signature}${description === '' ? '' : ` — ${description}`}`)
  }
  return lines.join('\n')
}

/**
 * 渲染系统提示词里的「核心工具索引 + 按组加载」文本（替代整份 SDK 的那一段）。
 *
 * 与 {@link buildStub} 的区别：核心工具（不属于任何组的那些）仍给出名字与参数签名 ——
 * 否则 ptc 会话会把 `pwsh` / `read` / `subagent` 这些常用工具一起"藏掉"，模型连能做什么都不知道。
 * 组的工具只报数量与加载器，签名等模型真的要用时再注入。
 *
 * 逐字恒定：同一份 `schemas`（顺序敏感）与配置渲染结果相同；调用方按会话缓存即可。
 *
 * @param {Array<{name: string, prefix: string, skill: string | null, entryName: string}>} groups - 组配置。
 * @param {Array<{name: string, description?: string, parameters?: unknown}>} schemas
 *   当前作用域全部工具（`ctx.tools.sdkSchemas(scope)`）。
 * @returns {string} 段文本。
 */
export function buildIndex(groups, schemas) {
  const prefixes = groups.map((group) => group.prefix)
  const loaderNames = new Set(groups.map((group) => group.entryName))
  const inGroup = (name) => prefixes.some((prefix) => name.startsWith(prefix))
  const core = schemas.filter((schema) => !loaderNames.has(schema.name) && !inGroup(schema.name))

  const lines = [
    '# 工具签名',
    '',
    '`run_code` 是本会话唯一可以直接调用的工具；下面列出核心工具的签名，其余工具按组加载。',
    '在 run_code 里用 `await tools.<名字>({ ... })` 调用。',
    '',
    `## 核心工具（${core.length} 个）`,
    '',
  ]
  for (const schema of core) {
    const description = oneLine(schema.description)
    lines.push(`- ${schema.name}${parameterSignature(schema.parameters)}${description === '' ? '' : ` — ${description}`}`)
  }
  lines.push('', '## 按组加载（签名不在提示词里，需要时在 run_code 里调用）', '')
  for (const group of groups) {
    const count = schemas.filter((schema) => schema.name.startsWith(group.prefix)).length
    const skill = group.skill === null ? '' : `；完整说明见技能 ${group.skill}`
    lines.push(`- \`await tools.${group.entryName}({})\` —— ${group.name} 组（${count} 个，前缀 ${group.prefix}${skill}）`)
  }
  lines.push('')
  lines.push('压缩之后签名可能被压缩掉，需要时重新调用加载器即可；重复调用没有副作用。')
  return lines.join('\n')
}
