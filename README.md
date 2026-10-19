# dsh-host-ptc-lazy

给 **ptc 预设**用的宿主插件：把系统提示词里的工具签名（`tools:sdk` 段）换成一段固定 stub，
签名改成模型调用 `load_<组>_tools` 时才注入到**对话尾部**。

> 状态：**已在本机 ptc-lazy 预设上用着（0.2.0）**；只给 ptc / both 呈现模式的会话用，标准会话不需要它。

## 为什么

ptc 会话的 `tools` 字段只有一个 `run_code`，但签名清单整段渲染在系统提示词里：本机实测
`164,023` 字符 ≈ 5.1 万 token，其中第 17.5k 字符之后全是 SDK。每场会话首请求都要为没派上
用场的组付全价。

系统提示词在最前面，不能"用到哪组就把哪组写进去"——那等于每放行一次就作废后面整段历史。
唯一的缓存安全位置是**对话尾部**：已发送的字节一个都不变。

## 机制

1. 插件在 `system-prompt/assemble` 水线上把 `tools:sdk` 段的文本换掉（`replaceSdkSection`）：
   v0.2.0 起是「核心工具索引 + 按组加载」——**不属于任何组的工具仍给出名字与参数签名**，
   否则 `pwsh` / `read` / `subagent` 这些常用工具会跟着一起失明。索引按会话缓存（WeakMap），
   保证同一会话内逐字恒定。⚠ 不能用 `systemPrompt.section()` 遮蔽：同名段从预设作用域注册会与
   全局那一段冲突（"already registered"），实测系统提示词里仍是全量 SDK。
2. 每组注册一个入口工具 `load_<组>_tools`（`tools.register` 落在本预设作用域层，实测不会泄漏
   到别的预设）。
3. 模型在 run_code 里调用它 ⇒ 从注册表现渲染该组签名（`ctx.tools.sdkSchemas(scope)` 按前缀
   过滤），作为一条 user 消息追加到对话尾部（`exec.deferContext`）。

⚠ **挂载方式必须是文件 URL，不能写包名**：预设的行由预设作用域导入，按包名的解析基线不是
本 profile 的 `node_modules`。实测写包名时预设卡片显示「加载失败 / never started」——
入口导入失败时 cordis 根本不建 fiber，audit 只会这么报。插件本身零宿主依赖
（只 import `node:crypto` 与同目录两个纯函数模块），所以文件 URL 是自足的：

```yaml
- id: ptc-lazy-sdk
  # 把 <插件目录> 换成你放本插件的绝对路径；v=N 每次改代码要递增
  name: 'file:///<插件目录>/lib/index.js?v=2'
  config:
    groups:
      - name: cua
        prefix: cua_driver_native__
        skill: computer-control
      - name: godot
        prefix: mcp__godot_use__
        skill: godot-use
```

⚠ **改 `lib/index.js` 后必须递增 `?v=N`**：ESM 按 URL 缓存模块，URL 不变就还是旧代码；配置
一存，预设会重新激活，用新 URL 的模块才会被导入。

省略 `groups` 时用上面两组。组名只允许 ASCII 标识符；入口名固定为 `load_<组名>_tools`。

## 边界

- **只对 ptc/both 呈现模式有意义**：标准会话里签名本来就在 `tools` 字段，由 `dsh-host-tool-layering` 管。
- **与 `dsh-host-tool-layering` 的分工**：layering 只用于标准 / 创造会话；PTC 下**不要**加载它 —— 它会往
  全局层注册 `get_cua` / `get_godot` 两个入口工具，反而出现在本插件渲染的「核心工具」索引里，与
  `load_<组>_tools` 重复。两者职责不重叠。
- **不碰 layering 的放行表**：ptc 下 `run_code` 本来就能调所有工具，没有"摘除"这回事。
- **不保证压缩后自动重注入**：压缩可能吃掉尾部的清单，模型按 stub 的提示重新调用即可。
- 配置非法 / 加载器注册失败 ⇒ 只打 error、不抛错；水线替换失败也只是原样返回装配体 ⇒
  会话回到原生 ptc 行为（全量 SDK，多付 token，但可用）。

## 验证

1. 用 ptc-lazy 预设新建会话，看宿主日志有 `[ptc-lazy-sdk] ... 已挂载`。
2. 会话转录 `request/header` 里 `tools` 只有 `run_code`；`system/message` 的长度应从 ~164k
   字符降到 ~17k 字符。
3. 让模型调一次 `load_cua_tools`，转录里应出现一条 `source.kind = "ptc-mode"` 的 user 消息，
   内容是 `cua 组工具签名` 清单。

## 回滚

删掉预设里 `ptc-lazy-sdk` 那一行（或整个 ptc-lazy 预设）即可；插件本身不在 `bundles` 里，
不挂载就不生效。

---

## 许可

MIT License —— 全文见 [LICENSE](LICENSE)。

Copyright (c) 2026 liuyun847
