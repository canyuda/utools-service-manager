# Windows 服务管理（uTools 插件工程）

管理指定的 Windows 服务：实时状态（2s 轮询）、启动/停止/暂停/恢复/重启、启动类型修改（自动/自动延迟/手动/禁用），并通过 uTools MCP 让 Claude Code 等 AI Agent 直接操作服务。设计文档见上级 [docs/2026-09-23-ui-design.md](../docs/2026-09-23-ui-design.md)。

## 目录结构

```
Windows服务/
├─ public/
│  ├─ plugin.json        # 插件清单（features + MCP tools 声明）→ 构建后拷进 dist/
│  ├─ preload/services.js# 预加载脚本（纯 CJS，不参与构建）：服务控制层 + registerTool
│  └─ logo.png
├─ src/                  # Vue 3 界面（App.vue + components/）
├─ dist/                 # 构建产物 = uTools 插件根目录（开发者工具指向这里）
├─ .utools.local.json    # 应用ID + 密钥（已被 .gitignore 的 *.local 排除，勿提交）
└─ vite.config.js
```

## 开发与调试

```bash
npm install        # 首次
npm run dev        # HMR 模式：vite dev server（plugin.json development.main 指向 :5173）
npm run build      # 产物模式：构建到 dist/（改动 preload/plugin.json 后必须重新 build）
npm run build:watch  # 产物模式 + 自动重建
```

uTools 侧（一次性）：

1. uTools 内安装/打开 **开发者工具**（插件市场搜"开发者工具"）。
2. 新建项目 → 选择本目录下的 **`dist` 文件夹**（先 `npm run build` 一次）。
3. 填 **应用ID** `z3czabyq` 和 **插件密钥**（见 `.utools.local.json`）。
4. 项目设置里开启 **「退出到后台立即结束运行」**，保证每次进入加载最新代码。
5. uTools 搜索框输入「服务管理」/「svc」进入插件。

- HMR 模式：`npm run dev` 挂着，改 `src/**` 即时热更新（plugin.json 的 `development.main` 生效）。
- 改了 `public/**`（preload、plugin.json）→ 重新 `npm run build`，开发者工具里刷新项目。

## MCP（AI Agent 集成）

1. uTools 设置 → AI 设置 → **MCP 服务** 开启。
2. 插件内 ⚙ 设置 → 开启 **AI Agent 控制（MCP）**；要 Agent 能启停服务再开 **允许 Agent 写操作**（默认关）。
3. 每次工具调用记录在设置页审计列表（最近 50 条）。

Claude Code 侧调用示例（工具经 uTools MCP Server 暴露，无需单独配置）：

```
list_managed_services
restart_service { "name": "nginx" }
set_service_start_type { "name": "Redis", "startType": "disabled" }
```

9 个工具：`list_managed_services` / `search_services` / `get_service_detail` / `start_service` / `stop_service` / `restart_service` / `pause_service` / `resume_service` / `set_service_start_type`。

## 已验证

- `npm run build` 产物完整（dist 含 plugin.json / preload / index.html / logo）。
- 服务查询层本机冒烟通过：`getServicesStatus`（Redis/Consul/nginx 状态与启动类型正确、不存在服务返回 exists:false）、`listAllServices`（310 个）、`isAdmin`（非管理员返回 false，对应顶栏横幅）。
- 未验证（需要 uTools 环境与用户操作）：启停写操作、MCP 工具调用、真机轮询体验。
