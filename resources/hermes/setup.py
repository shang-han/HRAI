# Hermes Agent 本地部署说明

## 目录结构

```
resources/hermes/
├── python/              # Python 嵌入式运行时 (python-3.11.x-embed-amd64)
│   ├── python.exe
│   └── ...
├── git/                 # 内置 Git for Windows / Git Bash（便携）
│   ├── bin/bash.exe
│   └── ...
├── hermes-agent/        # Hermes Agent 源码 (git clone)
│   ├── run_agent.py
│   ├── cli.py
│   └── ...
├── site-packages/       # pip 安装的依赖
└── setup.py             # 本文件
```

## 部署步骤

### 1. 下载 Python 嵌入式运行时

从 https://www.python.org/downloads/ 下载 Windows embeddable package:
- 文件名: `python-3.11.x-embed-amd64.zip`
- 解压到 `resources/hermes/python/`

### 2. 启用 pip

编辑 `python/python311._pth` 文件，取消注释 `import site`

下载 get-pip.py:
```
curl -o python/get-pip.py https://bootstrap.pypa.io/get-pip.py
python/python.exe python/get-pip.py
```

### 3. 安装 Hermes 依赖

```
python/python.exe -m pip install -r hermes-agent/requirements.txt
```

### 4. 配置 Hermes

创建 `.env` 文件配置模型 API Key:
```
OPENAI_API_KEY=sk-xxx
DEEPSEEK_API_KEY=sk-xxx
DASHSCOPE_API_KEY=sk-xxx
```

## 运行方式

Electron 主进程会自动执行:
```
python/python.exe -m hermes_agent.server --port 8000 --host 127.0.0.1
```

健康检查端口: http://127.0.0.1:8000/health
