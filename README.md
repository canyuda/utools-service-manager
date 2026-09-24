# utools-service-manager

uTools 插件：管理指定的 Windows 服务（状态展示 / 启动类型修改 / 启停控制），并支持通过 uTools MCP 让 Claude Code 等 AI Agent 直接操作服务。

- 设计文档：[docs/2026-09-23-ui-design.md](docs/2026-09-23-ui-design.md)（含 MCP 集成章节 §12）
- 设计图：[docs/design-01-main-list.png](docs/design-01-main-list.png) ~ [design-07-alt-variant-c.png](docs/design-07-alt-variant-c.png)（索引见设计文档 §4.5）
- 可交互原型：[prototype/index.html](prototype/index.html)（浏览器直接打开，`?variant=A|B|C` 切换布局，底部浮条或 ←/→ 切换；`?theme=dark`、`?view=add|empty`、`?expand=Redis` 可体验各状态）
- 状态：**编码完成**（Vue 3 + Vite，工程在 [Windows服务/](Windows服务/)，接入步骤见其 README）；构建与只读冒烟已通过，待 uTools 开发者工具真机联调
- 技术底座：uTools 插件（`plugin.json` + `preload.js` + Vue3/Vite，Node 20 / Electron 34 Runtime），服务操作走 `sc.exe` / PowerShell；MCP 工具经 `plugin.json` 的 `tools` 声明 + `utools.registerTool()` 注册
