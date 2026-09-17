/**
 * 靜謐森林屋 · LINE 打卡機器人
 * ------------------------------------------------------------------
 * 這支程式做兩件事：
 *   1. 接住 LINE 官方帳號「punch in/out」傳來的打卡動作，寫進 GitHub
 *   2. 讓排班網站讀寫同一份資料（三個人看到同一本帳）
 *
 * 設定值都放在「專案設定 → 指令碼屬性」，不要寫在程式碼裡：
 *   LINE_TOKEN  LINE Messaging API 的 Channel access token
 *   GH_TOKEN    GitHub 的 fine-grained token（只給 forest-shift-clock 的 Contents 讀寫）
 *   GH_REPO     peiyunchiu/forest-shift-clock
 *   GH_PATH     data/records.json
 *   WEB_KEY     網站寫入用的通關密語（自己想一組，網站設定頁要填同一組）
 *   SITE_URL    https://peiyunchiu.github.io/forest-shift-clock/
 *   PHOTO_DIR   （程式自己會填）Google Drive 存打卡照片的資料夾 ID
 *   PHOTO_OPEN  照片要不要開放連結觀看，填 yes 才能在網站上看到（預設 yes）
 */

var P = PropertiesService.getScriptProperties();
var TZ = 'Asia/Taipei';

/* ============================ 進入點 ============================ */

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'bad json' }); }

  // LINE 傳過來的（有 events 這個欄位）
  if (body.events) {
    body.events.forEach(function (ev) {
      try { handleLineEvent(ev); }
      catch (err) { log('LINE 事件出錯: ' + err); }
    });
    return json({ ok: true });
  }

  // 網站傳過來的
  try { return json(handleApi(body)); }
  catch (err) { return json({ ok: false, error: String(err && err.message || err) }); }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'state') return json({ ok: true, state: readState() });
    if (p.action === 'ping') return json({ ok: true, ping: 'pong', now: nowIso() });
    if (p.action === 'diag') return json({ ok: true, diag: diagnose() });
    if (p.action === 'richmenu') {                       // 需要通關密語，避免別人亂重建選單
      if (p.key !== P.getProperty('WEB_KEY')) return json({ ok: false, error: '通關密語不對' });
      return json({ ok: true, result: setupRichMenu() });
    }
    return json({ ok: true, hint: '這是打卡機器人的後端，請從 LINE 或排班網站使用。' });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });   // 出錯要講人話，不要回 HTML
  }
}

/** 設定健檢：哪一項沒設好，一看就知道（不會洩漏鑰匙內容） */
function diagnose() {
  var out = {};
  ['LINE_TOKEN','GH_TOKEN','GH_REPO','GH_PATH','WEB_KEY','SITE_URL'].forEach(function (k) {
    var v = P.getProperty(k);
    out[k] = !v ? '❌ 沒設定'
      : (v === '請貼上' ? '❌ 還是預設文字，沒換成真的'
      : (k === 'LINE_TOKEN' || k === 'GH_TOKEN' ? '✅ 有值（' + v.length + ' 字）' : v));
  });
  try {
    var res = UrlFetchApp.fetch(ghUrl() + '?ref=main', { headers: ghHeaders(), muteHttpExceptions: true });
    out.GitHub = res.getResponseCode() < 300 ? '✅ 讀得到'
      : '❌ HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 120);
  } catch (e) { out.GitHub = '❌ ' + e.message; }
  try {
    var r2 = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: 'Bearer ' + P.getProperty('LINE_TOKEN') }, muteHttpExceptions: true });
    out.LINE = r2.getResponseCode() < 300 ? '✅ token 有效'
      : '❌ HTTP ' + r2.getResponseCode() + ' ' + r2.getContentText().slice(0, 120);
  } catch (e) { out.LINE = '❌ ' + e.message; }
  return out;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================ 網站 API ============================ */

function handleApi(body) {
  if (body.key !== P.getProperty('WEB_KEY')) return { ok: false, error: '通關密語不對' };

  if (body.action === 'state') return { ok: true, state: readState() };

  if (body.action === 'patch') {
    var state = mutate(function (s) {
      (body.patches || []).forEach(function (p) { applyPatch(s, p); });
    }, '網站更新 ' + nowStamp());
    return { ok: true, state: state };
  }

  return { ok: false, error: '不認得的動作：' + body.action };
}

function applyPatch(s, p) {
  if (p.type === 'record') {
    if (p.value === null) delete s.records[p.key]; else s.records[p.key] = p.value;
  } else if (p.type === 'shift') {
    if (p.value === null) delete s.shifts[p.key]; else s.shifts[p.key] = p.value;
  } else if (p.type === 'leave') {
    s.leaves = s.leaves || {};
    if (p.value === null) delete s.leaves[p.key]; else s.leaves[p.key] = p.value;
  } else if (p.type === 'settings') {
    s.settings = p.value;
  } else if (p.type === 'employees') {
    // 保留已經綁好的 LINE 身分，避免網站改名字時把綁定洗掉
    var byId = {};
    (s.employees || []).forEach(function (e) { byId[e.id] = e.lineUserId; });
    s.employees = (p.value || []).map(function (e) {
      if (!e.lineUserId && byId[e.id]) e.lineUserId = byId[e.id];
      return e;
    });
  }
}

/* ============================ LINE ============================ */

function handleLineEvent(ev) {
  var uid = ev.source && ev.source.userId;
  if (!uid) return;

  if (ev.type === 'follow') {
    return replyWhoAreYou(ev.replyToken, '歡迎！先告訴我你是誰，之後按選單就能打卡。');
  }
  if (ev.type === 'message' && ev.message && ev.message.type === 'image') {
    return handlePhoto(ev, uid);
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;

  var text = String(ev.message.text || '').trim();
  var state = readState();
  var me = findByLine(state, uid);

  // 還沒綁定身分
  if (!me) {
    var picked = matchEmployeeByName(state, text.replace(/^我是\s*/, ''));
    if (picked) {
      mutate(function (s) {
        var t = s.employees.filter(function (x) { return x.id === picked.id; })[0];
        if (t) t.lineUserId = uid;
      }, 'LINE 綁定 ' + picked.name);
      return reply(ev.replyToken, '綁定好了，' + picked.name + ' 👍\n之後按下面的選單就能打卡。', menuQuick());
    }
    return replyWhoAreYou(ev.replyToken, '還不知道你是誰，選一個：');
  }

  var ds = today();

  if (/^(上班|上工|開工|start|in)$/i.test(text))  return doPunch(ev.replyToken, me, ds, 'in');
  if (/^(下班|收工|end|out)$/i.test(text))        return doPunch(ev.replyToken, me, ds, 'out');
  if (/^(折備品|折|備品)/.test(text))              return doFold(ev.replyToken, me, ds, text);
  if (/^(今日|今天|狀況)/.test(text))              return reply(ev.replyToken, todayReport(readState(), ds), menuQuick());
  if (/^(時數|帳戶|折抵)/.test(text))              return reply(ev.replyToken, bankReport(readState(), me), menuQuick());
  if (/^(網站|排班|統計)/.test(text))              return reply(ev.replyToken, '排班表、統計、補登都在這裡：\n' + (P.getProperty('SITE_URL') || ''), menuQuick());
  if (/^(改名|換人|重新綁定)/.test(text))          return replyWhoAreYou(ev.replyToken, '要改綁成誰？');

  return reply(ev.replyToken,
    '看得懂這幾個：\n・上班\n・下班\n・折備品（可加時數，例如「折備品 2」）\n・今日\n・時數\n・網站\n\n打完卡直接傳照片，就會自動附到那筆打卡上。',
    menuQuick());
}

function doPunch(token, me, ds, kind) {
  var stamp = nowIso();
  var out = {};
  mutate(function (s) {
    var k = ds + '|' + me.id;
    var r = s.records[k] || { date: ds, emp: me.id, breakMin: 0, useMin: 0, note: '' };
    if (kind === 'in') { out.again = !!r.in; r.in = stamp; }
    else               { out.again = !!r.out; r.out = stamp; }
    s.records[k] = r;
    out.rec = r;
    out.settings = s.settings;
    out.shift = s.shifts[k];
  }, (kind === 'in' ? '上班' : '下班') + ' ' + me.name + ' ' + nowStamp());

  var t = hm(stamp);
  var msg = kind === 'in'
    ? '✅ ' + me.name + ' 上班 ' + t + (out.again ? '（覆蓋原本的上班時間）' : '')
    : '✅ ' + me.name + ' 下班 ' + t + (out.again ? '（覆蓋原本的下班時間）' : '');

  if (kind === 'out' && out.rec.in) {
    var worked = workedMin(out.rec);
    var target = targetMin(out.rec, out.shift, out.settings);
    msg += '\n\n今天實際 ' + hrs(worked) + ' 小時 / 應上班 ' + hrs(target) + ' 小時';
    if (worked > target) msg += '\n加班 ' + hrs(worked - target) + ' 小時 💪';
    else if (worked < target) msg += '\n少了 ' + hrs(target - worked) + ' 小時';
    else msg += '\n剛剛好 👌';
  }
  if (kind === 'in' && !out.rec.out) msg += '\n\n下班記得再按一次「下班」。';

  // 記著「這個人剛打了什麼卡」，接下來 10 分鐘內傳的照片就附到這一筆
  CacheService.getScriptCache().put('pend_' + me.lineUserId,
    JSON.stringify({ kind: kind, ds: ds }), 600);

  msg += '\n\n要拍張照存證嗎？按下面的「📷 拍照」。';
  return reply(token, msg, cameraQuick());
}

function doFold(token, me, ds, text) {
  var m = text.match(/(\d+(?:\.\d+)?)/);        // 「折備品 2」→ 2 小時
  var hoursGiven = m ? parseFloat(m[1]) : null;
  var res = {};
  mutate(function (s) {
    var k = ds + '|' + me.id;
    var r = s.records[k] || { date: ds, emp: me.id, breakMin: 0, useMin: 0, note: '' };
    var credit = s.settings.cut || 1;
    if (hoursGiven !== null) {
      if (hoursGiven <= 0) { r.fold = false; delete r.foldMins; }
      else { r.fold = true; r.foldMins = Math.round(hoursGiven * 60); }
    } else {
      // 沒指定時數：同一天再按一次就是累加一次預設時數
      var cur = r.foldMins != null ? r.foldMins : (r.fold ? Math.round(credit * 60) : 0);
      r.fold = true;
      r.foldMins = cur + Math.round(credit * 60);
    }
    s.records[k] = r;
    res.mins = r.foldMins != null ? r.foldMins : Math.round(credit * 60);
    res.state = s;
  }, '折備品 ' + me.name + ' ' + nowStamp());

  if (res.mins <= 0) return reply(token, '已取消今天的折備品。', menuQuick());
  var left = bankOf(readState(), me.id).left;
  return reply(token,
    '🧺 ' + me.name + ' 今天折備品 ' + hrs(res.mins) + ' 小時已入帳\n目前可抵 ' + hrs(left) + ' 小時',
    menuQuick());
}

/**
 * 收到照片：抓下來存進 Google Drive，掛到剛剛那筆打卡上。
 * 沒有「剛剛那筆」的話，就掛到今天最後一次打卡。
 */
function handlePhoto(ev, uid) {
  var s = readState();
  var me = findByLine(s, uid);
  if (!me) return replyWhoAreYou(ev.replyToken, '先告訴我你是誰，照片才知道要算誰的：');

  var cache = CacheService.getScriptCache();
  var pend = cache.get('pend_' + uid);
  var kind, ds;
  if (pend) {
    var o = JSON.parse(pend); kind = o.kind; ds = o.ds;
  } else {
    ds = today();
    var r0 = s.records[ds + '|' + me.id];
    if (!r0 || !r0.in) return reply(ev.replyToken, '收到照片了，但今天還沒有打卡紀錄。\n先按「上班」或「下班」，再拍照就會自動附上去。', menuQuick());
    kind = r0.out ? 'out' : 'in';
  }

  var fileId;
  try { fileId = savePhotoToDrive(ev.message.id, me.name, ds, kind); }
  catch (err) { return reply(ev.replyToken, '照片存不起來 😣\n' + err.message, menuQuick()); }

  mutate(function (st) {
    var k = ds + '|' + me.id;
    var r = st.records[k] || { date: ds, emp: me.id, breakMin: 0, useMin: 0, note: '' };
    if (kind === 'in') r.inPhoto = 'gd:' + fileId; else r.outPhoto = 'gd:' + fileId;
    st.records[k] = r;
  }, '打卡照片 ' + me.name + ' ' + nowStamp());

  cache.remove('pend_' + uid);
  return reply(ev.replyToken,
    '📸 照片存好了，已經附在' + (kind === 'in' ? '上班' : '下班') + '那筆上。\n網站的「紀錄」頁看得到。',
    menuQuick());
}

function savePhotoToDrive(messageId, empName, ds, kind) {
  var res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content', {
    headers: { Authorization: 'Bearer ' + P.getProperty('LINE_TOKEN') }, muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('跟 LINE 拿照片失敗 ' + res.getResponseCode());

  var blob = res.getBlob().setName(ds + '_' + empName + '_' + (kind === 'in' ? '上班' : '下班') + '.jpg');
  var folder = photoFolder();
  var file = folder.createFile(blob);
  if ((P.getProperty('PHOTO_OPEN') || 'yes') === 'yes') {
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { log('分享設定失敗: ' + e); }
  }
  return file.getId();
}

function photoFolder() {
  var id = P.getProperty('PHOTO_DIR');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 資料夾被刪了就重建 */ } }
  var f = DriveApp.createFolder('森林屋打卡照片');
  P.setProperty('PHOTO_DIR', f.getId());
  return f;
}

function todayReport(s, ds) {
  var lines = ['📋 ' + ds.slice(5).replace('-', '/') + ' 今天的狀況', ''];
  s.employees.forEach(function (e) {
    var k = ds + '|' + e.id, r = s.records[k], sh = s.shifts[k] || {};
    var fm = foldMinOf(r, s.settings);
    var bits = [];
    if (r && r.in && r.out) {
      bits.push(hm(r.in) + '–' + hm(r.out) + '（' + hrs(workedMin(r)) + 'h）');
    } else if (r && r.in) {
      bits.push('上班中，' + hm(r.in) + ' 進場');
    } else if (sh.off) {
      bits.push('休假');
    } else {
      bits.push('還沒打卡');
    }
    if (fm) bits.push('折備品 +' + hrs(fm) + 'h');
    if (r && r.useMin) bits.push('抵用 ' + hrs(r.useMin) + 'h');
    if (r && r.leaveMin) bits.push('請假 ' + hrs(r.leaveMin) + 'h');
    lines.push('・' + e.name + '：' + bits.join('，'));
  });
  return lines.join('\n');
}

function bankReport(s, me) {
  var b = bankOf(s, me.id);
  return '🧮 ' + me.name + ' 的折備品帳戶\n\n'
       + '累積　' + hrs(b.earned) + ' 小時\n'
       + '已抵　' + hrs(b.used) + ' 小時\n'
       + '───────────\n'
       + '可抵　' + hrs(b.left) + ' 小時\n\n'
       + '要抵哪一天到網站操作：\n' + (P.getProperty('SITE_URL') || '');
}

/* ------------------------- LINE 回覆 ------------------------- */

function reply(token, text, quick) {
  var msg = { type: 'text', text: text };
  if (quick) msg.quickReply = quick;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + P.getProperty('LINE_TOKEN') },
    payload: JSON.stringify({ replyToken: token, messages: [msg] }),
    muteHttpExceptions: true
  });
}

function menuQuick() {
  return { items: ['上班', '下班', '折備品', '今日', '時數'].map(function (t) {
    return { type: 'action', action: { type: 'message', label: t, text: t } };
  }) };
}

/** 打完卡用這組：第一顆直接開相機、第二顆從相簿挑 */
function cameraQuick() {
  return { items: [
    { type: 'action', action: { type: 'camera',     label: '📷 拍照' } },
    { type: 'action', action: { type: 'cameraRoll', label: '🖼 從相簿選' } },
    { type: 'action', action: { type: 'message',    label: '不用了', text: '今日' } },
    { type: 'action', action: { type: 'message',    label: '折備品', text: '折備品' } }
  ] };
}

function replyWhoAreYou(token, lead) {
  var s = readState();
  var items = s.employees.slice(0, 12).map(function (e) {
    return { type: 'action', action: { type: 'message', label: e.name, text: '我是 ' + e.name } };
  });
  reply(token, lead, { items: items });
}

function findByLine(s, uid) {
  return (s.employees || []).filter(function (e) { return e.lineUserId === uid; })[0] || null;
}

function matchEmployeeByName(s, name) {
  name = String(name || '').trim();
  if (!name) return null;
  return (s.employees || []).filter(function (e) { return e.name === name; })[0]
      || (s.employees || []).filter(function (e) { return name.indexOf(e.name) >= 0; })[0]
      || null;
}

/* ============================ 工時計算（跟網站同一套規則）============================ */

function workedMin(r) {
  if (!r || !r.in || !r.out) return 0;
  var m = (new Date(r.out) - new Date(r.in)) / 60000;
  if (m < 0) m += 24 * 60;                      // 跨夜
  return Math.max(0, Math.round(m - (r.breakMin || 0)));
}
function targetMin(r, sh, settings) {
  if (sh && sh.off) return 0;
  var used  = Math.max(0, Math.round((r && r.useMin) || 0));
  var leave = Math.max(0, Math.round((r && r.leaveMin) || 0));   // 請假（特休／事假／病假）
  return Math.max(0, (settings.base || 7) * 60 - used - leave);
}
function foldMinOf(r, settings) {
  if (r && r.foldMins != null) return Math.max(0, Math.round(r.foldMins));
  return (r && r.fold) ? Math.round((settings.cut || 1) * 60) : 0;
}
function bankOf(s, empId) {
  var earned = 0, used = 0;
  Object.keys(s.records).forEach(function (k) {
    var r = s.records[k];
    if (r.emp !== empId) return;
    earned += foldMinOf(r, s.settings);
    used += Math.max(0, Math.round(r.useMin || 0));
  });
  // 排班排了折備品、日子也到了，但完全沒有紀錄的日子也要算
  var td = today();
  Object.keys(s.shifts).forEach(function (k) {
    var sh = s.shifts[k], parts = k.split('|');
    if (!sh || !sh.fold || s.records[k]) return;
    if (parts[1] !== empId || parts[0] > td) return;
    earned += Math.round((s.settings.cut || 1) * 60);
  });
  return { earned: earned, used: used, left: earned - used };
}

/* ============================ GitHub 讀寫 ============================ */

function ghUrl() {
  return 'https://api.github.com/repos/' + P.getProperty('GH_REPO')
       + '/contents/' + P.getProperty('GH_PATH');
}
function ghHeaders() {
  return {
    Authorization: 'Bearer ' + P.getProperty('GH_TOKEN'),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function readRaw() {
  var res = UrlFetchApp.fetch(ghUrl() + '?ref=main', { headers: ghHeaders(), muteHttpExceptions: true });
  if (res.getResponseCode() === 404) return { state: blankState(), sha: null };
  if (res.getResponseCode() >= 300) throw new Error('讀 GitHub 失敗 ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  var meta = JSON.parse(res.getContentText());
  var text = Utilities.newBlob(Utilities.base64Decode(meta.content)).getDataAsString('UTF-8');
  var state;
  try { state = JSON.parse(text); } catch (e) { state = blankState(); }
  return { state: normalize(state), sha: meta.sha };
}

function readState() { return readRaw().state; }

/** 讀 → 改 → 寫，遇到有人同時寫入就重試 */
function mutate(fn, message) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new Error('系統忙碌，請再按一次'); }
  try {
    for (var attempt = 0; attempt < 3; attempt++) {
      var cur = readRaw();
      fn(cur.state);
      cur.state.updatedAt = nowIso();
      var payload = {
        message: message || ('更新 ' + nowStamp()),
        content: Utilities.base64Encode(JSON.stringify(cur.state, null, 1), Utilities.Charset.UTF_8),
        branch: 'main'
      };
      if (cur.sha) payload.sha = cur.sha;
      var res = UrlFetchApp.fetch(ghUrl(), {
        method: 'put', contentType: 'application/json',
        headers: ghHeaders(), payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code < 300) return cur.state;
      if (code !== 409 && code !== 422) throw new Error('寫 GitHub 失敗 ' + code + ' ' + res.getContentText().slice(0, 200));
      Utilities.sleep(400);                        // 撞車了，重讀再試
    }
    throw new Error('寫入一直被搶，請再試一次');
  } finally { lock.releaseLock(); }
}

function blankState() {
  return {
    version: 1,
    updatedAt: nowIso(),
    employees: [{ id: 'e1', name: 'Chloe' }, { id: 'e2', name: 'Kobe' }, { id: 'e3', name: '夥伴 A' }],
    settings: { base: 7, cut: 1 },
    shifts: {},
    records: {},
    leaves: {}
  };
}
function normalize(s) {
  s = s || {};
  if (!s.employees || !s.employees.length) s.employees = blankState().employees;
  s.settings = s.settings || { base: 7, cut: 1 };
  if (s.settings.base == null) s.settings.base = 7;
  if (s.settings.cut == null) s.settings.cut = 1;
  s.shifts = s.shifts || {};
  s.records = s.records || {};
  s.leaves = s.leaves || {};
  return s;
}

/* ============================ 小工具 ============================ */

function today()    { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowIso()   { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function nowStamp() { return Utilities.formatDate(new Date(), TZ, 'MM/dd HH:mm'); }
function hm(iso)    { return Utilities.formatDate(new Date(iso), TZ, 'HH:mm'); }
function hrs(min)   { return (min / 60).toFixed(1); }
function log(m)     { console.log(m); }

/* ============================ 一次性設定：建立圖文選單 ============================ */
/**
 * 在編輯器上方選這個函式按「執行」，就會把打卡選單建好並設成預設。
 * 之後要改選單再執行一次就好（舊的會自動換掉）。
 */
function setupRichMenu() {
  var token = P.getProperty('LINE_TOKEN');
  if (!token) throw new Error('請先在「指令碼屬性」填 LINE_TOKEN');
  var site = P.getProperty('SITE_URL') || 'https://peiyunchiu.github.io/forest-shift-clock/';
  var W = 2500, H = 1686, cw = Math.round(W / 3), ch = Math.round(H / 2);
  function area(col, row, action) {
    return { bounds: { x: col * cw, y: row * ch, width: cw, height: ch }, action: action };
  }
  var menu = {
    size: { width: W, height: H },
    selected: true,
    name: '打卡選單',
    chatBarText: '打卡選單',
    areas: [
      area(0, 0, { type: 'message', label: '上班',   text: '上班' }),
      area(1, 0, { type: 'message', label: '下班',   text: '下班' }),
      area(2, 0, { type: 'message', label: '折備品', text: '折備品' }),
      area(0, 1, { type: 'message', label: '今日',   text: '今日' }),
      area(1, 1, { type: 'message', label: '時數',   text: '時數' }),
      area(2, 1, { type: 'uri',     label: '網站',   uri: site })
    ]
  };

  // 舊選單先刪掉，免得越積越多
  var listed = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/list', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (listed.getResponseCode() < 300) {
    (JSON.parse(listed.getContentText()).richmenus || []).forEach(function (m) {
      UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/' + m.richMenuId,
        { method: 'delete', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    });
  }

  var created = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(menu), muteHttpExceptions: true });
  if (created.getResponseCode() >= 300) throw new Error('建立選單失敗：' + created.getContentText());
  var id = JSON.parse(created.getContentText()).richMenuId;

  var img = UrlFetchApp.fetch('https://raw.githubusercontent.com/'
    + P.getProperty('GH_REPO') + '/main/assets/richmenu.png').getBlob();
  var up = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', {
    method: 'post', contentType: 'image/png',
    headers: { Authorization: 'Bearer ' + token },
    payload: img.getBytes(), muteHttpExceptions: true });
  if (up.getResponseCode() >= 300) throw new Error('上傳選單圖片失敗：' + up.getContentText());

  var set = UrlFetchApp.fetch('https://api.line.me/v2/bot/user/all/richmenu/' + id, {
    method: 'post', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (set.getResponseCode() >= 300) throw new Error('設定預設選單失敗：' + set.getContentText());

  console.log('圖文選單建好了 ✅ richMenuId = ' + id);
  return '圖文選單建好了，richMenuId = ' + id;
}

/** 設定檢查：在編輯器執行這個，看看每一項是不是都通 */
function checkSetup() {
  var need = ['LINE_TOKEN', 'GH_TOKEN', 'GH_REPO', 'GH_PATH', 'WEB_KEY'];
  need.forEach(function (k) {
    console.log((P.getProperty(k) ? '✅' : '❌ 還沒填') + '  ' + k);
  });
  try {
    var st = readState();
    console.log('✅ GitHub 讀得到，目前 ' + Object.keys(st.records).length + ' 筆打卡紀錄');
  } catch (e) { console.log('❌ GitHub 讀不到：' + e.message); }
  try {
    var r = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: 'Bearer ' + P.getProperty('LINE_TOKEN') }, muteHttpExceptions: true });
    console.log((r.getResponseCode() < 300 ? '✅ LINE token 有效：' : '❌ LINE token 有問題：') + r.getContentText().slice(0, 150));
  } catch (e) { console.log('❌ LINE 連不上：' + e.message); }
}
