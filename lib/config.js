/**
 * 配置解析：把 preset 里的 `groups` 变成可信的组表。
 *
 * 形态与 `dsh-host-tool-layering` 的组表刻意保持一致（name / prefix / skill），
 * 但入口工具名不收配置：本插件一律用 `load_<组名>_tools` —— 名字是 stub 里写给模型看的
 * 固定契约，允许改名只会让两处文字对不上。
 *
 * 失败语义：**只报告、不抛错**。配置写坏时插件整体不生效（不挂影子段、不注册加载器），
 * 会话退回原生 ptc 行为（全量 SDK）—— 那只是多付 token，不会把会话弄坏。
 *
 * @module dsh-host-ptc-lazy/config
 */

/** 缺省两组：与本机 layering 的默认前缀一致。 */
export const DEFAULT_GROUPS = Object.freeze([
  Object.freeze({ name: 'cua', prefix: 'cua_driver_native__', skill: 'computer-control' }),
  Object.freeze({ name: 'godot', prefix: 'mcp__godot_use__', skill: 'godot-use' }),
])

/** 组名允许的形态：入口工具名要拼进 `load_<组名>_tools`，所以限制在 ASCII 标识符字符集。 */
const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/i

/**
 * 解析一条组配置。
 *
 * @param {unknown} raw - 原始配置项。
 * @param {number} index - 下标（仅用于报错）。
 * @returns {{ok: true, group: {name: string, prefix: string, skill: string | null, entryName: string}}
 *   | {ok: false, reason: string}}
 */
function resolveGroup(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `groups[${index}] 必须是对象` }
  }
  const name = raw.name
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return { ok: false, reason: `groups[${index}].name 必须是 ASCII 标识符（字母开头，只含字母/数字/_/-）` }
  }
  const prefix = raw.prefix
  if (typeof prefix !== 'string' || prefix.length === 0) {
    return { ok: false, reason: `groups[${index}](${name}).prefix 必须是非空字符串` }
  }
  const skill = raw.skill
  if (skill !== undefined && skill !== null && (typeof skill !== 'string' || skill.length === 0)) {
    return { ok: false, reason: `groups[${index}](${name}).skill 必须是非空字符串或省略` }
  }
  const entryName = `load_${name}_tools`
  if (entryName.startsWith(prefix)) {
    return { ok: false, reason: `groups[${index}](${name}) 的入口名 ${entryName} 以本组前缀 ${prefix} 开头` }
  }
  return { ok: true, group: { name, prefix, skill: skill === undefined || skill === null ? null : skill, entryName } }
}

/**
 * 解析整份插件配置。
 *
 * @param {unknown} config - preset 行的 `config`。
 * @returns {{ok: true, groups: Array<{name: string, prefix: string, skill: string | null, entryName: string}>}
 *   | {ok: false, reason: string}}
 */
export function resolveConfig(config) {
  if (config === undefined || config === null) config = {}
  if (typeof config !== 'object' || Array.isArray(config)) return { ok: false, reason: 'config 必须是对象' }
  const rawGroups = config.groups === undefined ? DEFAULT_GROUPS : config.groups
  if (!Array.isArray(rawGroups)) return { ok: false, reason: 'config.groups 必须是数组' }
  if (rawGroups.length === 0) return { ok: false, reason: 'config.groups 不能为空数组（没有组就没有可加载的签名）' }

  const groups = []
  const seenNames = new Set()
  const seenEntries = new Set()
  for (const [index, raw] of rawGroups.entries()) {
    const resolved = resolveGroup(raw, index)
    if (!resolved.ok) return resolved
    const { group } = resolved
    if (seenNames.has(group.name)) return { ok: false, reason: `组名 ${group.name} 重复` }
    if (seenEntries.has(group.entryName)) return { ok: false, reason: `入口名 ${group.entryName} 重复` }
    seenNames.add(group.name)
    seenEntries.add(group.entryName)
    groups.push(group)
  }
  return { ok: true, groups }
}
