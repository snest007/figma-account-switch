# Figma Accounts

Codex 桌面版的本地 Figma 多账号管理插件。界面通过 MCP Apps 提供，支持宿主内嵌应用；未渲染时可在 Codex 内置浏览器中打开完整面板。

当前发布版本为 **0.1.1，macOS 测试版**。需要 Node.js 22+，以及可从插件进程 `PATH` 找到的 `node` 和 `codex`。安装前可在此目录运行 `npm run doctor`，检查运行环境和必要接口；该检查不切换账号或发起 OAuth。

## 安装

本项目的 GitHub 仓库为 [snest007/figma-account-switch](https://github.com/snest007/figma-account-switch)，上传完成后可运行：

```sh
codex plugin marketplace add snest007/figma-account-switch
codex plugin add figma-account-switch@qiang-plugins
```

从 ZIP 安装时，解压并进入包含 `.agents/plugins/marketplace.json` 的发布目录，运行 `codex plugin marketplace add .`，再运行同一条 `codex plugin add` 命令。安装后重启桌面应用，在新聊天中打开面板并授权自己的 Figma 账号。

更新和发布工具的完整说明放在源码仓库根目录的 `README.md`。更新或卸载前先取得新版本源码或 ZIP，完成正在进行的授权和切换、关闭面板，再从新版本插件目录运行 `npm run stop`，停止旧后台服务并保留账号资料。0.1.0 没有停止命令，首次升级请使用 0.1.1 的脚本。新版本源码仓库或发布目录根部也可运行 `node figma-account-switch/scripts/stop-service.mjs`。卸载命令为 `codex plugin remove figma-account-switch@qiang-plugins`。

## 使用

安装后，在新任务里说「打开 Figma 账号管理」。面板提供：

1. 在账号列表顶部添加账号并打开官方 OAuth 授权。
2. 点击“使用此账号”，自动检查授权并切换默认 Figma MCP 连接。
3. 缺少有效授权时进入登录流程，完成后自动继续切换；也可以取消本次授权。
4. 重命名账号、刷新状态与恢复上次切换。

其他账号提供“使用此账号”，身份检查和必要的重新授权由这个流程处理。当前 MCP 连接账号固定置顶，连接正常时隐藏使用按钮，只保留重命名；需要核验或出现错误时显示“检查连接”或“修复连接”。其他账号按内部别名保持稳定顺序；标签“当前 MCP 连接”表示单一启用且没有官方连接冲突的配置状态，已打开任务的实际身份仍需单独验证。首次添加的连接默认停用，点击“使用此账号”完成配置；实际账号仍需在 Codex 新任务中验证。每条连接使用固定内部别名，改显示名称不会覆盖授权。授权期间其他账号暂不可切换；网络或身份检查错误会显示原因，只有明确缺少授权时才自动进入登录。

页面使用轻量按钮、弹窗、提示和账号重排过渡；普通刷新保留账号元素并继续现有动效，支持系统“减少动态效果”设置。

连接配置完成后的绿色消息包含“复制验证指令”操作，不再另行显示重复的橙色验证提示。复制目标绑定该次成功操作的账号；后续连接变化时隐藏过期操作。

也可以从插件目录运行：

```sh
node scripts/panel.mjs --open
```

`node scripts/panel.mjs` 只返回面板地址，供 Codex 的 `open_in_codex` 打开。`--status` 返回状态，不含 OAuth 凭据。

## 生效范围

- **授权已验证**表示本地独立检查通过了 Figma `whoami`，不是当前所有桌面任务都已换号。
- **已配置**表示用户配置已修改，其他自定义账号和官方独立连接已停用。旧任务可能保留原连接、文件及对话上下文，请在新任务中验证目标别名。
- 切换是同一 Codex 主机的全局默认配置。先完成正在使用 Figma 的任务；插件不会自动终止或重启它们。
- 当前官方托管 Figma 插件的登录独立于这些自定义连接。切换时面板会明确列出停用托管工具的影响；可恢复上次启用设置。
- 项目配置或企业策略可能覆盖用户设置。本插件不覆盖组织策略，遇到覆盖会报告问题。
- MCP 内嵌界面要求宿主支持并信任该本地 MCP App。未渲染时，返回的本地浏览器面板提供相同操作。

## 内嵌界面接入

`open_accounts_panel` 声明了 `global` 和 `thread` 两种入口，分别用于宿主全屏应用与聊天旁面板。UI 资源为 `ui://figma-accounts/panel-v2.html`，MIME 为 `text/html;profile=mcp-app`，CSS 和 JavaScript 全部内联。内嵌界面通过 MCP Apps 的 `ui/initialize`、`tools/call` 和通知桥接读取账号、执行按钮操作，不直接请求本地 HTTP API。

界面接收初始化的 `hostContext` 及 `ui/notifications/host-context-changed`，跟随宿主的明暗主题、字体、语义颜色与圆角。全屏使用居中的账号列表，内嵌模式移除外层网页卡片和技术说明。当前连接状态正常时隐藏连接操作，其他账号显示“使用此账号”。

截至 2026-10-28，已验证 Codex App Server 能发现本地 stdio MCP 的 UI 元数据并读取完整资源；协议、桥接、主题更新有隔离测试。**当前 Codex 主窗口中的入口发现与实际内嵌呈现仍待验证**，本地资源读取成功不等于全屏应用已经显示。安装更新后需要宿主重新发现 MCP 工具目录；当前任务可能缓存旧元数据。

官方路径见 [MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui) 和 [应用入口扩展](https://developers.openai.com/plugins/build/extensions)。`.app.json` 用于已注册 App/MCP 的映射，本插件不会虚构注册 ID。

## 模型与数据

固定按钮没有任何模型请求。代码通过 Codex App Server 的配置、OAuth 与 MCP 接口工作；适配器拒绝 `turn/start` 等推理方法，只允许 Figma `whoami` 诊断调用。不会更改 `model_provider`、模型、网关地址或 API Key。

Figma OAuth 与设计数据请求仍发送到 Figma 官方服务。对话中的 AI 推理由用户当前 Codex 提供方处理，本插件不创建模型客户端。

凭据完全由 Codex 管理。插件不读取认证文件、Keychain 或环境中的 API Key。账号标签、验证邮箱、套餐名、头像缓存及切换记录保存在：

```text
~/Library/Application Support/Figma Account Switch/accounts.json
```

本地面板服务使用随机端口、随机会话密钥，绑定 `127.0.0.1`，检查 Host、Origin 和请求密钥。状态文件权限为 `0600`，目录为 `0700`。不要公开分享包含会话密钥的面板 URL。

### 账号头像

Figma MCP 的 `whoami` 当前没有头像字段。用户要求获取头像时，可从已登录的 Figma 账号菜单中读取该邮箱旁显示的真实图片地址，调用 `manage_account` 的 `import_avatar`（`alias`、`email`、`url`）。必须先在页面上核对邮箱与图片的对应关系，不能按昵称猜测。下载仅允许 Figma 官方 `s3-alpha.figma.com/profile/…` 图片，不携带浏览器 Cookie 或 OAuth 凭据。

头像保存在本机，按已验证邮箱绑定；重命名、重新检查和切换账号不会丢失缓存。没有图片或加载失败时显示 Figma 昵称的首字。头像不会随 Figma 资料变化自动同步，再次请求获取头像即可更新。图片是显示资料，账号身份仍以 `whoami` 检查为准。

## 开发和验证

需要 Node.js 22+ 和已配置的 Codex CLI。无第三方运行时依赖，无需安装 npm 包。

```sh
npm run doctor
npm test
node scripts/service.mjs
```

测试涵盖多连接切换与回退、并发配置版本冲突、错误身份、重复身份、网关配置保留、禁止模型推理、本地 API 请求隔离，以及 MCP Apps 入口、资源与宿主主题桥接。测试使用模拟身份，不代表已完成用户两账号的实际授权验证或 Codex 主窗口中的 UI 验收。

OAuth 依赖 Codex 的实验性 App Server API。协议结构最初依据本机 `0.154.0-alpha.6.2` 生成并验证；0.1.1 的开发检查基线更新为 macOS 的 `0.165.0-alpha.1.2`，不保证所有 Codex 版本兼容。环境检查及干净安装验证不会替代真实 OAuth、账号切换和桌面内嵌界面验收。凭据隔离复用 Codex 原生实现；遇到 API 版本变化时应明确报错，不能退回复制 Token 的方式。

## 文件结构

- `src/manager.mjs`：账号状态、配置切换、OAuth 与只读身份验证。
- `src/rpc.mjs`：无模型调用的 Codex 协议适配器。
- `src/http.mjs`：本地面板服务及访问隔离。
- `web/`：真实账号界面与 MCP Apps UI 适配。
- `scripts/mcp.mjs`：插件 MCP 工具与 UI resource。
- `skills/figma-accounts/`：Codex 操作流程。

卸载插件不等于撤销 Figma 授权，也不会自动删除用户自定义 MCP 条目。需要撤销远端授权时，使用 Figma 账号的已授权应用管理。

采用 [MIT 许可证](LICENSE)。
