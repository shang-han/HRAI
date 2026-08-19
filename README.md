# Hermes 人事行政一体化智能专家

面向中小企业的人事+行政一体化 AI 智能助手桌面应用。

## 技术栈

- **桌面框架**: Electron 33
- **前端**: React 18 + TypeScript + Vite 6
- **UI**: Ant Design 5 + Tailwind CSS 3
- **状态管理**: Zustand 5
- **AI 引擎**: Hermes Agent (本地 Python 子进程)
- **模型直连**: DeepSeek / 通义千问 / 通义万相 / Qwen-VL / 可灵
- **文件导出**: docx / exceljs / pptxgenjs
- **打包**: electron-builder (NSIS)

## 开发

```bash
# 安装依赖
npm install

# 启动开发模式
npm run dev

# 构建 Windows 安装包
npm run build
```

## 项目结构

```
workspace/
├── electron/              # Electron 主进程
│   ├── main.ts           # 入口
│   ├── preload.ts        # 预加载脚本 (IPC 桥接)
│   ├── hermes-manager.ts # Hermes 生命周期管理
│   ├── intent-router.ts  # 业务意图路由（导航/关键词 -> skill/工作流装配）
│   ├── storage-manager.ts# 本地文件存储
│   ├── activation-manager.ts # 激活码校验
│   ├── model-router.ts   # 模型路由 + 直连调用
│   ├── file-engine.ts    # 文件导入/导出
│   └── log-manager.ts    # 日志管理
│
├── src/                   # React 渲染进程
│   ├── main.tsx          # React 入口
│   ├── App.tsx           # 根组件
│   ├── store/            # Zustand 状态
│   │   ├── configStore.ts
│   │   └── sessionStore.ts
│   └── components/       # UI 组件
│       ├── Sidebar.tsx
│       ├── ChatArea.tsx
│       ├── InputArea.tsx
│       ├── TopBar.tsx
│       ├── ActivationPage.tsx
│       └── OfflineBar.tsx
│
├── resources/
│   └── hermes/           # Hermes Agent 本地部署
│       ├── python/       # Python 嵌入式运行时
│       ├── git/          # 内置 Git Bash（Git for Windows，便携）
│       ├── hermes-agent/ # Hermes Agent 源码
│       └── setup.py      # 部署说明
│
├── workspace/            # Hermes 默认工作区
└── data/                 # 运行时数据 (自动生成)
    ├── session.json
    ├── system_config.json
    ├── template.json
    └── ...
```

## 核心功能

- ✅ 多会话管理 + 上下文保持
- ✅ 人事/行政三级业务导航 (50+ 功能)
- ✅ 业务意图路由（导航点击/关键词自动匹配 skill、工作流与输出契约，全程记录 intent_log）
- ✅ Hermes 工作区规则（AGENTS.md）+ 内置文档技能自动引导
- ✅ 四类模型配置 (对话/图片/视频/多模态)
- ✅ 模型自动路由 + 手动指定
- ✅ 文件导入 (拖拽/粘贴/上传)
- ✅ 多格式导出 (DOCX/XLSX/PPTX/PNG/TXT/MD)
- ✅ 激活码授权 (一码一机)
- ✅ 渠道接入 (微信/企微/钉钉/飞书，支持扫码自动接入)
  - 企业微信：智能机器人 Bot 模式，扫码自动创建并回填凭据（无需公网）
  - 钉钉：Stream 模式长连接，扫码自动创建机器人
  - 飞书：官方 SDK 长连接，扫码自动创建应用
  - 个人微信：腾讯 iLink Bot（Hermes 内置网关托管）
- ✅ 服务常驻 (关闭窗口仅最小化到系统托盘，需显式确认才停止服务)
- ✅ 渠道双向桥接 (渠道与客户端共享同一会话上下文，客户端可直接替渠道回复)
- ✅ 深色/浅色主题
- ✅ 响应式布局 (PC/平板/手机)
- ✅ 本地数据，隐私安全
