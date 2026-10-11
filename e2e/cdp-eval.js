// 用法: node cdp-eval.js <expr-file.js> [timeoutMs]
// 通过 CDP Runtime.evaluate (awaitPromise) 在 LlamaManger 渲染器中执行表达式并打印结果
const fs = require('fs');

(async () => {
  const expr = fs.readFileSync(process.argv[2], 'utf8');
  const timeout = Number(process.argv[3] || 15000);
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find((t) => t.type === 'page' && t.title === 'LlamaManger');
  if (!page) { console.error('no page target'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = id++;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const t0 = Date.now();

  // 把测试用的目录注入到步骤脚本里，避免把个人绝对路径写死在仓库中：
  //   LM_MODELS_DIR=~/.lmstudio/models LM_SLOTS_DIR=~/llama-slots node e2e/cdp-eval.js e2e/step2-scan.js
  // 开头的 ~ 会被展开成当前用户主目录（应用本身也支持 ~，这里展开只是为了显示更直观）。
  const expand = (v, def) => {
    const s = String(v === undefined || v === '' ? def : v);
    return s.startsWith('~') ? require('path').join(require('os').homedir(), s.slice(1)) : s;
  };
  const preamble = `
const MODELS_DIR = ${JSON.stringify(expand(process.env.LM_MODELS_DIR, '~/models'))};
const SLOTS_DIR = ${JSON.stringify(expand(process.env.LM_SLOTS_DIR, '~/llama-slots'))};
`;
  try {
    const res = await send('Runtime.evaluate', {
      expression: `(() => { return (async () => { ${preamble}${expr} })(); })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      console.error('EXCEPTION:', JSON.stringify(res.exceptionDetails.exception, null, 2));
      process.exit(2);
    }
    console.log(JSON.stringify(res.result.value, null, 2));
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(3);
  } finally {
    ws.close();
    process.exit(0);
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(4); });
