#!/bin/zsh -f
set -eu
cd -- "${0:A:h}"
export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin"
if ! command -v node >/dev/null 2>&1; then
  print -u2 '需要 Node.js 24 或更新版本。安装后重新运行此入口。'
  exit 1
fi
exec node launch.mjs start
