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

`cdp-eval.js` 会先注入 `MODELS_DIR` / `SLOTS_DIR` 两个常量，步骤脚本直接用即可（`~` 会被展开成当前用户主目录）。

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

脚本只是断言工具，**没有** `expect` 框架：`cdp-eval.js` 会把脚本返回值（JSON）打印出来，人工或 CI 比对关键字段。
