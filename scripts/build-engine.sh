#!/bin/bash
# 重建 llama.cpp 引擎（server + cli + fit-params + bench）。
# 用法: ./scripts/build-engine.sh [llama.cpp 仓库路径]
#   仓库路径默认取 $LLAMA_CPP_DIR，其次 ~/llama.cpp，再其次 ~/Documents/GitHub/llama.cpp。
set -euo pipefail

# 允许用环境变量指定 cmake/ninja 所在目录（例如某个 venv 里装的 cmake）
if [ -n "${LLAMA_CMAKE_BIN:-}" ]; then
  export PATH="$LLAMA_CMAKE_BIN:$PATH"
fi

for d in "$HOME/llama.cpp" "$HOME/Documents/GitHub/llama.cpp"; do
  if [ -z "${1:-}" ] && [ -z "${LLAMA_CPP_DIR:-}" ] && [ -d "$d" ]; then
    DEFAULT_REPO="$d"
    break
  fi
done
REPO="${1:-${LLAMA_CPP_DIR:-${DEFAULT_REPO:-$HOME/llama.cpp}}}"

command -v cmake >/dev/null 2>&1 || {
  echo "缺少 cmake。macOS: brew install cmake ninja；或设 LLAMA_CMAKE_BIN=<cmake 所在目录>" >&2
  exit 1
}
command -v ninja >/dev/null 2>&1 || {
  echo "缺少 ninja。macOS: brew install ninja" >&2
  exit 1
}
[ -d "$REPO" ] || {
  echo "找不到 llama.cpp 仓库：$REPO" >&2
  echo "用法: $0 /path/to/llama.cpp（或用环境变量 LLAMA_CPP_DIR 指定）" >&2
  exit 1
}

cd "$REPO"

echo "==> cmake configure（在既有 build/ 上增量追加 server/UI 目标）"
if ! cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_UI=ON; then
  echo "==> UI 构建失败，回退 UI=OFF"
  cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_UI=OFF
fi

echo "==> ninja build"
ninja -C build llama-cli llama-server llama-fit-params llama-bench

echo "==> 完成"
ls -la build/bin/llama-cli build/bin/llama-server build/bin/llama-fit-params
