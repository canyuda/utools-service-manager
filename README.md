# utools-service-manager

[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://www.microsoft.com/windows)
[![uTools](https://img.shields.io/badge/uTools-5%2B-4C8BF5)](https://u.tools/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

uTools 插件：管理指定的 Windows 服务——实时状态、启停控制、启动类型修改，并支持通过 **uTools MCP** 让 Claude Code 等 AI Agent 直接操作服务。

把 Redis、Consul、nginx 这类自建服务加入白名单后，不用再打开 `services.msc`，在 uTools 里输入关键词即可管理；也可以直接对 AI Agent 说"重启一下 nginx"、"把 Redis 设为禁用"。

## 功能特性

- **实时状态**：进入插件 / 窗口聚焦 / 操作后自动刷新（sc.exe 轻量查询，无后台定时轮询），状态变化高亮提示；运行中 / 已停止 / 已暂停 / 启停中一目了然
- **服务控制**：启动、停止、暂停、恢复、重新启动（重启 = 停止 → 等待完全停止 → 启动，15 秒超时保护）
- **启动类型**：自动 / 自动（延迟启动）/ 手动 / 禁用，修改前二次确认，禁用为红色高危提示
- **白名单管理**：全量服务搜索（310+ 服务秒级过滤），只管理你关心的
- **权限感知**：非管理员也能用——对关心的服务做一次「管理授权」（UAC 确认）即可完整控制；未授权服务自动降级只读，随时可撤销
- **错误友好化**：错误码全量映射中文（权限不足 / 服务依赖 / 响应超时 / 服务不存在…）
- **审计日志**：所有 AI Agent 工具调用留痕（最近 50 条），设置页可查可清
- **深色模式**：自动跟随 uTools 主题

## 界面预览

实际运行截图（v1.0.3，事件驱动刷新版界面）：

| 主列表 | 展开详情 |
| --- | --- |
| ![主列表](docs/screenshots/01-main-list.png) | ![展开详情](docs/screenshots/02-detail-expanded.png) |
| **添加服务** | **设置（MCP / 授权 / 审计）** |
| ![添加服务](docs/screenshots/03-add-service.png) | ![设置](docs/screenshots/04-settings.png) |

早期设计稿（含深色模式与备选布局）见 `docs/design-*.png`。

## MCP 集成：让 AI Agent 直接管理服务

插件通过 uTools 内置的 MCP Server 暴露 9 个工具，Claude Code / Codex / WorkBuddy 等 Agent 连接后即可调用，**插件窗口没开着也没关系**（uTools 会自动拉起插件）：

| 工具 | 说明 |
| --- | --- |
| `list_managed_services` | 列出白名单服务及实时状态 |
| `search_services` | 按名称/显示名搜索全量服务 |
| `get_service_detail` | 查询单个服务详情 |
| `start_service` / `stop_service` / `restart_service` | 启动 / 停止 / 重启 |
| `pause_service` / `resume_service` | 暂停 / 恢复（仅支持暂停的服务） |
| `set_service_start_type` | 修改启动类型（auto / delayed-auto / demand / disabled） |

Agent 侧调用示例：

```text
mcp__utools__restart_service { "name": "nginx" }
mcp__utools__set_service_start_type { "name": "Redis", "startType": "disabled" }
```

**安全设计（写操作四道闸）**：

1. MCP 总开关默认关闭（插件 ⚙ 设置中开启）；
2. 写操作另需"允许 Agent 写操作"子开关，默认关闭；
3. 写操作要求目标服务已完成一次性「管理授权」，未授权返回明确的中文提示；
4. 每次工具调用写入审计日志（最近 50 条），设置页可查可清。

开启方式：uTools 设置 → AI 设置 → **MCP 服务** → 开启；再在插件 ⚙ 设置中开启 Agent 控制（写操作按需）。

## 上架状态

插件已提交 uTools 插件市场审核（v1.0.5 整改完成待提审），此前四个版本先后被拒，暂未上架，目前可通过 `.upx` 离线安装。

![uTools 开发者中心版本审核记录](docs/review-history.png)

历次审核结果与整改：

| 版本 | 结果 | 拒绝原因 → 整改 |
| --- | --- | --- |
| v1.0.1 | ❌ 拒绝 | 强制管理员身份运行；同步执行 Windows 命令导致卡顿 → 改为按服务一次性「管理授权」（UAC 确认，SDDL 备份可撤销），命令全部异步执行 |
| v1.0.2 | ❌ 拒绝 | 进入插件无任何操作，一段时间后即卡死（2 秒 PowerShell 轮询在慢环境堆积进程）→ 改为事件驱动刷新，静置零轮询、零子进程 |
| v1.0.3 | ❌ 拒绝 | 服务列表中点击添加卡死（全量枚举单点依赖 WMI 冷查询，慢环境最长 30 秒无反馈且失败无提示）→ 改用 `sc.exe` + 注册表枚举（1 秒内），加载慢有提示、失败可重试 |
| v1.0.4 | ❌ 拒绝 | 还是存在卡死情况，连带 uTools 一起卡死（进入插件仍走 PowerShell/WMI 冷查询；每次进入约 30 个同步存储调用阻塞渲染进程、并由 uTools 主进程单点服务；UAC 授权最长 120 秒不可取消）→ 根因级整改见 v1.0.5 |
| v1.0.5 | ⏳ 待提审 | 2026-10-15 卡死根因架构级整改：查询全链路去 WMI（状态 `sc.exe` 热路径约 30ms 秒开，完整信息 `sc qc` + 注册表三命令并行约 120ms 后台补全）；存储全改 `utools.db.promises` 异步单写（进入插件零同步存储调用），审计日志按官方存储规范移至插件本地数据目录；UAC 等待降为 60 秒、悬浮提示且可一键取消；管理员检测进程内缓存 |

## 安装使用

**普通用户**：构建 `.upx` 离线安装包后在 uTools 中安装（插件市场审核被拒，暂未上架，见[上架状态](#上架状态)）。

**开发者（uTools 开发者工具）**：

1. 克隆本仓库，进入 `Windows服务/` 目录：
   ```bash
   npm install
   npm run build        # 产物输出到 dist/
   ```
2. uTools 开发者工具 → 新建项目 → 选择 **`dist` 目录**；
3. 填写应用ID与插件密钥（在 [uTools 开放平台](https://open.u-tools.cn/) 创建应用获取）；
4. 建议开启「退出到后台立即结束运行」；uTools 搜索框输入 `服务管理` / `svc` 进入插件。

日常开发：`npm run dev` 启动 Vite 热更新（`plugin.json` 的 `development.main` 指向 `:5173`，改 `src/**` 即时生效）；改动 `public/**`（preload / plugin.json）后需 `npm run build` 并刷新项目。

> 注意：对服务执行写操作（启动/停止/改启动类型）前需在插件内完成一次「管理授权」（弹出 UAC 确认，可撤销）；以管理员身份运行 uTools 时无需授权。仅查看状态不需要任何授权。

## 工程结构

```
utools-service-manager/
├── docs/                      # 设计文档、界面设计图、uTools API 笔记
├── prototype/                 # 可交互 HTML 原型（浏览器直接打开）
└── Windows服务/               # 插件工程（插件根 = dist/）
    ├── public/
    │   ├── plugin.json        # 插件清单：功能入口 features + MCP tools 声明
    │   └── preload/           # 预加载脚本（纯 CJS）：服务控制层 + registerTool
    ├── src/                   # Vue 3 界面（App / ServiceCard / AddServiceView / SettingsModal）
    └── vite.config.js
```

技术要点：服务查询全链路**零 WMI、零 PowerShell**（仅 UAC 提权启动器一处例外）——状态刷新走 `sc.exe query state= all` 单进程轻量解析（约 30ms），事件驱动（进入插件 / 窗口可见或聚焦 / 操作后短追踪 / 手动刷新），**静置时零子进程、零定时器**（uTools 隐藏时 Chromium 冻结渲染进程定时器，后台轮询会让界面停在过期帧）；完整信息（描述/账户/启动类型）由 `sc query` + `sc qc` + `reg query` 单键三命令并行获取（约 120ms，展开卡片时兜底补全）；添加服务列表走 `sc.exe` + `reg.exe` 注册表遍历（约 0.6 秒）——审核模板机上 PowerShell/WMI 冷查询可慢至 20 秒超时，是 v1.0.2~v1.0.4 三次"卡死"拒绝的共同根源；控制走 `sc.exe`；按服务授权通过 UAC 提权脚本 `sc sdset` 追加当前用户 ACE 并备份原串（等待上限 60 秒、悬浮提示、可一键取消）；持久化走 `utools.db.promises` 异步单写（同步 db/dbStorage 调用会阻塞渲染进程并由 uTools 主进程单点服务，旧版每次进入约 30 个同步调用是 v1.0.4"连带 uTools 卡死"的主要根源），审计日志按官方存储规范落插件本地数据目录 `audit.json`；无 uTools 环境时界面自动降级为浏览器演示模式，便于纯前端开发。

## 文档

- [界面设计文档](docs/2026-09-23-ui-design.md)（含 MCP 集成设计 §12、操作可用性矩阵、错误码映射）
- [uTools API 笔记](docs/2026-09-23-utools-api-notes.md)
- [可交互原型](prototype/index.html)（下载后浏览器打开，`?variant=A|B|C` 切换三种布局方案）

## 许可证

[MIT](./LICENSE)
