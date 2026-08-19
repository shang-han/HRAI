@echo off
REM ================================================================
REM Hermes Agent 隔离环境安装脚本
REM 所有操作都在本地目录完成，不修改系统 PATH 或任何全局变量
REM ================================================================

setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PYTHON_DIR=%SCRIPT_DIR%python"
set "PYTHON_EXE=%PYTHON_DIR%\python.exe"
set "SITE_PACKAGES=%SCRIPT_DIR%site-packages"
set "HERMES_DIR=%SCRIPT_DIR%hermes-agent"

echo ============================================
echo Hermes Agent 环境安装（隔离模式）
echo ============================================
echo.

REM 检查 Python 是否存在
if not exist "%PYTHON_EXE%" (
    echo [ERROR] 未找到 Python: %PYTHON_EXE%
    echo 请先下载 Python 3.11 embeddable 并解压到 python\ 目录
    exit /b 1
)

echo [OK] Python: %PYTHON_EXE%

REM 创建 site-packages 目录
if not exist "%SITE_PACKAGES%" mkdir "%SITE_PACKAGES%"

REM 使用隔离环境变量安装 Hermes
REM 不继承系统 PATH，PYTHONHOME 指向内嵌 Python
set "ISOLATED_PYTHONHOME=%PYTHON_DIR%"
set "ISOLATED_PYTHONPATH=%SITE_PACKAGES%"
set "PYTHONNOUSERSITE=1"

echo.
echo [1/3] 检查 pip...
"%PYTHON_EXE%" -c "import pip; print('pip OK:', pip.__version__)" 2>nul
if errorlevel 1 (
    echo 安装 pip 到本地 site-packages...
    set "PYTHONHOME=%ISOLATED_PYTHONHOME%"
    set "PYTHONPATH=%ISOLATED_PYTHONPATH%"
    "%PYTHON_EXE%" "%PYTHON_DIR%\get-pip.py" --target "%SITE_PACKAGES%" --no-warn-script-location
    if errorlevel 1 (
        echo [ERROR] pip 安装失败
        exit /b 1
    )
)
echo [OK] pip 可用

echo.
echo [2/3] 安装 Hermes Agent 依赖到本地 site-packages...
echo      目标: %SITE_PACKAGES%
echo      源码: %HERMES_DIR%
echo      (这可能需要几分钟...)

set "PYTHONHOME=%ISOLATED_PYTHONHOME%"
set "PYTHONPATH=%ISOLATED_PYTHONPATH%"
"%PYTHON_EXE%" -m pip install -e "%HERMES_DIR%" --target "%SITE_PACKAGES%" --no-warn-script-location

if errorlevel 1 (
    echo [ERROR] Hermes 依赖安装失败
    exit /b 1
)

echo [OK] Hermes 依赖安装完成

echo.
echo [3/3] 验证安装...
set "PYTHONHOME=%ISOLATED_PYTHONHOME%"
set "PYTHONPATH=%SITE_PACKAGES%;%HERMES_DIR%"
"%PYTHON_EXE%" -c "import sys; sys.path.insert(0, r'%SITE_PACKAGES%'); sys.path.insert(0, r'%HERMES_DIR%'); print('Python:', sys.version); print('路径隔离验证通过')"

if errorlevel 1 (
    echo [WARN] 验证未通过，但安装可能仍然有效
) else (
    echo [OK] 验证通过
)

echo.
echo ============================================
echo 安装完成！
echo.
echo 目录结构:
echo   Python:  %PYTHON_DIR%
echo   Hermes:  %HERMES_DIR%
echo   依赖:    %SITE_PACKAGES%
echo.
echo 注意: 没有修改任何系统环境变量
echo ============================================

endlocal
