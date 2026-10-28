# Figma Accounts

在 Codex 桌面应用中管理多个独立 Figma MCP 账号：添加账号、完成 Figma OAuth、检查身份、切换默认连接及恢复上次设置。按钮操作在本地执行，没有模型请求。

这是 **macOS 测试版**。通过 GitHub 插件源或 ZIP 分发，每位用户在自己的电脑上授权自己的 Figma 账号。

## 环境要求

- macOS，使用本地执行的 Codex 桌面聊天。
- Node.js 22+，`node` 可被插件进程找到；没有第三方运行时依赖。
- Codex CLI，`codex` 可被插件进程找到，并支持 `plugin` 命令及实验性 App Server API。0.1.1 的开发检查基线为 `0.165.0-alpha.1.2`，不保证所有 Codex 版本兼容。
- 能访问 Figma 官方 MCP 和 OAuth 服务。

从仓库源码或解压后的发布目录运行环境检查：

```sh
node figma-account-switch/scripts/doctor.mjs
```

环境检查不执行账号切换或 OAuth。通过检查也不代表已验证真实账号授权或桌面内嵌界面。若宿主报告无法启动，请检查宿主进程的 `PATH`；终端中的 `PATH` 不一定与桌面应用一致。可用 `FIGMA_ACCOUNTS_CODEX` 指定 Codex CLI 可执行路径。

## 从 GitHub 安装

本项目的 GitHub 仓库为 [snest007/figma-account-switch](https://github.com/snest007/figma-account-switch)，上传完成后可运行：

```sh
codex plugin marketplace add snest007/figma-account-switch
codex plugin add figma-account-switch@qiang-plugins
```

安装后重启桌面应用，在新聊天中说「打开 Figma 账号管理」。添加账号并完成 Figma 官方 OAuth，然后点击「使用此账号」。按照成功提示复制验证指令，在新聊天中验证实际身份。

插件界面可能通过 MCP Apps 内嵌显示；宿主未渲染时，会返回供 Codex 内置浏览器打开的本地面板地址。内嵌界面仍有宿主兼容性限制。

## 从 ZIP 安装

解压 `figma-account-switch-0.1.1.zip`，在解压后的目录中运行：

```sh
codex plugin marketplace add .
codex plugin add figma-account-switch@qiang-plugins
```

添加的是包含 `.agents/plugins/marketplace.json` 的发布目录，不是内部的插件子目录。保留该目录，供后续刷新和重装使用。安装后的授权和身份验证步骤与 GitHub 安装相同。

## 更新和卸载

先下载新版本，完成正在进行的授权或切换并关闭面板，然后在新版本的源码仓库或发布目录根部运行：

```sh
node figma-account-switch/scripts/stop-service.mjs
```

也可以在新版本的插件子目录运行 `npm run stop`。0.1.0 没有停止命令，首次升级请使用 0.1.1 的脚本。停止账号面板服务会保留账号资料，升级后再重新打开面板。

GitHub 安装先刷新插件源，再重装插件副本：

```sh
codex plugin marketplace upgrade qiang-plugins
codex plugin remove figma-account-switch@qiang-plugins
codex plugin add figma-account-switch@qiang-plugins
```

ZIP 安装更新时，解压新版本，先删除旧的插件源再添加新目录，然后重装：

```sh
codex plugin remove figma-account-switch@qiang-plugins
codex plugin marketplace remove qiang-plugins
codex plugin marketplace add .
codex plugin add figma-account-switch@qiang-plugins
```

运行 ZIP 更新命令前，进入新版本的发布目录。安装变更后重启桌面应用，并在新聊天中验证。

卸载前也按上述步骤停止账号面板服务，再运行：

```sh
codex plugin remove figma-account-switch@qiang-plugins
```

不再使用此插件源时，还可以运行 `codex plugin marketplace remove qiang-plugins`。卸载不会自动删除自定义 Figma MCP 配置、本机账号资料或撤销 Figma 授权。需要撤销远端授权时，到 Figma 账号的已授权应用管理中处理。

## 切换范围和数据

切换修改同一 Codex 主机的全局默认连接，可能停用其他 Figma 自定义连接及官方托管连接。先完成正在使用 Figma 的任务；旧聊天可能保留原连接和上下文，切换后用新聊天核验。项目配置或企业策略可能覆盖用户设置。

OAuth 凭据由 Codex 管理。插件在 `~/Library/Application Support/Figma Account Switch/` 保存账号标签、已验证身份、头像缓存、切换记录和本地服务信息。面板服务仅绑定 `127.0.0.1`，使用随机端口和随机会话密钥。不要分享包含会话密钥的面板 URL。

GitHub 上传只包含插件代码和发布工具，排除本机 Codex 配置、OAuth 凭据、账号邮箱与头像缓存、Cookie、会话 URL、私钥和调试输出。打包工具会检查实际复制的发布内容；发现 Token、个人邮箱、额外 MCP 认证配置或未审阅文件时停止打包。

每次提交或推送前，在仓库根目录运行：

```sh
node scripts/check-share-safety.mjs
```

检查覆盖 Git 工作区、暂存副本和历史提交，强制加入被忽略的凭证文件也会被拦截。输出只包含文件位置和问题类别，不显示命中的敏感值，不读取本机账号目录或凭据存储。检查失败时先清理对应内容和历史，再重新检查；通过后才上传。

详细功能和实现说明见 [插件 README](figma-account-switch/README.md)。

## 开发与发布

仓库结构保持插件独立，插件源使用相对路径定位它：

```text
.agents/plugins/marketplace.json
figma-account-switch/              # 可安装的插件
scripts/                          # 发布与验证工具
README.md
LICENSE
```

在仓库根目录运行：

```sh
node scripts/package-release.mjs
```

打包工具生成 `output/releases/figma-account-switch-0.1.1.zip`、对应发布目录和 `.zip.sha256` 校验文件。发布包按明确的文件清单收集插件代码、隐藏清单、安装目录、说明和许可证，不包含工作区研究资料、浏览器记录、运行账号数据或 Git 元数据。GitHub 仓库也应只提交项目代码和发布工具；`output/` 中的 ZIP 和校验文件可作为 GitHub Release 附件上传。

发布前在插件目录运行 `npm test` 和 `npm run doctor`，在仓库根目录运行：

```sh
node --test scripts/*.test.mjs
node scripts/verify-release.mjs
```

`verify-release` 在临时目录打包、解压和安装插件，再通过 Codex 实际发现工具、读取 UI 资源并验证独立后台服务。用户的 Codex 配置、账号资料和正在运行的服务保持原样。也可以检查指定发布包并保存不含账号数据的报告：

```sh
node scripts/verify-release.mjs --archive output/releases/figma-account-switch-0.1.1.zip --report output/releases/verification-0.1.1.json
```

0.1.1 已在 macOS、Node.js 24.12.0、Codex CLI 0.165.0-alpha.1.2 上通过上述隔离验证。模拟账号测试与干净安装不能替代另一台电脑的真实 Figma OAuth、实际身份切换或宿主内嵌界面验收。Node.js 22+ 是代码要求；本次实际使用的运行时版本为 24.12.0。

采用 [MIT 许可证](LICENSE)。
