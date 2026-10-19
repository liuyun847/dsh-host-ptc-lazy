import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildIndex, buildStub, parameterSignature, renderGroupManifest, typeLabel } from '../lib/manifest.js'
import { resolveConfig } from '../lib/config.js'
import { replaceSdkSection } from '../lib/index.js'

const groups = [
  { name: 'cua', prefix: 'cua_driver_native__', skill: 'computer-control', entryName: 'load_cua_tools' },
  { name: 'godot', prefix: 'mcp__godot_use__', skill: null, entryName: 'load_godot_tools' },
]

test('stub 逐字恒定：同一份配置渲染两次完全一致', () => {
  assert.equal(buildStub(groups), buildStub(groups))
})

test('stub 点名每个加载器与技能', () => {
  const stub = buildStub(groups)
  assert.match(stub, /tools\.load_cua_tools/)
  assert.match(stub, /tools\.load_godot_tools/)
  assert.match(stub, /computer-control/)
  // 没有配技能的组不写出空技能名
  assert.doesNotMatch(stub, /技能 null/)
})

test('typeLabel 覆盖标量 / 枚举 / 数组 / 对象', () => {
  assert.equal(typeLabel({ type: 'number' }), 'number')
  assert.equal(typeLabel({ enum: ['left', 'right'] }), '"left" | "right"')
  assert.equal(typeLabel({ type: 'array', items: { type: 'string' } }), 'string[]')
  assert.equal(typeLabel({ type: 'object', properties: { a: { type: 'number' } } }), '{ a: number }')
  assert.equal(typeLabel(undefined), 'any')
})

test('parameterSignature 标出必填与可选', () => {
  const signature = parameterSignature({
    type: 'object',
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      button: { enum: ['left', 'right'] },
    },
    required: ['x', 'y'],
  })
  assert.equal(signature, '(x: number, y: number, button?: "left" | "right")')
})

test('清单按工具逐行输出，并带上截断后的单行描述', () => {
  const text = renderGroupManifest(groups[0], [
    {
      name: 'cua_driver_native__click',
      description: '在屏幕坐标处点击。\n\n第二段不该按原样出现。',
      parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    },
    {
      name: 'cua_driver_native__screenshot',
      description: '截图',
      parameters: { type: 'object', properties: {} },
    },
  ])
  assert.match(text, /共 2 个/)
  assert.match(text, /- cua_driver_native__click\(x: number\) — 在屏幕坐标处点击。/)
  assert.match(text, /- cua_driver_native__screenshot\(\) — 截图/)
  assert.doesNotMatch(text, /\n\n第二段/)
})

test('配置缺省时给出 cua / godot 两组', () => {
  const resolved = resolveConfig(undefined)
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.groups.map((group) => group.entryName), ['load_cua_tools', 'load_godot_tools'])
})

test('配置非法只返回原因，不抛错', () => {
  assert.equal(resolveConfig({ groups: [] }).ok, false)
  assert.equal(resolveConfig({ groups: [{ name: 'cua' }] }).ok, false)
  assert.equal(resolveConfig({ groups: [{ name: 'cua', prefix: 'x' }, { name: 'cua', prefix: 'y' }] }).ok, false)
  const entryClash = resolveConfig({ groups: [{ name: 'cua', prefix: 'load_cua' }] })
  assert.equal(entryClash.ok, false)
})

test('装配水线只替换 tools:sdk 段，其它段与字段原样保留', () => {
  const assembly = {
    sections: [
      { name: 'harness-identity', order: -1000, text: 'IDENTITY' },
      { name: 'tools:sdk', order: 5000, interpolate: false, text: 'declare const tools: { ... }' },
      { name: 'environment', order: 10000, text: 'ENV' },
    ],
    tools: [],
  }
  const replaced = replaceSdkSection(assembly, 'STUB')
  assert.notEqual(replaced, assembly)
  assert.equal(replaced.sections[0], assembly.sections[0])
  assert.equal(replaced.sections[2], assembly.sections[2])
  assert.deepEqual(replaced.sections[1], { name: 'tools:sdk', order: 5000, interpolate: false, text: 'STUB' })
  // 输入不被修改
  assert.equal(assembly.sections[1].text, 'declare const tools: { ... }')
})

test('没有 SDK 段或已是 stub 时返回同一引用（水线幂等前提）', () => {
  const without = { sections: [{ name: 'environment', order: 10000, text: 'ENV' }] }
  assert.equal(replaceSdkSection(without, 'STUB'), without)
  const already = { sections: [{ name: 'tools:sdk', order: 5000, text: 'STUB' }] }
  assert.equal(replaceSdkSection(already, 'STUB'), already)
  assert.equal(replaceSdkSection(undefined, 'STUB'), undefined)
})

test('核心索引保留非组工具的签名，组工具只报数量', () => {
  const schemas = [
    { name: 'pwsh', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    { name: 'read', parameters: { type: 'object', properties: {} } },
    { name: 'load_cua_tools', parameters: { type: 'object', properties: {} } },
    { name: 'load_godot_tools', parameters: { type: 'object', properties: {} } },
    { name: 'cua_driver_native__click', description: 'click', parameters: { type: 'object', properties: {} } },
    { name: 'cua_driver_native__zoom', parameters: { type: 'object', properties: {} } },
    { name: 'mcp__godot_use__run', parameters: { type: 'object', properties: {} } },
  ]
  const text = buildIndex(groups, schemas)
  // 核心工具：名字 + 参数签名 + 说明，都在
  assert.match(text, /## 核心工具（2 个）/)
  assert.match(text, /- pwsh\(command: string\) — Run a shell command\./)
  assert.match(text, /- read\(\)/)
  // 组工具与加载器不逐条列出
  assert.doesNotMatch(text, /cua_driver_native__click/)
  assert.doesNotMatch(text, /- load_cua_tools\(\)/)
  // 按组加载：数量对得上
  assert.match(text, /load_cua_tools\(\{\}\)`? —— cua 组（2 个/)
  assert.match(text, /load_godot_tools\(\{\}\)`? —— godot 组（1 个/)
  // 同一输入渲染两次逐字相同
  assert.equal(text, buildIndex(groups, schemas))
})
