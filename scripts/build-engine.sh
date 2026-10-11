#!/bin/bash
# 重建 llama.cpp 引擎（server + cli + fit-params + bench）。
# 用法: ./scripts/build-engine.sh [llama.cpp 仓库路径]
set -euo pipefail

REPO="${1:-/Users/Ricky/Documents/GitHub/llama.cpp}"

# cmake/ninja 不在默认 PATH 中，从 Strata-Mac venv 取
export PATH="/Users/Ricky/Documents/GitHub/Strata-Mac/.venv/lib/python3.12/site-packages/cmake/data/bin:/Users/Ricky/Documents/GitHub/Strata-Mac/.venv/bin:$PATH"

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
