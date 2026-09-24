# uTools 插件开发 API 笔记（已确认事实，勿再抓官方文档）

- 抓取日期：2026-09-23
- 来源：next.u-tools.cn（uTools 5/6 文档，Runtime：Electron 34.5.8 / Chromium 132 / Node 20.19.1）
- ⚠️ 该文档站有风控，**同一页面不要重复请求**；本文未覆盖的内容先问用户，不要连续抓取。

## plugin.json（顶层字段）

| 字段 | 必填 | 说明 |
|---|---|---|
| `main` | 是 | 主界面入口，相对路径 .html（构建后指向 `dist/index.html`） |
| `logo` | 是 | 相对路径图标 |
| `preload` | 否 | 预加载 .js，独立预加载环境，可用 Node.js 原生能力 + Electron 渲染进程 API，向 window 暴露接口 |
| `pluginSetting` | 否 | `{ single: true(默认单例), height: 544(默认高度) }` |
| `features` | 是 | 功能入口数组，最少 1 个 |
| `tools` | 否 | **对象**，键 = MCP 工具名（建议小写 snake_case 且唯一），值 = 工具定义 |
| `development` | 否 | 开发模式配置；`development.main` 可指向 URL，如 `http://127.0.0.1:5173/index.html`（Vite 热更新） |

注意：plugin.json **不含应用ID/密钥**——应用ID 与插件密钥在 uTools 开发者工具/应用开发界面填写，与项目目录关联。

## features[] 元素

`code`（唯一编码，触发时传给插件）、`description`（无 explain 字段）、`icon`、`platform`（"win32"|"darwin"|"linux"）、`mainPush`、`mainHide`、`cmds`（必填，最少 1 项；每功能最多 5 个功能指令，自动支持拼音/首字母；匹配指令为对象形式 type=regex/over/img/files/window）。

## tools 字段（MCP）

```json
"tools": {
  "tool_name": {
    "description": "必填，Agent 靠它决定何时调用，务必准确",
    "inputSchema": { "type": "object", "additionalProperties": false },
    "outputSchema": { "可选" }
  }
}
```
- `inputSchema` 必填且必须为有效 JSON Schema 对象、**不能为 null**；无参数用 `{ "type": "object", "additionalProperties": false }`。
- 插件未运行时，Agent 调用工具会由 uTools **自动拉起插件**完成初始化。
- 用户需在 uTools 设置 → AI 设置 → MCP 服务 中开启，Agent 才能发现/调用。

## registerTool（preload 中调用）

```ts
function registerTool(
  name: string,                                                    // 与 tools 键一致
  handler: (params: Record<string, any>, ctx?: ToolContext) => any | Promise<any>
): void
```
- `params` = Agent 传入的工具入参对象；返回值/Resolve 值 = 工具结果（可序列化 JSON）。
- handler 抛异常 → 工具失败结果。
- 插件初始化时执行（preload 顶层即可）。

## 其他已确认 API

- `utools.dbStorage.getItem/setItem`：键值持久化。
- `utools.onPluginEnter(cb)` / `utools.onPluginOut(cb)`：进入/退出；**退出后插件默认不会立即结束运行**，调试时在开发者工具开启「退出到后台立即结束运行」保证每次加载最新代码。
- `utools.isDarkColors()`：深色模式判断。
- 预加载环境可直接用 `require('child_process')` 等 Node 能力。

## 运行与调试

- 开发者工具指向**包含 plugin.json 的目录**（插件根目录）。
- Vite 热更新：`plugin.json` 加 `development.main` 指向 dev server；`npm run dev` 起 Vite；构建产物模式把 main 指回 `dist/index.html`。
