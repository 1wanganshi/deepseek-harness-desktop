@echo off
chcp 65001 >nul
title DeepSeek Harness Desktop 安装程序

echo ============================================
echo   DeepSeek Harness Desktop 0.2.25 安装程序
echo ============================================
echo.

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 需要管理员权限，正在提权...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set "SRC=%~dp0"
set "DST=C:\Program Files\DeepSeek Harness Desktop"

echo 安装目录: %DST%
echo.

:: 如果已存在，先卸载旧版本
if exist "%DST%" (
    echo 检测到旧版本，正在卸载...
    rmdir /s /q "%DST%"
    echo 旧版本已卸载。
    echo.
)

:: 复制文件
echo 正在复制文件，请稍候...
xcopy "%SRC%*" "%DST%\" /E /I /Q /Y >nul
if %errorlevel% neq 0 (
    echo 复制文件失败！请检查磁盘空间。
    pause
    exit /b 1
)
echo 文件复制完成。
echo.

:: 创建桌面快捷方式
echo 正在创建快捷方式...
powershell -Command ^
    "$ws = New-Object -ComObject WScript.Shell;" ^
    "$sc = $ws.CreateShortcut('%USERPROFILE%\Desktop\DeepSeek Harness Desktop.lnk');" ^
    "$sc.TargetPath = '%DST%\DeepSeek Harness Desktop.exe';" ^
    "$sc.WorkingDirectory = '%DST%';" ^
    "$sc.IconLocation = '%DST%\DeepSeek Harness Desktop.exe,0';" ^
    "$sc.Save();" ^
    "$smDir = [Environment]::GetFolderPath('StartMenu') + '\Programs';" ^
    "New-Item -ItemType Directory -Path $smDir -Force | Out-Null;" ^
    "$sc2 = $ws.CreateShortcut($smDir + '\DeepSeek Harness Desktop.lnk');" ^
    "$sc2.TargetPath = '%DST%\DeepSeek Harness Desktop.exe';" ^
    "$sc2.WorkingDirectory = '%DST%';" ^
    "$sc2.IconLocation = '%DST%\DeepSeek Harness Desktop.exe,0';" ^
    "$sc2.Save();" ^
    "Write-Host '快捷方式创建完成。'"

:: 创建卸载入口
powershell -Command ^
    "$key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekHarnessDesktop';" ^
    "New-Item -Path $key -Force | Out-Null;" ^
    "Set-ItemProperty -Path $key -Name 'DisplayName' -Value 'DeepSeek Harness Desktop';" ^
    "Set-ItemProperty -Path $key -Name 'DisplayVersion' -Value '0.2.25';" ^
    "Set-ItemProperty -Path $key -Name 'Publisher' -Value 'WangAnshi';" ^
    "Set-ItemProperty -Path $key -Name 'UninstallString' -Value ('cmd /c rmdir /s /q \"' + '%DST%' + '\"');" ^
    "Set-ItemProperty -Path $key -Name 'InstallLocation' -Value '%DST%';" ^
    "Write-Host '卸载入口已创建（控制面板 → 程序和功能）。'"

echo.
echo ============================================
echo   安装完成！
echo ============================================
echo.
echo   桌面快捷方式: DeepSeek Harness Desktop
echo   安装目录: %DST%
echo   首次启动后请在 Web UI 设置中配置模型 Provider
echo.
pause
