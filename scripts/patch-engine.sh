#!/bin/bash
# 给 llama.cpp 打上 / 回退「decision 类型别名」补丁。
#
#   背景：部分第三方导出的判决(decision)模型把类型写成 "jev"，
#         而引擎类型表里只有 "openjev"（两者的 systemone 模板与
#         temperature/verbalizer_ids/bias 元数据结构完全一致）。
#         不打补丁时 llama-server / llama-cli 会在加载阶段直接退出：
#         "failed to init decision model: unsupported decision model type: jev"
#
# 用法：
#   ./scripts/patch-engine.sh apply  [llama.cpp 路径]
#   ./scripts/patch-engine.sh revert [llama.cpp 路径]
#   ./scripts/patch-engine.sh status [llama.cpp 路径]
# 默认路径：自动探测 ~/Documents/GitHub/llama.cpp、~/GitHub/llama.cpp、~/llama.cpp
# 打完补丁后需要重建：cmake --build <build 目录> --target llama-server llama-cli
set -euo pipefail

REPO="${2:-}"
if [ -z "$REPO" ]; then
  for cand in "$HOME/Documents/GitHub/llama.cpp" "$HOME/GitHub/llama.cpp" "$HOME/llama.cpp"; do
    if [ -d "$cand/.git" ]; then REPO="$cand"; break; fi
  done
fi
PATCH="$(cd "$(dirname "$0")" && pwd)/patches/decision-type-jev-alias.patch"
ACTION="${1:-status}"

[ -n "$REPO" ] || { echo "没找到 llama.cpp 仓库，请显式传入路径" >&2; exit 1; }
[ -f "$PATCH" ] || { echo "找不到补丁文件: $PATCH" >&2; exit 1; }
[ -d "$REPO/.git" ] || { echo "不是 git 仓库: $REPO" >&2; exit 1; }
cd "$REPO"

case "$ACTION" in
  apply)
    if git apply --reverse --check "$PATCH" 2>/dev/null; then
      echo "补丁已经应用过了（无需重复）"
      exit 0
    fi
    git apply --check "$PATCH"
    git apply "$PATCH"
    echo "✓ 补丁已应用：$REPO"
    echo "  接着重建：cmake --build $REPO/build --target llama-server llama-cli -j 10"
    ;;
  revert)
    if ! git apply --reverse --check "$PATCH" 2>/dev/null; then
      echo "补丁未应用或已手动改过，无需回退" >&2
      exit 1
    fi
    git apply --reverse "$PATCH"
    echo "✓ 补丁已回退（记得重建引擎使改动生效）"
    ;;
  status)
    if git apply --reverse --check "$PATCH" 2>/dev/null; then
      echo "已应用"
    elif git apply --check "$PATCH" 2>/dev/null; then
      echo "未应用"
    else
      echo "无法判定（源码已被其它改动影响）"
    fi
    ;;
  *)
    echo "用法: $0 {apply|revert|status} [llama.cpp 路径]" >&2
    exit 1
    ;;
esac
