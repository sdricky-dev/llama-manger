const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('chatText').value = '用一句话介绍你自己';
$('btnChatSend').click();
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < 120000) {
  const msgs = [...$('chatMsgs').querySelectorAll('.msg.assistant')];
  const el = msgs[msgs.length - 1];
  last = el?.textContent || '';
  const done = !$('btnChatSend').disabled && last && !last.includes('💭');
  if (done) break;
  await sleep(1000);
}
return {
  elapsed: Math.round((Date.now() - t0) / 1000) + 's',
  assistantMsg: last.slice(0, 500),
  msgCount: $('chatMsgs').querySelectorAll('.msg').length,
};
