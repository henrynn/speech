# PC Assistant 能力模块

这个目录提供两类能力：

- 作为根目录 Node.js 服务的本地设备控制后端，负责真正执行 Windows 音量读写。
- 作为独立运行的 Azure Voice Live 命令行语音助手，提供实时语音对话和 function calling。

如果你只是在运行仓库根目录的网页控制台，那么这里最关键的是 `volume_windows.py` 这层本地能力；如果你还需要 Azure 实时语音对话，再继续启用 Voice Live 模式。

## 目录结构

- `src/pc_assistant/device/volume_windows.py`：Windows 主音量和静音控制
- `src/pc_assistant/voice_live_assistant.py`：Azure Voice Live 客户端 + function calling
- `src/pc_assistant/config.py`：读取 `.env` 配置
- `scripts/run_assistant.ps1`：启动命令行语音助手

## 使用方式

### 方式一：给根目录 Web 服务提供本地能力

根目录的 `server.js` 会通过 Python 子进程调用：

- `get_master_volume_state()`
- `set_master_volume_level()`
- `set_master_mute()`

这个模式下：

- 不需要 Azure Voice Live endpoint
- 不需要 `az login`
- 不需要安装 `requirements-audio.txt`

只要能正常安装 `requirements.txt`，网页端的音量查询、调节、静音接口就能工作。

### 方式二：独立运行 Azure Voice Live 语音助手

这个模式会连接 Azure AI Voice Live，并把音量控制函数作为工具暴露给模型。

## 前置条件

1. Windows 10/11
2. Python 3.10-3.12，推荐 Python 3.12 x64
3. 使用 Voice Live 模式时，需要 Azure Voice Live 资源和访问权限

## 安装依赖

在 `pc_assistant` 目录下执行：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
pip install -r requirements.txt
```

如果你只需要根目录网页控制台调用本地音量能力，到这里就够了。

如果你还要启用 Voice Live 语音对话，再额外安装音频依赖：

```powershell
pip install -r requirements-audio.txt
```

## Voice Live 配置

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

关键变量：

- `AZURE_VOICELIVE_ENDPOINT`：例如 `https://<resource-name>.services.ai.azure.com/`
- `AZURE_VOICELIVE_MODEL`：默认 `gpt-4o-realtime-preview`
- `AZURE_VOICELIVE_VOICE`：例如 `alloy` 或 Azure voice name
- `ASSISTANT_INSTRUCTIONS`：可选，自定义助手系统提示词

## Voice Live 登录

开发机可直接使用：

```powershell
az login
```

程序通过 `DefaultAzureCredential` 读取 Azure CLI 登录态或其他可用凭据。

## 运行 Voice Live 助手

```powershell
.\scripts\run_assistant.ps1
```

示例指令：

- `把音量调到 30`
- `静音`
- `取消静音`
- `现在音量是多少`

## 与根目录服务的关系

根目录服务启动后会暴露以下接口：

- `GET /api/volume`
- `POST /api/volume`
- `POST /api/mute`

这些接口底层并不是走本地 HTTP 服务，而是由 `server.js` 直接拉起 Python，导入本目录下的 `pc_assistant.device.volume_windows` 并执行对应函数。

## 常见问题（Windows）

### 1) 运行 `*.ps1` 报“在此系统上禁止运行脚本”

如果看到 `PSSecurityException` 或 `UnauthorizedAccess`，说明是 PowerShell 执行策略限制。

临时放行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

长期放行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### 2) `pip install -r requirements-audio.txt` 安装 `pyaudio` 失败

如果报错包含 `Microsoft Visual C++ 14.0 or greater is required`，通常说明当前 Python 版本缺少可直接安装的 `pyaudio` wheel，`pip` 退回到了源码编译。

推荐方案：

1. 安装 Python 3.12 x64
2. 重新创建虚拟环境
3. 重新安装依赖

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
pip install -r requirements.txt
pip install -r requirements-audio.txt
```

可选方案是安装 Visual C++ Build Tools 后再编译安装 `pyaudio`。
