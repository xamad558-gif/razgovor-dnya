import '@fontsource/noto-naskh-arabic/400.css';
import '@fontsource/noto-naskh-arabic/600.css';
import '@fontsource/noto-naskh-arabic/700.css';
import '@fontsource/pt-sans/400.css';
import '@fontsource/pt-sans/700.css';
import '@fontsource/pt-serif/700.css';
import './styles.css';

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { todayKey, slotAt, lastDays, dayKey } from './domain/dates.js';
import { esc, norm, highlightTaught } from './domain/text.js';
import { addWords, findWord, recordAnswer } from './domain/words.js';
import { createSession, currentCard, flip, answerCard, shuffle, SESSION_SIZES } from './domain/review.js';
import {
  effectiveStreak, markConversationDone, markReviewDone, reviewDone, archiveChat, blankState,
} from './domain/progress.js';
import { TOPICS, TOPIC_IDEAS, topicIndexFor, topicOf } from './domain/topics.js';
import { loadState, saveState, flush } from './storage/store.js';
import { requestAI, aiConfigured, configureAI, AI_ERROR_AR } from './ai/client.js';
import { backendConfigured, aiEndpoint, publishableKey, getAccessToken, setForeground } from './auth/session.js';
import { applyReminders, onReminderTap } from './notifications/reminders.js';
import { speakRussian } from './platform/tts.js';
import { LIMITS } from './shared/ai-contract.js';

const GOAL = LIMITS.turnGoal;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const AR_DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const KIND_AR = { noun: 'اسم', verb: 'فعل', adj: 'صفة', adv: 'ظرف', phrase: 'عبارة' };
const SLOTS = { am: { icon: '☀️', name: 'مراجعة الصباح' }, pm: { icon: '🌙', name: 'مراجعة المساء' } };
const DRAFT_KEY = 'razgovor-draft';
const NATIVE = Capacitor.isNativePlatform();

let S = blankState();
let busy = false;
let tab = 'chat';
let REV = null;
let lastError = null;
let ownMsg = '';

const $ = (id) => document.getElementById(id);

// ---------- state helpers ----------
function persist() {
  saveState(S);
}
function newChat(topic, custom = null) {
  return { id: todayKey() + '-' + Date.now().toString(36), date: todayKey(), topic, custom, msgs: [], turns: 0, finished: false, summary: null };
}
function ensureToday() {
  if (!S.chat || S.chat.date !== todayKey()) {
    S = archiveChat(S);
    S.chat = newChat(topicIndexFor());
    REV = null;
    persist();
  }
}
const lastAi = () => [...S.chat.msgs].reverse().find((m) => m.role === 'ai') || null;
const lastIsMine = () => S.chat.msgs.length > 0 && S.chat.msgs[S.chat.msgs.length - 1].role === 'me';

// ---------- small render helpers ----------
const spk = (text, label = 'استمع') => `<button data-act="speak" data-t="${esc(text)}">🔊 ${label}</button>`;
function wordCard(w, dim = false, extra = '') {
  return `<div class="wcard"${dim ? ' style="opacity:.6"' : ''}><div class="wr"><span class="w1">${esc(w.ru)}</span><span>` +
    (w.kind ? `<span class="kind">${esc(KIND_AR[w.kind] || w.kind)}</span> ` : '') +
    `<button class="ghost" style="padding:2px 8px;font-size:13px" data-act="speak" data-t="${esc(w.ru)}" aria-label="استمع">🔊</button></span></div>` +
    `<div>${esc(w.ar)}</div>` + (w.info ? `<div class="info">${esc(w.info)}</div>` : '') + extra + '</div>';
}
function msgsHtml(msgs, who, pref) {
  return msgs.map((m, i) => {
    if (m.role === 'ai') {
      return `<div class="msg ai"><div class="who ru">${esc(who)}</div><div class="bub"><div class="ru">${highlightTaught(m.ru, m.words)}</div>` +
        `<div id="${pref}${i}" class="trans" hidden>${esc(m.ar)}</div>` +
        `<div class="tools">${spk(m.ru)}<button data-act="toggle" data-id="${pref}${i}">الترجمة</button></div></div>` +
        (m.words && m.words.length ? `<div class="words">${m.words.map((w) => wordCard(w)).join('')}</div>` : '') + '</div>';
    }
    const ok = m.corr && m.corr.ok;
    let h = `<div class="msg me"><div class="who">أنت</div><div class="bub"><div class="ru">${esc(m.ru)}</div>` +
      (ok ? `<div class="tools">${spk(m.ru, 'استمع لجملتك')}</div>` : '') + '</div>';
    if (m.corr) {
      h += ok
        ? `<div class="corr good"><span class="lbl">✓ صحيح</span> — ${esc(m.corr.why)}</div>`
        : `<div class="corr fix"><span class="lbl">✎ الأصح:</span> <span class="ru" style="display:block;font-size:16px">${esc(m.corr.fixed)}</span>${esc(m.corr.why)}` +
          (m.corr.fixed ? `<div class="tools">${spk(m.corr.fixed, 'استمع للجملة الصحيحة')}</div>` : '') + '</div>';
    }
    return h + '</div>';
  }).join('');
}

// ---------- chat tab ----------
function renderSheet() {
  const t = topicOf(S.chat);
  const d = new Date();
  const started = S.chat.msgs.length > 0;
  const dis = busy ? ' disabled' : '';
  let html = `<div class="dmon">${WEEKDAYS[d.getDay()]}</div><div class="dnum">${d.getDate()}</div>` +
    `<div class="dmon">${MONTHS[d.getMonth()]} ${d.getFullYear()}</div>` +
    `<div class="tru">${esc(t.ru)}</div><div class="tar">${esc(t.ar)}${S.chat.custom ? ' · من اقتراحك' : ''}</div>`;
  if (!started) {
    html += `<p class="scene">ستتحدث مع <span class="ru">${esc(t.who)}</span>، ${esc(t.role)}. الكلمات الجديدة تظهر بالأزرق مع شرحها، وأصحح جملك بعد كل رد.</p>` +
      `<div class="row"><button class="btn" data-act="start"${dis}>ابدأ المحادثة</button><button class="ghost" data-act="otherTopic"${dis}>موضوع آخر</button></div>`;
  } else {
    html += `<p class="scene" style="margin-bottom:0">مع <span class="ru">${esc(t.who)}</span>، ${esc(t.role)}</p>`;
  }
  html += `<div class="own"><label for="ownTopic">${started ? 'تريد موضوعًا آخر؟ اقترحه وتبدأ محادثة جديدة' : 'أو اقترح أنت موضوع المحادثة'}</label>` +
    `<div class="crow"><input id="ownTopic" type="text" maxlength="${LIMITS.ideaChars}" placeholder="مثلًا: القهوة، كرة القدم، الحياة في موسكو">` +
    `<button class="btn" data-act="propose"${dis}>ابدأ</button></div>` +
    `<div class="chips">${TOPIC_IDEAS.map((x, i) => `<button data-act="idea" data-i="${i}">${esc(x)}</button>`).join('')}</div>` +
    `<div id="ownMsg" class="small" role="status">${esc(ownMsg)}</div></div>`;
  if (NATIVE && !S.remSet) html += `<div class="own"><div class="small">التذكيرات تنبهك للمراجعة صباحًا ومساءً وللمحادثة اليومية.</div><div class="tools"><button class="btn" data-act="remEnable">فعّل التذكيرات اليومية</button></div></div>`;
  if (S.done[todayKey()] !== undefined) html += '<div class="donebadge">✓ أنجزت محادثة اليوم</div>';
  const keep = $('ownTopic') ? $('ownTopic').value : '';
  $('sheet').innerHTML = html;
  $('ownTopic').value = keep;
}
function renderChat() {
  let h = msgsHtml(S.chat.msgs, topicOf(S.chat).who, 'tr');
  h += `<div id="typing" class="typing"${busy ? '' : ' hidden'}>${busy ? esc(busy) : ''}</div><div id="errBox">`;
  const err = lastError || (!busy && lastIsMine() && !S.chat.finished ? 'pending' : null);
  if (err && !busy) {
    const msg = err === 'pending' ? 'رسالتك الأخيرة لم يُرد عليها بعد.' : AI_ERROR_AR[err] || AI_ERROR_AR.network;
    h += `<div class="err" role="alert"><span>${esc(msg)}</span>` + (!['not_configured', 'quota_exceeded', 'refused'].includes(err) ? '<button class="ghost" style="padding:3px 10px" data-act="retry">أعد المحاولة</button>' : '') + '</div>';
  }
  $('chat').innerHTML = h + '</div>';
}
function renderComposer() {
  const active = S.chat.msgs.length > 0 && !S.chat.finished && tab === 'chat';
  $('composer').hidden = !active;
  if (!active) return;
  const hs = (lastAi() && lastAi().hints) || [];
  $('hints').innerHTML = hs.map((x, k) => `<button title="${esc(x.ar)}" data-act="hint" data-i="${k}">${esc(x.ru)}</button>`).join('');
  $('turnInfo').textContent = `رسائلك: ${S.chat.turns} من ${GOAL}`;
  $('endBtn').hidden = S.chat.turns < 3;
  $('sendBtn').disabled = !!busy || lastIsMine();
}
function renderSummary() {
  const s = S.chat.summary;
  if (!S.chat.finished || !s) {
    $('summaryBox').innerHTML = '';
    return;
  }
  $('summaryBox').innerHTML = `<div class="panel summary"><h2>تقييم اليوم: <bdi dir="ltr">${esc(s.score)} / 10</bdi></h2>` +
    `<p>${esc(s.summary_ar)}</p><p><b>أحسنت في:</b> ${esc(s.strengths_ar)}</p><p><b>ركّز على:</b> ${esc(s.work_on_ar)}</p>` +
    (s.phrase ? `<p><b>عبارة اليوم:</b> <span class="ru" style="display:block;font-size:18px">${esc(s.phrase.ru)}</span>${esc(s.phrase.ar)}</p><div class="tools">${spk(s.phrase.ru)}</div>` : '') +
    '<div class="tools"><button class="btn" data-act="newRound">محادثة إضافية بموضوع آخر</button></div></div>';
}

// ---------- conversation flow ----------
function chatPayload() {
  return {
    topic: topicOf(S.chat),
    turns: S.chat.turns,
    messages: S.chat.msgs.slice(-14).map((m) => ({ role: m.role, ru: m.ru })),
  };
}
async function askAI() {
  busy = topicOf(S.chat).who + ' يكتب…';
  lastError = null;
  renderAll();
  scrollEnd();
  try {
    const r = await requestAI('chat', chatPayload());
    if (r.correction) {
      const mine = [...S.chat.msgs].reverse().find((m) => m.role === 'me');
      if (mine) mine.corr = r.correction;
    }
    S.chat.msgs.push({ role: 'ai', ru: r.reply, ar: r.reply_ar, words: r.words, hints: r.hints });
    S.words = addWords(S.words, r.words, todayKey());
    persist();
  } catch (e) {
    lastError = e.code || 'network';
  }
  busy = false;
  renderAll();
  scrollEnd();
}
function send() {
  const el = $('inp');
  const text = el.value.trim().slice(0, LIMITS.messageChars);
  if (!text || busy || lastIsMine()) return;
  el.value = '';
  autoGrow();
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  S.chat.msgs.push({ role: 'me', ru: text });
  S.chat.turns++;
  persist();
  askAI();
}
async function finish() {
  if (busy || S.chat.turns < 1) return;
  busy = 'يكتب لك التقييم…';
  lastError = null;
  S.chat.finishing = true;
  renderAll();
  scrollEnd();
  try {
    const t = topicOf(S.chat);
    const r = await requestAI('evaluate', { topic: t, messages: S.chat.msgs.map((m) => ({ role: m.role, ru: m.ru })) });
    S.chat.summary = r;
    S.chat.finished = true;
    S.chat.finishing = false;
    S = markConversationDone(S, t.ar);
    S = archiveChat(S);
    persist();
  } catch (e) {
    lastError = e.code || 'network';
  }
  busy = false;
  renderAll();
  scrollEnd();
}
function retry() {
  if (busy) return;
  if (S.chat.finishing) finish();
  else askAI();
}
async function proposeTopic() {
  const idea = ($('ownTopic').value || '').trim();
  if (!idea || busy) return;
  busy = 'أجهّز شخصية لهذا الموضوع…';
  ownMsg = busy;
  renderAll();
  try {
    const t = await requestAI('topic', { idea });
    if (S.chat.msgs.length) S = archiveChat(S);
    S.chat = newChat(S.chat.topic, t);
    ownMsg = '';
    $('ownTopic').value = '';
    persist();
    busy = false;
    tear();
    askAI();
    return;
  } catch (e) {
    ownMsg = AI_ERROR_AR[e.code] || AI_ERROR_AR.network;
  }
  busy = false;
  renderAll();
}
function otherTopic() {
  if (S.chat.msgs.length || busy) return;
  S.chat.custom = null;
  S.chat.topic = (S.chat.topic + 1) % TOPICS.length;
  persist();
  renderAll();
  tear();
}
function newRound() {
  S = archiveChat(S);
  S.chat = newChat((S.chat.topic + 1) % TOPICS.length);
  lastError = null;
  persist();
  renderAll();
  window.scrollTo(0, 0);
  tear();
}

// ---------- cards & schedule ----------
function renderSched() {
  const cur = slotAt();
  const td = todayKey();
  const reviewing = REV && !REV.done;
  let html = '<div class="slots">' + ['am', 'pm'].map((s) => {
    const done = reviewDone(S, td, s);
    const time = s === 'am' ? S.reminders.am : S.reminders.pm;
    const note = !NATIVE ? 'التذكير من تطبيق التذكيرات' : S.reminders.enabled && S.remSet ? 'التذكير ' + esc(time) : 'بدون تذكير';
    return `<div class="slot${s === cur && !done ? ' now' : ''}"><div><b>${SLOTS[s].icon} ${SLOTS[s].name}</b><div class="small">${note}</div></div>` +
      (done ? '<span class="pill ok">✓ تمت</span>' : `<button class="btn" data-act="review" data-slot="${s}"${S.words.length && !reviewing ? '' : ' disabled'}>ابدأ</button>`) + '</div>';
  }).join('') + '</div>';
  let am = 0;
  let pm = 0;
  const rows = lastDays(7).map((d) => {
    const k = dayKey(d);
    const a = reviewDone(S, k, 'am');
    const p = reviewDone(S, k, 'pm');
    if (a) am++;
    if (p) pm++;
    return `<tr${k === td ? ' class="td"' : ''}><td>${k === td ? 'اليوم' : AR_DAYS[d.getDay()]} <bdi class="small" dir="ltr">${d.getDate()}/${d.getMonth() + 1}</bdi></td>` +
      `<td class="${a ? 'y' : 'n'}">${a ? '✓' : '·'}</td><td class="${p ? 'y' : 'n'}">${p ? '✓' : '·'}</td></tr>`;
  }).join('');
  html += `<div class="tablewrap"><table class="week"><thead><tr><th>آخر ٧ أيام</th><th>☀️ صباح</th><th>🌙 مساء</th></tr></thead><tbody>${rows}</tbody>` +
    `<tfoot><tr><td class="small">المجموع</td><td><bdi dir="ltr">${am} / 7</bdi></td><td><bdi dir="ltr">${pm} / 7</bdi></td></tr></tfoot></table></div>`;
  $('sched').innerHTML = html;
}
function cardFaces(card) {
  const w = findWord(S.words, card.ru) || { ru: card.ru, ar: '', info: '', kind: '' };
  const listen = `<button class="ghost" style="padding:4px 12px;font-size:14px" data-act="speak" data-t="${esc(w.ru)}">🔊 استمع</button>`;
  const kind = w.kind ? `<span class="kind">${esc(KIND_AR[w.kind] || w.kind)}</span>` : '';
  const info = w.info ? `<div class="info">${esc(w.info)}</div>` : '';
  if (card.dir === 'ru') {
    return {
      front: `<div class="q">ماذا تعني هذه الكلمة؟</div><div class="main">${esc(w.ru)}</div>${listen}<div class="q">اضغط على البطاقة لتقلبها</div>`,
      back: `${kind}<div class="main arw">${esc(w.ar)}</div><div class="sub">${esc(w.ru)}</div>${info}${listen}`,
    };
  }
  return {
    front: `<div class="q">كيف تقولها بالروسية؟</div><div class="main arw">${esc(w.ar)}</div>${kind}<div class="q">اضغط على البطاقة لتقلبها</div>`,
    back: `<div class="main">${esc(w.ru)}</div>${listen}${info}`,
  };
}
function renderRevBtns() {
  const b = $('revBtns');
  if (!b || !REV) return;
  b.innerHTML = REV.flipped
    ? '<div class="revbtns"><button class="btn" data-act="answer" data-ok="1">✓ عرفتها</button><button class="no" data-act="answer" data-ok="0">✗ لم أعرفها</button></div>'
    : '<div class="revbtns" style="grid-template-columns:1fr"><button class="btn" data-act="flip">اقلب البطاقة</button></div>';
}
function renderRev() {
  const box = $('rev');
  const sizes = '<div class="sizes">عدد البطاقات في كل مراجعة:' +
    SESSION_SIZES.map((n) => `<button class="${S.revSize === n ? 'on' : ''}" data-act="size" data-n="${n}">${n || 'الكل'}</button>`).join('') + '</div>';
  if (!S.words.length) {
    box.innerHTML = '<p style="margin:0">لا توجد كلمات بعد. كل كلمة جديدة تظهر في محادثاتك تُضاف هنا تلقائيًا كبطاقة.</p>';
    return;
  }
  if (!REV) {
    const s = slotAt();
    box.innerHTML = `<p style="margin-top:0">لديك ${S.words.length} كلمة. في كل مراجعة تُخلط البطاقات عشوائيًا، وتظهر الكلمة أحيانًا بالروسية وأحيانًا بالعربية. الكلمة التي لا تعرفها تعود لك مرة أخرى في مكان عشوائي من نفس المراجعة.</p>${sizes}` +
      `<div class="row" style="justify-content:flex-start;margin-top:12px"><button class="btn" data-act="review" data-slot="${s}">ابدأ ${SLOTS[s].name}</button></div>`;
    return;
  }
  if (REV.done) {
    const pct = REV.total ? Math.round((REV.right * 100) / REV.total) : 0;
    box.innerHTML = `<div class="revsum"><b dir="ltr">${REV.right} / ${REV.total}</b>عرفتها من أول مرة (${pct}%)</div>` +
      `<p style="text-align:center">${pct >= 80 ? 'ممتاز! ذاكرتك قوية اليوم.' : pct >= 50 ? 'جيد. الكلمات التي أخطأت فيها ستظهر لك في المراجعات القادمة.' : 'لا بأس، التكرار هو الطريق. راجعها مرة أخرى في المساء.'}</p>` +
      `<div class="row"><button class="btn" data-act="review" data-slot="${REV.slot}">جولة أخرى</button><button class="ghost" data-act="stopReview">إنهاء</button></div>`;
    return;
  }
  const card = currentCard(REV);
  const f = cardFaces(card);
  const prog = Math.round((REV.index * 100) / REV.queue.length);
  box.innerHTML = `<div class="wr small"><span>${SLOTS[REV.slot].icon} ${SLOTS[REV.slot].name}${card.again ? ' · مراجعة كلمة أخطأت فيها' : ''}</span><bdi dir="ltr">${REV.index + 1} / ${REV.queue.length}</bdi></div>` +
    `<div class="bar"><i style="width:${prog}%"></i></div>` +
    `<div class="card3d"><div id="flipCard" class="flip${REV.flipped ? ' on' : ''}" role="button" tabindex="0" aria-label="اقلب البطاقة" data-act="flip">` +
    `<div class="face front">${f.front}</div><div class="face back">${f.back}</div></div></div>` +
    '<div id="revBtns"></div><div class="row" style="margin-top:10px"><button class="ghost" style="font-size:13px;padding:5px 12px" data-act="stopReview">إيقاف المراجعة</button></div>';
  renderRevBtns();
}
function renderWordList() {
  const list = shuffle(S.words);
  $('wordList').innerHTML = list.length
    ? list.map((w) => wordCard(w, w.known, w.seen ? `<div class="small">✓ ${w.right || 0} · ✗ ${w.wrong || 0}${w.known ? ' · محفوظة' : ''}</div>` : '')).join('')
    : '<p>لا توجد كلمات بعد. ابدأ محادثة اليوم وستُحفظ كل كلمة جديدة هنا.</p>';
}
function startReview(slot) {
  if (!S.words.length) return;
  REV = createSession({ words: S.words, size: S.revSize, slot });
  renderSched();
  renderRev();
  $('revPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function flipCard() {
  if (!REV || REV.done) return;
  REV = flip(REV);
  const el = $('flipCard');
  if (el) el.classList.toggle('on', REV.flipped);
  renderRevBtns();
}
function answer(ok) {
  if (!REV || !REV.flipped || REV.done) return;
  const card = currentCard(REV);
  S.words = S.words.map((w) => (norm(w.ru) === norm(card.ru) ? recordAnswer(w, ok) : w));
  REV = answerCard(REV, ok);
  if (REV.done) S = markReviewDone(S, REV.slot);
  persist();
  renderStats();
  renderSched();
  renderRev();
  renderWordList();
}

// ---------- progress tab ----------
function renderProg() {
  $('pStreak').textContent = effectiveStreak(S);
  $('pDays').textContent = Object.keys(S.done).length;
  $('pWords').textContent = S.words.length;
  $('grid').innerHTML = lastDays(28).map((d) => {
    const k = dayKey(d);
    const on = S.done[k] !== undefined;
    const tip = on ? (typeof S.done[k] === 'number' ? TOPICS[S.done[k]]?.ar : S.done[k]) : '';
    return `<div class="cell${on ? ' d' : ''}${k === todayKey() ? ' t' : ''}" title="${esc(tip || '')}">${d.getDate()}</div>`;
  }).join('');
  $('remWeb').hidden = NATIVE;
  $('remNative').hidden = !NATIVE;
  $('remOn').checked = S.reminders.enabled;
  $('remAm').value = S.reminders.am;
  $('remChat').value = S.reminders.chat;
  $('remPm').value = S.reminders.pm;
  const list = [...S.history].reverse();
  $('histList').innerHTML = list.length
    ? list.map((c) => {
      const t = topicOf(c);
      return `<div class="wcard" role="button" tabindex="0" style="cursor:pointer" data-act="openHist" data-id="${esc(c.id)}"><div class="wr"><span>${esc(t.ar)} — <span class="ru">${esc(t.ru)}</span></span><span class="info">${esc(c.date)}${c.score != null ? ' · <bdi dir="ltr">' + esc(c.score) + '/10</bdi>' : ''}</span></div></div>`;
    }).join('')
    : '<p style="margin:0">ستظهر هنا محادثاتك المنتهية لتعيد قراءتها وسماعها.</p>';
}
function openHist(id) {
  const c = S.history.find((h) => h.id === id);
  if (!c) return;
  const t = topicOf(c);
  $('histView').innerHTML = `<div style="border-top:1px solid var(--line);margin-top:12px;padding-top:8px"><div class="tools" style="justify-content:space-between"><b>${esc(t.ar)} · ${esc(c.date)}</b><button data-act="closeHist">إغلاق</button></div>${msgsHtml(c.msgs, t.who, 'h_')}</div>`;
  $('histView').scrollIntoView({ behavior: 'smooth' });
}
async function saveReminders(enable) {
  const r = {
    enabled: enable === undefined ? $('remOn').checked : enable,
    am: (enable === undefined ? $('remAm').value : S.reminders.am) || S.reminders.am,
    chat: (enable === undefined ? $('remChat').value : S.reminders.chat) || S.reminders.chat,
    pm: (enable === undefined ? $('remPm').value : S.reminders.pm) || S.reminders.pm,
  };
  S.reminders = r;
  const status = await applyReminders(r);
  const msg = {
    scheduled: `تم. ستصلك التذكيرات يوميًا الساعة ${r.am} و${r.chat} و${r.pm}.`,
    off: 'أوقفت التذكيرات.',
    denied: 'لم تسمح للتطبيق بالإشعارات. فعّلها من إعدادات الهاتف ← التطبيقات ← Разговор дня ← الإشعارات.',
    unsupported: 'التذكيرات تعمل في تطبيق الهاتف فقط، وليس في المتصفح.',
    error: 'تعذّر ضبط التذكيرات. أعد المحاولة.',
  }[status];
  if (status === 'scheduled' || status === 'off') S.remSet = true;
  persist();
  if ($('remMsg')) $('remMsg').textContent = msg;
  if (enable !== undefined) showNotice(msg);
  renderAll();
}

// ---------- shell ----------
function renderStats() {
  $('stStreak').textContent = effectiveStreak(S);
  $('stWords').textContent = S.words.length;
}
function renderAll() {
  renderStats();
  renderSheet();
  renderChat();
  renderSummary();
  renderComposer();
  if (tab === 'words') { renderSched(); renderRev(); renderWordList(); }
  if (tab === 'prog') renderProg();
}
function showTab(t) {
  tab = t;
  $('vChat').hidden = t !== 'chat';
  $('vWords').hidden = t !== 'words';
  $('vProg').hidden = t !== 'prog';
  for (const [id, name] of [['tabChat', 'chat'], ['tabWords', 'words'], ['tabProg', 'prog']]) $(id).classList.toggle('on', t === name);
  renderAll();
  window.scrollTo(0, 0);
}
function showNotice(text) {
  const el = $('notice');
  el.textContent = text || '';
  el.hidden = !text;
}
function tear() {
  const sh = $('sheet');
  sh.classList.remove('tear');
  void sh.offsetWidth;
  sh.classList.add('tear');
}
function scrollEnd() {
  setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 60);
}
function autoGrow() {
  const el = $('inp');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
function updateNet() {
  const off = navigator.onLine === false;
  $('net').hidden = !off;
  $('net').classList.toggle('off', off);
}

// One delegated handler: no inline handlers, so the CSP can forbid inline script.
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) return showTab(tabBtn.dataset.tab);
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  switch (d.act) {
    case 'speak': e.stopPropagation(); speakRussian(d.t); break;
    case 'toggle': { const x = $(d.id); if (x) x.hidden = !x.hidden; break; }
    case 'start': if (!busy) askAI(); break;
    case 'otherTopic': otherTopic(); break;
    case 'idea': $('ownTopic').value = TOPIC_IDEAS[Number(d.i)] || ''; $('ownTopic').focus(); break;
    case 'propose': proposeTopic(); break;
    case 'hint': { const h = lastAi()?.hints?.[Number(d.i)]; if (h) { $('inp').value = h.ru; $('inp').focus(); autoGrow(); } break; }
    case 'retry': retry(); break;
    case 'newRound': newRound(); break;
    case 'review': startReview(d.slot); break;
    case 'flip': flipCard(); break;
    case 'answer': answer(d.ok === '1'); break;
    case 'stopReview': REV = null; renderSched(); renderRev(); break;
    case 'size': S.revSize = Number(d.n); persist(); renderRev(); break;
    case 'openHist': openHist(d.id); break;
    case 'closeHist': $('histView').innerHTML = ''; break;
    case 'remEnable': saveReminders(true); break;
    default: break;
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-act]')) {
    e.preventDefault();
    e.target.click();
  }
});
$('sendBtn').addEventListener('click', send);
$('endBtn').addEventListener('click', finish);
$('remSave').addEventListener('click', () => saveReminders());
$('resetBtn').addEventListener('click', () => { $('resetBox').hidden = false; });
$('resetNo').addEventListener('click', () => { $('resetBox').hidden = true; });
$('resetYes').addEventListener('click', async () => {
  S = blankState();
  REV = null;
  lastError = null;
  ensureToday();
  persist();
  await flush();
  await applyReminders({ enabled: false });
  $('resetBox').hidden = true;
  showTab('chat');
});
$('inp').addEventListener('input', () => {
  autoGrow();
  try { localStorage.setItem(DRAFT_KEY, $('inp').value); } catch { /* ignore */ }
});
$('inp').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('sheet').addEventListener('keydown', (e) => {
  if (e.target.id === 'ownTopic' && e.key === 'Enter') { e.preventDefault(); proposeTopic(); }
});
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

function onResume() {
  const before = S.chat && S.chat.id;
  ensureToday();
  if (S.chat.id !== before) renderAll();
  else { renderStats(); if (tab === 'words') renderSched(); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
  else onResume();
});

function registerWeb() {
  if (NATIVE) return;
  // Ask Safari/Chrome not to evict the learner's data under storage pressure.
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* app still works online */ });
  }
}

async function boot() {
  S = await loadState();
  ensureToday();
  try { const dr = localStorage.getItem(DRAFT_KEY); if (dr) $('inp').value = dr; } catch { /* ignore */ }
  updateNet();
  registerWeb();
  if (backendConfigured()) configureAI({ endpoint: aiEndpoint, publishableKey, getToken: getAccessToken });
  if (!aiConfigured()) showNotice(NATIVE
    ? 'المحادثة تحتاج ربط الخادم. البطاقات والمراجعة والتذكيرات تعمل الآن بدون إنترنت.'
    : 'المحادثة تحتاج ربط الخادم. البطاقات والمراجعة تعمل الآن حتى بدون إنترنت.');
  renderAll();
  if (S.chat.msgs.length) scrollEnd();
  if (Capacitor.isNativePlatform()) {
    App.addListener('pause', () => { flush(); setForeground(false); });
    App.addListener('resume', () => { setForeground(true); onResume(); });
    onReminderTap((open) => showTab(open === 'chat' ? 'chat' : 'words'));
    if (S.remSet && S.reminders.enabled) applyReminders(S.reminders); // idempotent: fixed ids
  }
}
boot();
