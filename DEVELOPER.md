# Hermes HR Admin 协作开发说明

## 项目结构

```
workspace/
├── electron/              # Electron 主进程（TypeScript）
│   ├── main.ts            # 应用入口、托盘、IPC
│   ├── hermes-manager.ts  # Hermes ACP / 扫码桥接 / 配置写入
│   ├── intent-router.ts   # 业务意图路由（skill/工作流装配）
│   ├── onboarding-manager.ts # 企业信息问答式引导
│   ├── channel-engine/    # 微信/企微/钉钉/飞书连接器（双向桥接）
│   ├── model-router.ts    # 模型测试与模型列表获取
│   ├── storage-manager.ts # 会话/配置/企业画像存储
│   └── ...
├── src/                   # React 渲染进程
├── resources/intents/     # 业务意图清单
├── resources/hermes/      # Hermes 运行时（本源码包不含二进制依赖，见下）
└── workspace/             # Hermes 工作区（AGENTS.md、output/templates/data）
```

## 环境准备

1. Node.js 18+（建议 20+）
2. 项目根目录执行：
   ```bash
   npm install
   ```
3. 开发模式：
   ```bash
   npm run electron:dev
   ```
   只启动渲染进程：
   ```bash
   npm run dev
   ```

## Hermes 运行时准备（本地 AI 内核）

源码包为保持体积，不包含以下二进制目录：
- `resources/hermes/python/`（Python 3.11 embeddable）
- `resources/hermes/git/`（Git for Windows portable）
- `resources/hermes/site-packages/`（pip 安装的 Python 依赖）

需要按 `resources/hermes/setup.py` 和 `resources/hermes/setup_env.bat` 的说明补齐：

1. 下载 `python-3.11.x-embed-amd64.zip`，解压到 `resources/hermes/python/`
2. 编辑 `resources/hermes/python/python311._pth`，取消注释 `import site`
3. 下载 `get-pip.py` 到 `resources/hermes/python/`
4. 运行 `resources/hermes/setup_env.bat`（会把 Hermes 依赖安装到 `resources/hermes/site-packages`）
5. 下载 Git for Windows Portable，将 `git/` 目录放入 `resources/hermes/git/`
   （Hermes 执行 shell 命令依赖内置 Git Bash；也可自行修改 `electron/hermes-manager.ts` 的路径配置）
6. 如果使用微信扫码登录，确认 `resources/hermes/site-packages` 中有 `aiohttp`、`cryptography`

## 渠道接入

四个渠道均由 `electron/channel-engine/` 中的连接器直接收发：
- 微信：iLink Bot API 长轮询
- 企业微信：智能机器人 WebSocket
- 钉钉：Stream 模式官方 SDK
- 飞书：官方 SDK 长连接

接入凭据保存在用户目录（`userData/data/channel_config.json`），不会进入源码包。

## 打包

```bash
npm run electron:build
```

生成 `release/Hermes人事行政智能专家 Setup 1.0.0.exe`。
注意：完整安装包需要 `resources/hermes/python`、`git`、`site-packages` 均已就绪。

## 注意事项

- 不要把 `userData`（激活信息、API Key、渠道凭据、聊天记录）提交进仓库
- `resources/intents/hr-intents.json` 是业务意图配置，可直接增补
- 渠道扫码接口（企微/微信）使用的是平台私有接口，存在变更风险
