#!/bin/zsh -f
set -eu
cd -- "${0:A:h}"
export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin"
if ! command -v node >/dev/null 2>&1; then
  print -u2 '找不到 Node.js，请使用安装时的 Node.js 运行 node launch.mjs stop。'
  exit 1
fi
exec node launch.mjs stop
