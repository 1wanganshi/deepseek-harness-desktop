#!/bin/bash
# DeepSeek Harness Desktop 0.3.0 macOS 安装脚本
# 解压 zip 后，双击此文件即可安装到 /Applications。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="DeepSeek Harness Desktop.app"

if [ ! -d "$DIR/$APP_NAME" ]; then
  echo "未找到 $APP_NAME"
  echo "请把此脚本放在解压后的应用同一目录再运行。"
  read -r -p "按回车退出..." _
  exit 1
fi

DEST="/Applications/$APP_NAME"
if [ -d "$DEST" ]; then
  echo "检测到旧版本，正在移除..."
  rm -rf "$DEST" 2>/dev/null || :
fi

echo "正在安装到 /Applications ..."
if cp -R "$DIR/$APP_NAME" /Applications/ 2>/dev/null; then
  DEST="/Applications/$APP_NAME"
else
  echo "无 /Applications 写入权限，改装到 ~/Applications"
  mkdir -p "$HOME/Applications"
  cp -R "$DIR/$APP_NAME" "$HOME/Applications/"
  DEST="$HOME/Applications/$APP_NAME"
fi

xattr -cr "$DEST" 2>/dev/null || true

echo "安装完成：$DEST"
echo "首次打开如被 Gatekeeper 拦截：系统设置 → 隐私与安全性 → 仍要打开。"
read -r -p "按回车退出..." _
