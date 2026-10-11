const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const out = {};

// 1) 先产生一段真实上下文（让 slot 有 KV 内容）
$('chatText').value = '请用一句话说明相对论的核心思想。';
$('btnChatSend').click();
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  if (!$('btnChatSend').disabled && ($('chatMsgs').textContent || '').length > 20) break;
  await sleep(1000);
}
out.chatPreview = ($('chatMsgs').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);

// 2) 保存 slot 到磁盘
$('slotId').value = '0';
$('slotFile').value = 'e2e-doc.bin';
$('btnSlotSave').click();
await sleep(4000);
out.afterSave = $('slotStatus').textContent;
out.listAfterSave = $('slotList').textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
out.listItems = [...$('slotList').querySelectorAll('.slot-item')].map(el => ({
  name: el.querySelector('.s-name').textContent,
  meta: el.querySelector('.s-meta').textContent,
}));

// 3) 清空 slot（内存侧）
$('btnSlotErase').click();
await sleep(3000);
out.afterErase = $('slotStatus').textContent;

// 4) 从磁盘恢复
$('btnSlotRestore').click();
await sleep(4000);
out.afterRestore = $('slotStatus').textContent;

// 5) 删除磁盘文件（直接调 IPC，避开 confirm 弹窗）
const r = await window.lm.slots.remove({ dir: '/tmp/lm-slots-e2e', name: 'e2e-doc.bin' });
out.removed = r.removed || null;
$('btnSlotRefresh').click();
await sleep(1500);
out.listAfterDelete = $('slotList').textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
return out;
