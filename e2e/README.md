# e2e 脚本（CDP）

这些脚本通过 Chrome DevTools Protocol 在**真实运行的应用**里执行断言，用于验证那些单测覆盖不到的部分（Electron 主进程 IPC、真实模型文件、系统终端/文件管理器）。

## 跑法

```bash
# 1) 带调试端口启动应用（注意：若 shell 里有 ELECTRON_RUN_AS_NODE，需先 unset）
env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9222

# 2) 另开一个终端执行步骤脚本
LM_MODELS_DIR=~/.lmstudio/models node e2e/cdp-eval.js e2e/step2-scan.js
```

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `LM_MODELS_DIR` | `~/models` | 步骤脚本要扫描的模型目录（**不要**把个人路径写进脚本里） |
| `LM_SLOTS_DIR` | `~/llama-slots` | 会话存盘目录（存盘/右键相关脚本用） |
| `LM_MODEL_MATCH` | （空 = 取列表第一个） | 选哪个模型：按路径子串匹配。判决/视觉模型不适合当聊天冒烟对象时用它指定 |

`cdp-eval.js` 会先注入 `MODELS_DIR` / `SLOTS_DIR` / `MODEL_MATCH` 三个常量，步骤脚本直接用即可（`~` 会被展开成当前用户主目录）。

## 最小冒烟闭环（已验证）

改了参数生成 / IPC / 引擎版本之后，至少跑这一串。注意顺序：`step18` 自己会启动 server，
所以**不要**先跑 `step5`，否则第二次点「启动」会撞上「服务已在运行」。

```bash
# 终端 1：起应用（若 shell 里有 ELECTRON_RUN_AS_NODE 必须先 unset）
env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9222

# 终端 2
export LM_MODELS_DIR=~/.lmstudio/models      # 按需改
export LM_SLOTS_DIR=~/llama-slots
export LM_MODEL_MATCH=ZDTaichu               # 按需改：选一个能做对话的模型

node e2e/cdp-eval.js e2e/step2-scan.js         # 扫描到模型
node e2e/cdp-eval.js e2e/step3-select.js       # 选中（按 LM_MODEL_MATCH）
node e2e/cdp-eval.js e2e/step4-oneclick.js     # 一键配置 + 内存估算
node e2e/cdp-eval.js e2e/step18-slot-setup.js  # 填存盘目录并启动 server
node e2e/cdp-eval.js e2e/step19-slot-flow.js   # 保存 → 清空 → 恢复 → 删除存盘文件
node e2e/cdp-eval.js e2e/step6-chat.js         # 流式对话
node e2e/cdp-eval.js e2e/step7-stop.js         # 停止
```

最近一次实测（Electron 44 / 引擎 build 11706 `f74e2fa6a` / Qwen3.5-9B Q5_K_M）：
扫描 4 个模型 · 一键配置占用 18.71 GB · server「运行中」· 存盘 71ms / 恢复 21ms · 对话 3s · 停止「未运行」。

两个额外的手工检查（脚本覆盖不到）：

- **参数是否真的进了命令行**：在渲染层读 `#cmdPreview`（`step18` 就是这么断言 `--slot-save-path` 的）。
- **窗口状态持久化**：`window.resizeTo(1100,760)` → 关窗 → 重启，尺寸应被记住。
  状态存在 `userData/Local State` 的 `windowStates.<name>`；**硬杀进程（SIGTERM/kill -9）不会落盘**。


## 步骤一览

| 脚本 | 验证内容 |
|---|---|
| `step1-state.js` ~ `step8-cli.js` | 硬件扫描 → 扫描模型 → 选模型 → 一键配置 → 启动/对话/停止 → CLI 模式 |
| `step9-attach.js` | 视觉投影 / 草稿模型的自动配对 |
| `step12-decision.js`、`step15-jev.js` | decision（判决）模型类型与 `/v1/systemone` |
| `step13-mtp.js`、`step14-mtp2.js` | 内置 MTP 投机解码 |
| `step16-ctx-spec.js`、`step17-256k.js` | 上下文档位与投机解码下拉框的能力过滤 |
| `step18-slot-setup.js`、`step19-slot-flow.js` | 会话存盘：保存 / 恢复 / 清空 |
| `step20-pc-sim.js` | 注入「假 Windows 硬件」验证独立显卡双预算规划 |
| `step21-mac-server.js` | macOS 统一内存路径回归（启动服务 → 对话 → 优雅退出） |
| `step22-ctxmenu.js` | 右键菜单：在文件夹中显示 / 打开所在文件夹 / 复制路径 / 异常分支 |
| `step23-bench-ctx.js` | 多上下文基准：深度 0/4K + 重复 1 次，断言表格逐行输出（前置 step2、step3） |
| `step24-engine-caps.js` | Metal 能力徽标：M5 上应显示「神经加速器 ✓」（设 `GGML_METAL_TENSOR_DISABLE=1` 启动时应变红） |
| `step25-bench-compare.js` | M5 加速对照：勾选后跑两遍，断言多出「tensor 加速」列且倍率 > 1（前置 step2、step3） |

脚本只是断言工具，**没有** `expect` 框架：`cdp-eval.js` 会把脚本返回值（JSON）打印出来，人工或 CI 比对关键字段。
