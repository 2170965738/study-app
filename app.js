'use strict';
/* 学习管理 MVP：原生 JS + localStorage，无依赖 */

/* ===== 常量 ===== */
const KEY = 'studyhub.v1';
const DAY_START = 8 * 60;      // 08:00
const DAY_END = 22 * 60;       // 22:00
const HOUR_H = 44;             // 课表每小时像素高
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const CATS = { gongkao: '考公', cet4: '四级', other: '其他', fitness: '健身' };
const CAT_RANK = { gongkao: 0, cet4: 1, other: 2, fitness: 3 };
const PRI_TEXT = { 1: '高', 2: '中', 3: '低' };

/* ===== 工具 ===== */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const clone = o => JSON.parse(JSON.stringify(o));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return todayStr(d);
}
function weekdayOf(s) {
  const w = parseDate(s).getDay();
  return w === 0 ? 7 : w;
}
function weekStartStr(s = todayStr()) {
  return addDays(s, -(weekdayOf(s) - 1));
}
function toMin(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function fromMin(m) {
  m = Math.max(0, Math.round(m));
  return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
}
function durText(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分钟`;
  return sec > 0 ? `${sec} 秒` : '0 分钟';
}
function hms(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}

function hoursText(min) {
  if (min < 60) return `${min} 分钟`;
  return (min / 60).toFixed(1).replace(/\.0$/, '') + ' 小时';
}

/* ===== 数据 ===== */
const DEFAULT = {
  courses: [],
  tasks: [],
  workouts: {},
  focus: null,
  exams: { guokao: '2027-11-28', shengkao: '2028-03-18' },
  ui: { tab: 'dash', taskDate: '', focusMin: 25 }
};

// 旧数据的 spent 字段迁移为 actualSeconds；导入旧备份也走这里
function normTask(t) {
  const out = Object.assign({}, t);
  if (out.actualSeconds == null) out.actualSeconds = Number(t.spent) || 0;
  out.actualSeconds = Number(out.actualSeconds) || 0;
  out.run = Number(out.run) || 0;
  delete out.spent;
  return out;
}

function normalize(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    courses: Array.isArray(raw.courses) ? raw.courses : [],
    tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map(normTask),
    workouts: raw.workouts && typeof raw.workouts === 'object' && !Array.isArray(raw.workouts) ? raw.workouts : {},
    focus: raw.focus && typeof raw.focus === 'object' ? raw.focus : null,
    exams: Object.assign({}, DEFAULT.exams, raw.exams || {}),
    ui: Object.assign({}, DEFAULT.ui, raw.ui || {})
  };
}

function load() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { raw = {}; }
  const st = normalize(raw);
  // 一次性升级旧版默认日期（国考 2026-11-29、省考 2027-03-20）；之后用户的修改不再覆盖
  if (!st.ui.shengkao2028) {
    if (st.exams.shengkao === '2027-03-20') st.exams.shengkao = DEFAULT.exams.shengkao;
    st.ui.shengkao2028 = true;
  }
  if (!st.ui.guokao2027) {
    if (st.exams.guokao === '2026-11-29') st.exams.guokao = DEFAULT.exams.guokao;
    st.ui.guokao2027 = true;
  }
  return st;
}
let state = load();

/* ===== 云端同步（任务 / 课表） ===== */
const cloud = {
  client: null,
  user: null,
  channel: null,
  pushing: false,
  pendingPush: false,
  pushTimer: 0,
  pullTimer: 0,
  pullPending: false
};

let toastTimer = 0;
function syncError(text) {
  let el = document.getElementById('sync-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-error';
    el.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:300;' +
      'max-width:80vw;padding:10px 16px;border-radius:14px;background:#FFE3EA;color:#B32746;' +
      'font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.12);';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(syncError._t);
  syncError._t = setTimeout(() => { el.style.display = 'none'; }, 10000);
}
function syncToast(text) {
  let el = document.getElementById('sync-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:200;' +
      'max-width:80vw;padding:10px 16px;border-radius:14px;background:rgba(255,255,255,.9);' +
      'backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.08);color:#5a6672;font-size:13px;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 4200);
}

function taskToRow(t, uid) {
  return {
    id: t.id,
    user_id: uid,
    name: t.name,
    cat: t.cat || 'other',
    task_date: t.date,
    start_time: t.start || null,
    end_time: t.end || null,
    priority: Number(t.priority) || 2,
    est: Number(t.est) || 60,
    done: !!t.done,
    actual_seconds: Math.round(Number(t.actualSeconds) || 0)
  };
}
function rowToTask(r) {
  return {
    id: r.id,
    name: r.name,
    cat: r.cat || 'other',
    date: r.task_date,
    start: r.start_time ? String(r.start_time).slice(0, 5) : '',
    end: r.end_time ? String(r.end_time).slice(0, 5) : '',
    priority: Number(r.priority) || 2,
    est: Number(r.est) || 60,
    done: !!r.done,
    actualSeconds: Number(r.actual_seconds) || 0,
    run: 0
  };
}
function courseToRow(c, uid) {
  return {
    id: c.id,
    user_id: uid,
    name: c.name,
    weekday: Number(c.weekday) || 1,
    start_time: c.start,
    end_time: c.end,
    place: c.place || ''
  };
}
function rowToCourse(r) {
  return {
    id: r.id,
    name: r.name,
    weekday: Number(r.weekday) || 1,
    start: String(r.start_time || '').slice(0, 5),
    end: String(r.end_time || '').slice(0, 5),
    place: r.place || ''
  };
}

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.warn('保存失败', e); }
}
function save() {
  saveLocal();
  if (cloud.client && cloud.user) {
    schedulePush();
  } else {
    // 兜底：登录监听可能晚于首次编辑，拿到 session 后补推
    ensureCloudUser().then(ok => { if (ok) schedulePush(); });
  }
}

// 尽量确保 cloud.client / cloud.user 就绪（防止 auth.js 事件错过）
async function ensureCloudUser() {
  if (cloud.user) return true;
  const c = cloud.client || window.studyhubClient;
  if (!c) return false;
  cloud.client = c;
  try {
    const { data } = await c.auth.getSession();
    const user = data && data.session && data.session.user;
    if (!user) return false;
    cloud.user = user;
    console.info('[sync] ensureCloudUser →', user.email, user.id);
    if (!cloud.channel) subscribeRealtime();
    return true;
  } catch (err) {
    console.warn('[sync] getSession failed', err);
    return false;
  }
}

function schedulePush() {
  if (!cloud.client || !cloud.user) {
    console.warn('[sync] skip push：未登录或客户端未就绪', {
      hasClient: !!cloud.client, hasUser: !!cloud.user,
      windowClient: !!window.studyhubClient, windowUser: !!window.studyhubUser
    });
    return;
  }
  clearTimeout(cloud.pushTimer);
  cloud.pushTimer = setTimeout(pushCloud, 700);
}

async function pushCloud() {
  if (!cloud.client || !cloud.user) return;
  if (cloud.pushing) { cloud.pendingPush = true; return; }
  cloud.pushing = true;
  const uid = cloud.user.id;
  let taskRows = [];
  let courseRows = [];
  try {
    taskRows = state.tasks.map(t => taskToRow(t, uid));
    courseRows = state.courses.map(c => courseToRow(c, uid));
    console.info('[sync] push', { uid, tasks: taskRows.length, courses: courseRows.length });

    if (taskRows.length) {
      const { error } = await cloud.client.from('tasks').upsert(taskRows, { onConflict: 'id' });
      if (error) throw error;
    }
    if (courseRows.length) {
      const { error } = await cloud.client.from('courses').upsert(courseRows, { onConflict: 'id' });
      if (error) throw error;
    }

    const [tRes, cRes] = await Promise.all([
      cloud.client.from('tasks').select('id').eq('user_id', uid),
      cloud.client.from('courses').select('id').eq('user_id', uid)
    ]);
    const keepT = new Set(taskRows.map(r => r.id));
    const keepC = new Set(courseRows.map(r => r.id));
    const dropT = (tRes.data || []).map(r => r.id).filter(id => !keepT.has(id));

    const dropC = (cRes.data || []).map(r => r.id).filter(id => !keepC.has(id));
    if (dropT.length) {
      const { error } = await cloud.client.from('tasks').delete().eq('user_id', uid).in('id', dropT);
      if (error) throw error;
    }
    if (dropC.length) {
      const { error } = await cloud.client.from('courses').delete().eq('user_id', uid).in('id', dropC);
      if (error) throw error;
    }
  } catch (err) {
    console.error('[sync] push failed', {
      message: err && err.message,
      code: err && err.code,
      details: err && err.details,
      hint: err && err.hint,
      taskRows,
      uid
    });
    const extra = [err && err.message, err && err.code, err && err.hint].filter(Boolean).join(' · ');
    syncError('云端同步失败：' + (extra || '请检查网络或 RLS 策略'));
    syncToast('云端同步失败：' + (extra || '请检查网络或 RLS 策略'));
  } finally {
    cloud.pushing = false;
    if (cloud.pendingPush) { cloud.pendingPush = false; schedulePush(); }
    if (cloud.pullPending) { cloud.pullPending = false; pullCloud(); }
  }
}

async function pullCloud(forceRender) {
  if (!cloud.client || !cloud.user) return;
  const uid = cloud.user.id;
  try {
    const [tRes, cRes] = await Promise.all([
      cloud.client.from('tasks').select('*').eq('user_id', uid).order('created_at', { ascending: true }),
      cloud.client.from('courses').select('*').eq('user_id', uid).order('created_at', { ascending: true })
    ]);
    if (tRes.error) throw tRes.error;
    if (cRes.error) throw cRes.error;

    const cloudTasks = (tRes.data || []).map(rowToTask);
    const cloudCourses = (cRes.data || []).map(rowToCourse);
    const cloudEmpty = !cloudTasks.length && !cloudCourses.length;
    const localHas = state.tasks.length > 0 || state.courses.length > 0;
    const migratedKey = 'studyhub.migrated.' + uid;

    // 首次登录且云端为空：把本地旧数据迁移上去
    if (cloudEmpty && localHas && !localStorage.getItem(migratedKey)) {
      await migrateLocalToCloud(uid);
      return;
    }

    // 本机正在计时的任务：保留 run 与本地累计，避免被云端回写打断
    const localById = new Map(state.tasks.map(t => [t.id, t]));
    const mergedTasks = cloudTasks.map(t => {
      const local = localById.get(t.id);
      if (local && local.run) return Object.assign({}, t, { run: local.run, actualSeconds: local.actualSeconds });
      return t;
    });

    const changed = JSON.stringify(mergedTasks) !== JSON.stringify(state.tasks) ||
      JSON.stringify(cloudCourses) !== JSON.stringify(state.courses);

    state.tasks = mergedTasks;
    state.courses = cloudCourses;
    saveLocal();
    if (changed || forceRender) renderAll();
  } catch (err) {
    console.warn('[sync] pull failed', err);
    syncError('云端数据读取失败：' + (err.message || '请检查网络'));
    syncToast('云端数据读取失败：' + (err.message || '请检查网络'));
  }
}

async function migrateLocalToCloud(uid) {
  try {
    const taskRows = state.tasks.map(t => taskToRow(t, uid));
    const courseRows = state.courses.map(c => courseToRow(c, uid));
    if (taskRows.length) {
      const { error } = await cloud.client.from('tasks').insert(taskRows);
      if (error) throw error;
    }
    if (courseRows.length) {
      const { error } = await cloud.client.from('courses').insert(courseRows);
      if (error) throw error;
    }
    localStorage.setItem('studyhub.migrated.' + uid, '1');
    syncToast(`已迁移本地 ${taskRows.length} 个任务、${courseRows.length} 门课程到云端`);
    await pullCloud(true);
  } catch (err) {
    console.warn('[sync] migrate failed', err);
    syncError('本地数据迁移失败：' + (err.message || '请稍后重试'));
    syncToast('本地数据迁移失败：' + (err.message || '请稍后重试'));
  }
}

function onRemoteChange() {
  if (cloud.pushing) { cloud.pullPending = true; return; }
  clearTimeout(cloud.pullTimer);
  cloud.pullTimer = setTimeout(() => pullCloud(), 900);
}

function subscribeRealtime() {
  if (!cloud.client || !cloud.user) return;
  if (cloud.channel) { cloud.client.removeChannel(cloud.channel); cloud.channel = null; }
  const uid = cloud.user.id;
  cloud.channel = cloud.client
    .channel('studyhub-' + uid)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${uid}` }, onRemoteChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'courses', filter: `user_id=eq.${uid}` }, onRemoteChange)
    .subscribe();
}

function handleAuthUser(user) {
  const prevId = cloud.user && cloud.user.id;
  cloud.user = user || null;
  if (!user) {
    if (cloud.client && cloud.channel) { cloud.client.removeChannel(cloud.channel); cloud.channel = null; }
    return;
  }
  if (prevId !== user.id) {
    console.info('[sync] signed in as', user.id, user.email);
    pullCloud(true);
    subscribeRealtime();
  }
}

function initCloud() {
  const bind = () => {
    if (!window.studyhubClient) return false;
    cloud.client = window.studyhubClient;
    cloud.client.auth.getSession().then(({ data }) => {
      const user = data && data.session && data.session.user;
      handleAuthUser(user);
      if (user) syncToast('已连接云端，任务和课表会自动同步');
      else syncToast('未登录：数据仅保存在本机，登录后自动同步到云端');
    });
    return true;
  };
  document.addEventListener('studyhub:auth', e => {
    if (!cloud.client && window.studyhubClient) cloud.client = window.studyhubClient;
    handleAuthUser(e.detail && e.detail.user);
  });
  if (!bind()) {
    let tries = 0;
    const timer = setInterval(() => {
      if (bind()) clearInterval(timer);
      else if (++tries > 100) clearInterval(timer);
    }, 100);
  }
}

// 手动排查用：控制台执行 await studyhubSync.push() / pull()
window.studyhubSync = { push: pushCloud, pull: pullCloud, state: () => state, cloud: () => cloud };

/* ===== 空闲时段 ===== */
function busyBlocks(dateStr) {
  const wd = weekdayOf(dateStr);
  const list = [];
  for (const c of state.courses) {
    const s = toMin(c.start), e = toMin(c.end);
    if (Number(c.weekday) === wd && s != null && e != null && e > s) list.push({ s, e, label: c.name });
  }
  for (const t of state.tasks) {
    const s = toMin(t.start), e = toMin(t.end);
    if (t.date === dateStr && s != null && e != null && e > s) list.push({ s, e, label: t.name });
  }
  return list.sort((a, b) => a.s - b.s);
}

function freeSlots(dateStr) {
  const busy = busyBlocks(dateStr);
  const out = [];
  let cur = DAY_START;
  for (const b of busy) {
    const s = Math.max(b.s, DAY_START), e = Math.min(b.e, DAY_END);
    if (e <= DAY_START || s >= DAY_END) continue;
    if (s > cur) out.push({ s: cur, e: Math.min(s, DAY_END) });
    cur = Math.max(cur, e);
    if (cur >= DAY_END) break;
  }
  if (cur < DAY_END) out.push({ s: cur, e: DAY_END });
  return out.filter(x => x.e - x.s >= 10);
}

/* ===== 计时 ===== */
function elapsed(t) {
  const base = Number(t.actualSeconds) || 0;
  return base + (t.run ? (Date.now() - t.run) / 1000 : 0);
}
function pauseTimer(t) {
  if (!t.run) return;
  t.actualSeconds = elapsed(t); // 累加本次计时，写入任务的实际用时
  t.run = 0;
}
function todayStudySec(date = todayStr()) {
  return state.tasks.filter(t => t.date === date).reduce((sum, t) => sum + elapsed(t), 0);
}

/* ===== 沉浸式专注（番茄倒计时） ===== */
function focusRemain() {
  if (!state.focus) return 0;
  const t = state.tasks.find(x => x.id === state.focus.taskId);
  if (!t) return 0;
  const used = Math.max(0, elapsed(t) - (Number(state.focus.base) || 0));
  return Math.max(0, (Number(state.focus.total) || 1500) - used);
}

function focusText(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return sec >= 3600 ? hms(sec) : `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
}

function renderFocus() {
  const panel = $('focus-panel');
  if (!panel) return;
  if (!state.focus) { panel.classList.add('hidden'); return; }
  const t = state.tasks.find(x => x.id === state.focus.taskId);
  if (!t || t.done) { state.focus = null; panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  $('fp-task').textContent = t.name;
  $('fp-time').textContent = focusText(focusRemain());
  $('fp-toggle').textContent = t.run ? '⏸ 暂停' : '▶ 继续';
}

function startTaskTimer(t) {
  state.tasks.forEach(o => { if (o !== t && o.run) pauseTimer(o); });
  if (state.focus && state.focus.taskId === t.id) {
    t.run = Date.now(); // 继续本任务未结束的专注
  } else {
    const total = Math.max(60, (Number(state.ui.focusMin) || 25) * 60);
    state.focus = { taskId: t.id, total, base: Number(t.actualSeconds) || 0 };
    t.run = Date.now();
  }
  save(); renderAll();
}

function pauseTaskTimer(t) {
  pauseTimer(t);
  save(); renderAll();
}

function endTaskTimer(t) {
  pauseTimer(t);
  if (state.focus && state.focus.taskId === t.id) state.focus = null;
  save(); renderAll();
}

/* ===== 倒计时 ===== */
function cdParts(dateStr) {
  if (!dateStr) return null;
  const target = parseDate(dateStr + '').getTime();
  let diff = target - Date.now();
  if (!isFinite(diff) || diff <= 0) return null;
  const d = Math.floor(diff / 86400000); diff -= d * 86400000;
  const h = Math.floor(diff / 3600000); diff -= h * 3600000;
  const m = Math.floor(diff / 60000); diff -= m * 60000;
  return { d, h, m, s: Math.floor(diff / 1000) };
}
function cdText(dateStr) {
  const p = cdParts(dateStr);
  return p ? `${p.d} 天 ${pad(p.h)}:${pad(p.m)}:${pad(p.s)}` : '已结束';
}

/* ===== 渲染：公共片段 ===== */
function slotsHtml(list) {
  if (!list.length) return '<li class="empty">今天已排满，没有空闲时段</li>';
  return list.map(x => `<li><strong>${fromMin(x.s)}–${fromMin(x.e)}</strong><span class="muted">${hoursText(x.e - x.s)}</span></li>`).join('');
}

function taskRow(t) {
  const cat = CATS[t.cat] || '其他';
  const timeText = t.start && t.end ? `${t.start}–${t.end}` : '未排时间';
  const running = !!t.run;
  const focusing = !!state.focus && state.focus.taskId === t.id;
  const used = elapsed(t);
  const started = running || used > 0;
  return `<li class="${t.done ? 'done' : ''} ${running ? 'running' : ''} ${focusing ? 'focusing' : ''}">
    <input type="checkbox" data-act="done" data-id="${t.id}" ${t.done ? 'checked' : ''}>
    <div class="t-main">
      <div class="t-name"><span class="tag cat-${esc(t.cat || 'other')}">${cat}</span>${esc(t.name)}
        <span class="pri ${Number(t.priority) === 1 ? 'high' : ''}">${PRI_TEXT[Number(t.priority)] || '中'}</span></div>
      <div class="t-meta">
        <span>${timeText}</span>
        <span>计划 ${Number(t.est) || 60} 分</span>
        <span>实际用时 <em data-actual="${t.id}">${hms(used)}</em></span>
      </div>
    </div>
    <span class="timer ${running ? 'running' : ''}" data-timer="${t.id}">${hms(used)}</span>
    <div class="t-actions">
      ${t.done ? '' : `<button data-act="${running ? 'pause' : 'start'}" data-id="${t.id}">${running ? '⏸ 暂停' : (started ? '▶ 继续专注' : '▶ 开始专注')}</button>`}
      ${running ? `<button data-act="stop" data-id="${t.id}">⏹ 结束</button>` : ''}
      <button class="del" data-act="del-task" data-id="${t.id}">删除</button>
    </div>
  </li>`;
}

/* ===== 渲染：仪表盘 ===== */
function renderDash() {
  const now = new Date(), today = todayStr();
  $('d-date').textContent = `${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  $('d-week').textContent = `${now.getFullYear()} 年 · ${WEEKDAYS[weekdayOf(today) - 1]}`;

  const todays = state.tasks.filter(t => t.date === today);
  const doneCount = todays.filter(t => t.done).length;
  $('d-tasks').textContent = `${doneCount}/${todays.length}`;
  $('d-study').textContent = durText(todayStudySec());

  const fit = state.workouts[today];
  $('d-fit').textContent = fit && fit.done ? '已打卡 ✓' : '未打卡';
  const recent = new Set(Array.from({ length: 7 }, (_, i) => addDays(today, -i)));
  const weekCount = Object.keys(state.workouts).filter(d => recent.has(d) && state.workouts[d].done).length;
  $('d-fit-week').textContent = `近 7 天 ${weekCount} 次`;

  $('d-free').innerHTML = slotsHtml(freeSlots(today));
  $('d-tasklist').innerHTML = todays.length
    ? todays.slice().sort((a, b) => (a.done - b.done) || (toMin(a.start) ?? 9999) - (toMin(b.start) ?? 9999)).map(taskRow).join('')
    : '<li class="empty muted" style="border-style:dashed;">今天还没有任务，去「任务」里添加</li>';
}

/* ===== 渲染：课表 ===== */
function renderCourses() {
  const wrap = $('week-grid');
  let html = '<div class="wg-corner"></div>';
  for (let i = 0; i < 7; i++) html += `<div class="wg-head">${WEEKDAYS[i]}</div>`;

  html += '<div class="wg-times">';
  for (let h = 8; h < 22; h++) html += `<div class="wg-time">${pad(h)}:00</div>`;
  html += '</div>';

  for (let d = 1; d <= 7; d++) {
    html += `<div class="wg-day" style="height:${14 * HOUR_H}px">`;
    for (let h = 8; h < 22; h++) html += `<div class="wg-line" style="top:${(h - 8) * HOUR_H}px"></div>`;
    for (const c of state.courses.filter(c => Number(c.weekday) === d)) {
      const s = toMin(c.start), e = toMin(c.end);
      if (s == null || e == null || e <= s) continue;
      const top = (Math.max(s, DAY_START) - DAY_START) / 60 * HOUR_H;
      const hgt = (Math.min(e, DAY_END) - Math.max(s, DAY_START)) / 60 * HOUR_H;
      if (hgt <= 2) continue;
      html += `<div class="wg-course" data-course="${c.id}" style="top:${top}px;height:${hgt}px"
        title="${esc(c.name)} ${c.start}-${c.end} ${esc(c.place || '')}">
        <b>${esc(c.name)}</b><span>${c.start}–${c.end}</span><em>${esc(c.place || '')}</em></div>`;
    }
    html += '</div>';
  }
  wrap.innerHTML = html;

  const sorted = state.courses.slice().sort((a, b) => Number(a.weekday) - Number(b.weekday) || toMin(a.start) - toMin(b.start));
  $('course-list').innerHTML = sorted.length
    ? sorted.map(c => `<li>
        <span class="c-name">${esc(c.name)}</span>
        <span class="c-meta">${WEEKDAYS[Number(c.weekday) - 1]} ${c.start}–${c.end}${c.place ? ' · ' + esc(c.place) : ''}</span>
        <button data-act="del-course" data-id="${c.id}">删除</button>
      </li>`).join('')
    : '<li class="muted" style="border-style:dashed;">还没有课程，先在上面添加</li>';

  $('c-free').innerHTML = slotsHtml(freeSlots(todayStr()));
}

/* ===== 渲染：任务 ===== */
function renderTasks() {
  const date = state.ui.taskDate || todayStr();
  $('task-date').value = date;
  $('task-form').elements.date.value = date;
  $('focus-min').value = Number(state.ui.focusMin) || 25;

  const list = state.tasks.filter(t => t.date === date).sort((a, b) =>
    (a.done - b.done) ||
    ((toMin(a.start) ?? 9999) - (toMin(b.start) ?? 9999)) ||
    (CAT_RANK[a.cat] ?? 3) - (CAT_RANK[b.cat] ?? 3) ||
    Number(a.priority) - Number(b.priority));

  $('task-list').innerHTML = list.length ? list.map(taskRow).join('')
    : '<li class="muted" style="border-style:dashed;">这一天还没有任务</li>';

  const unscheduled = list.filter(t => !t.done && !(t.start && t.end)).length;
  $('suggest-hint').textContent = unscheduled
    ? `${unscheduled} 个任务还没有排时间`
    : (list.length ? '任务都已排好时间' : '');
}

/* ===== 渲染：健身 ===== */
const FIT_TYPES = ['胸', '肩', '背', '腿', '有氧', '休息'];

/* ===== 健身月历状态 ===== */
let fitView = null;       // { y, m }
let fitSelected = '';     // 当前选中的日期
let fitToday = '';        // 用于跨天检测

function ensureFitView() {
  const t = todayStr();
  if (!fitSelected) fitSelected = t;
  if (!fitView) {
    const d = parseDate(t);
    fitView = { y: d.getFullYear(), m: d.getMonth() };
  }
}

function fitMonthStats(y, m) {
  const prefix = `${y}-${pad(m + 1)}`;
  let minutes = 0, days = 0;
  for (const key of Object.keys(state.workouts)) {
    if (!key.startsWith(prefix)) continue;
    const r = state.workouts[key];
    minutes += Number(r.duration) || 0;
    if (r.done) days++;
  }
  return { minutes, days };
}

// 从今天往前倒推连续打卡天数（今天没打卡即为 0）
function fitStreak() {
  let days = 0, date = todayStr();
  while (days < 3660) {
    const rec = state.workouts[date];
    if (!rec || !rec.done) break;
    days++;
    date = addDays(date, -1);
  }
  return days;
}

function renderFitStreak() {
  const n = fitStreak();
  const el = $('fit-streak');
  if (!el) return;
  el.innerHTML = n > 0
    ? `🔥 您已经连续健身 <b>${n}</b> 天啦！`
    : '今天动起来吧！';
}

function renderFitness() {
  ensureFitView();
  const today = todayStr();
  const { y, m } = fitView;
  $('cal-title').textContent = `${y} 年 ${m + 1} 月`;

  const startW = (new Date(y, m, 1).getDay() + 6) % 7;
  const total = new Date(y, m + 1, 0).getDate();
  let html = '';
  for (let i = 0; i < startW; i++) html += '<div class="cal-cell cal-empty"></div>';
  for (let d = 1; d <= total; d++) {
    const date = `${y}-${pad(m + 1)}-${pad(d)}`;
    const rec = state.workouts[date];
    const hasRec = rec && (rec.done || rec.type || Number(rec.duration) || rec.note);
    const cls = ['cal-cell'];
    if (date === today) cls.push('cal-today');
    if (date === fitSelected) cls.push('cal-selected');
    if (hasRec) cls.push('cal-has');
    const mark = rec && rec.type
      ? `<span class="cal-type">${esc(rec.type)}</span>`
      : (hasRec ? '<span class="cal-dot"></span>' : '');
    html += `<div class="${cls.join(' ')}" data-caldate="${date}"><span class="cal-day">${d}</span>${mark}</div>`;
  }
  $('fit-cal').innerHTML = html;

  const s = fitMonthStats(y, m);
  $('fit-month-minutes').textContent = `${s.minutes} 分钟`;
  $('fit-days').textContent = `${s.days} 天`;
  renderFitStreak();
  renderFitForm();
}

function renderFitForm() {
  const rec = state.workouts[fitSelected] || { type: '', duration: 0, done: false, note: '' };
  const parts = fitSelected.split('-');
  $('fit-form-title').textContent = `${Number(parts[1])} 月 ${Number(parts[2])} 日`;
  $('fit-done').checked = !!rec.done;
  const extra = rec.type && !FIT_TYPES.includes(rec.type)
    ? `<option value="${esc(rec.type)}" selected>${esc(rec.type)}</option>` : '';
  $('fit-type').innerHTML = '<option value="">类型</option>' +
    FIT_TYPES.map(t => `<option value="${t}" ${rec.type === t ? 'selected' : ''}>${t}</option>`).join('') + extra;
  $('fit-duration').value = rec.duration ? Number(rec.duration) : '';
  $('fit-note').value = rec.note || '';
}

/* ===== 渲染：倒计时 ===== */
function renderCountdown() {
  if (document.activeElement !== $('gk-date')) $('gk-date').value = state.exams.guokao || '';
  if (document.activeElement !== $('sk-date')) $('sk-date').value = state.exams.shengkao || '';
  document.querySelectorAll('[data-cd]').forEach(el => { el.textContent = cdText(state.exams[el.dataset.cd]); });
}

/* ===== 渲染：数据 ===== */
function renderData() {
  const taskCount = state.tasks.length;
  const fitDays = Object.keys(state.workouts).filter(d => state.workouts[d].done).length;
  const bytes = (localStorage.getItem(KEY) || '').length;
  $('data-stat').textContent = `课程 ${state.courses.length} 门 · 任务 ${taskCount} 条 · 健身打卡 ${fitDays} 天 · 约 ${(bytes / 1024).toFixed(1)} KB`;
}

/* ===== 数据导出 / 导入（JSON 备份，用于跨设备同步） ===== */
function dataMsg(text) {
  const el = $('data-msg');
  if (el) el.textContent = text;
}

function exportData() {
  const payload = { app: 'studyhub', version: 1, exportedAt: new Date().toISOString(), data: state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const a = document.createElement('a');
  a.href = url;
  a.download = `学习管理-${todayStr()}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  dataMsg(`已导出 ${(blob.size / 1024).toFixed(1)} KB，文件名为「${a.download}」`);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let raw;
    try { raw = JSON.parse(String(reader.result || '')); }
    catch (e) { alert('这个文件不是有效的 JSON，导入已取消。'); return; }
    const payload = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
    if (!payload || typeof payload !== 'object' || !['courses', 'tasks', 'workouts', 'exams'].some(k => k in payload)) {
      alert('文件里没有本应用的数据（缺少 courses / tasks / workouts / exams），导入已取消。');
      return;
    }
    if (!confirm('导入会覆盖当前浏览器里的全部数据，确定继续吗？')) return;
    state = normalize(payload);
    if (!state.ui.taskDate) state.ui.taskDate = todayStr();
    // 导入的计时可能来自另一台设备的进行中状态，先结算为已累计时长，避免把间隔时间算进去
    state.tasks.forEach(t => {
      if (t.run) t.actualSeconds = elapsed(t);
      t.run = 0;
    });
    state.focus = null;
    save();
    dataMsg('导入成功，正在刷新…');
    setTimeout(() => location.reload(), 200);
  };
  reader.onerror = () => alert('读取文件失败，请重试。');
  reader.readAsText(file);
}

function renderAll() {
  renderDash();
  renderCourses();
  renderTasks();
  renderFitness();
  renderCountdown();
  renderFocus();
  renderData();
}

/* ===== 每秒实时刷新（不重建 DOM，避免打断输入） ===== */
function liveUpdate() {
  document.querySelectorAll('[data-cd]').forEach(el => { el.textContent = cdText(state.exams[el.dataset.cd]); });
  document.querySelectorAll('[data-timer]').forEach(el => {
    const t = state.tasks.find(x => x.id === el.dataset.timer);
    if (t) el.textContent = hms(elapsed(t));
  });
  document.querySelectorAll('[data-actual]').forEach(el => {
    const t = state.tasks.find(x => x.id === el.dataset.actual);
    if (t) el.textContent = hms(elapsed(t));
  });
  const study = $('d-study');
  if (study) study.textContent = durText(todayStudySec());

  // 跨天：自动切到今天并高亮
  const now = todayStr();
  if (fitToday && now !== fitToday) {
    fitToday = now;
    fitSelected = now;
    const d = parseDate(now);
    fitView = { y: d.getFullYear(), m: d.getMonth() };
    renderFitness();
  }

  // 专注倒计时
  if (state.focus) {
    const t = state.tasks.find(x => x.id === state.focus.taskId);
    if (!t || t.done) {
      state.focus = null;
      save();
      renderFocus();
    } else {
      const timeEl = $('fp-time');
      if (timeEl) timeEl.textContent = focusText(focusRemain());
      if (focusRemain() <= 0) endTaskTimer(t); // 倒计时结束自动结算
    }
  }
}

/* ===== 排程建议（贪心） ===== */
let pendingSuggest = null;

function buildSuggestion(date) {
  const free = freeSlots(date).map(x => ({ s: x.s, e: x.e }));
  const pool = state.tasks.filter(t => t.date === date && !t.done && !(t.start && t.end));
  pool.sort((a, b) =>
    (CAT_RANK[a.cat] ?? 3) - (CAT_RANK[b.cat] ?? 3) ||
    Number(a.priority) - Number(b.priority) ||
    (Number(b.est) || 60) - (Number(a.est) || 60));

  const out = [];
  for (const t of pool) {
    const need = Math.max(15, Number(t.est) || 60);
    let slot = free.find(s => s.e - s.s >= need) || free.find(s => s.e - s.s >= 15);
    if (!slot) break;
    const start = slot.s, end = Math.min(slot.s + need, slot.e);
    out.push({ id: t.id, name: t.name, start: fromMin(start), end: fromMin(end) });
    slot.s = end;
    if (slot.s >= slot.e) free.splice(free.indexOf(slot), 1);
  }
  return out;
}

/* ===== 首页智能排程（逐条采纳） ===== */
let dashSuggest = [];

function renderDashSuggest() {
  const box = $('d-suggest');
  if (!dashSuggest.length) {
    box.innerHTML = '<p class="muted">建议已全部采纳 ✓</p>';
    return;
  }
  box.innerHTML = `<div class="suggest-head"><b>排程建议</b> <span class="muted">贪心填入今日空闲段</span></div>
    <ul class="suggest-list">${dashSuggest.map(s =>
      `<li><b>${s.start}–${s.end}</b> ${esc(s.name)}
        <button class="btn ghost small" data-act="adopt-one" data-id="${s.id}">一键采纳</button></li>`).join('')}</ul>`;
}

function calcDashSuggest() {
  dashSuggest = buildSuggestion(todayStr());
  $('d-suggest').classList.remove('hidden');
  if (!dashSuggest.length) {
    $('d-suggest').innerHTML = '<p class="muted">没有可排的任务（未完成且未排时间的任务为空），或今天空闲时段不足。</p>';
    return;
  }
  renderDashSuggest();
}

function adoptOne(id) {
  const s = dashSuggest.find(x => x.id === id);
  const t = state.tasks.find(x => x.id === id);
  if (!s || !t) return;
  t.start = s.start;
  t.end = s.end;
  dashSuggest = dashSuggest.filter(x => x.id !== id);
  save();
  renderAll();
  renderDashSuggest();
}

function showSuggestion() {
  const date = state.ui.taskDate || todayStr();
  const list = buildSuggestion(date);
  pendingSuggest = list;
  const box = $('suggest-box');
  if (!list.length) {
    box.classList.remove('hidden');
    box.innerHTML = '<p class="muted">没有可排的任务（未完成且没有计划时间的任务为空），或今天空闲时段不足。</p>';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `<div class="suggest-head"><b>排程建议</b> <span class="muted">按 考公 &gt; 四级 &gt; 其他 → 优先级 → 预计时长 贪心填入空闲段</span></div>
    <ul class="suggest-list">${list.map(s => `<li><b>${s.start}–${s.end}</b> ${esc(s.name)}</li>`).join('')}</ul>
    <div class="row-gap"><button class="btn small" data-act="adopt">一键采纳</button>
    <button class="btn ghost small" data-act="dismiss">关闭</button></div>`;
}

function adoptSuggestion() {
  if (!pendingSuggest || !pendingSuggest.length) return;
  const map = {};
  pendingSuggest.forEach(s => { map[s.id] = s; });
  state.tasks.forEach(t => {
    if (map[t.id]) { t.start = map[t.id].start; t.end = map[t.id].end; }
  });
  save(); pendingSuggest = null;
  $('suggest-box').classList.add('hidden');
  renderAll();
}

/* ===== 事件：标签页 ===== */
$('tabs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  state.ui.tab = btn.dataset.tab;
  save();
  switchTab();
});

function switchTab() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.ui.tab));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + state.ui.tab));
  const hash = '#' + state.ui.tab;
  if (location.hash !== hash) {
    try { history.replaceState(null, '', hash); } catch (e) { /* file:// 下可能被限制 */ }
  }
}

/* ===== 事件：表单 ===== */
$('task-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, el = f.elements;
  const name = String(el.name.value || '').trim();
  if (!name) { alert('请填写任务名'); return; }
  const start = el.start.value || '', end = el.end.value || '';
  if (start && end && toMin(end) <= toMin(start)) { alert('计划结束时间要晚于开始时间'); return; }
  const payload = {
    id: uid(), name,
    cat: el.cat.value || 'other',
    date: el.date.value || todayStr(),
    start, end,
    priority: Number(el.priority.value) || 2,
    est: Number(el.est.value) || 60,
    done: false, actualSeconds: 0, run: 0
  };
  console.log('--- 触发了添加任务 ---', payload);
  state.tasks.push(payload);
  save();
  console.log('[sync] save() 完成，cloud.user =', cloud.user && cloud.user.email, 'client =', !!cloud.client);
  f.reset();
  el.date.value = state.ui.taskDate || todayStr();
  el.est.value = 60;
  el.priority.value = '2';
  renderAll();
});

$('course-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, el = f.elements;
  const name = String(el.name.value || '').trim();
  const start = el.start.value, end = el.end.value;
  if (!name) { alert('请填写课程名'); return; }
  if (!start || !end || toMin(end) <= toMin(start)) { alert('结束时间要晚于开始时间'); return; }
  const weekday = Number(el.weekday.value);
  const clash = state.courses.filter(c => Number(c.weekday) === weekday &&
    toMin(c.start) < toMin(end) && toMin(start) < toMin(c.end));
  if (clash.length && !confirm(`与「${clash.map(c => c.name).join('、')}」时间冲突，仍要添加吗？`)) return;
  const payload = { id: uid(), name, weekday, start, end, place: String(el.place.value || '').trim() };
  console.log('--- 触发了添加课程 ---', payload);
  state.courses.push(payload);
  save();
  console.log('[sync] save() 完成，cloud.user =', cloud.user && cloud.user.email, 'client =', !!cloud.client);
  f.reset();
  el.weekday.value = '1';
  el.start.value = '08:00';
  el.end.value = '09:40';
  renderAll();
});

$('task-date').addEventListener('change', e => {
  state.ui.taskDate = e.target.value || todayStr();
  save();
  $('suggest-box').classList.add('hidden');
  renderTasks();
  renderDash();
});

$('btn-today').addEventListener('click', () => {
  state.ui.taskDate = todayStr();
  save();
  renderTasks();
  renderDash();
});

$('btn-suggest').addEventListener('click', showSuggestion);
$('btn-dash-suggest').addEventListener('click', calcDashSuggest);

/* ===== 事件：专注计时器 ===== */
$('focus-min').addEventListener('change', e => {
  state.ui.focusMin = Math.max(5, Math.min(120, Number(e.target.value) || 25));
  e.target.value = state.ui.focusMin;
  save();
});
$('fp-toggle').addEventListener('click', () => {
  if (!state.focus) return;
  const t = state.tasks.find(x => x.id === state.focus.taskId);
  if (!t) return;
  if (t.run) pauseTaskTimer(t);
  else startTaskTimer(t); // 继续：沿用原专注倒计时
});
$('fp-stop').addEventListener('click', () => {
  if (!state.focus) return;
  const t = state.tasks.find(x => x.id === state.focus.taskId);
  if (t) endTaskTimer(t);
});

$('gk-date').addEventListener('change', e => {
  state.exams.guokao = e.target.value;
  save(); renderCountdown(); renderDash();
});
$('sk-date').addEventListener('change', e => {
  state.exams.shengkao = e.target.value;
  save(); renderCountdown(); renderDash();
});

$('btn-export').addEventListener('click', exportData);
$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (file) importData(file);
  e.target.value = '';
});

$('btn-clear').addEventListener('click', () => {
  if (!confirm('确定清空全部数据？课表、任务、计时、健身记录都会删除。')) return;
  if (!confirm('再次确认：清空后无法恢复，确定要继续吗？')) return;
  localStorage.removeItem(KEY);
  state = clone(DEFAULT);
  state.ui.taskDate = todayStr();
  save();
  renderAll();
  switchTab();
});

/* ===== 事件：健身月历与表单 ===== */
function fitRecord(date) {
  return state.workouts[date] || (state.workouts[date] = { date, type: '', duration: 0, done: false, note: '' });
}

$('fit-cal').addEventListener('click', e => {
  const cell = e.target.closest('[data-caldate]');
  if (!cell) return;
  fitSelected = cell.dataset.caldate;
  renderFitness();
});

function fitSelectVisible() {
  const prefix = `${fitView.y}-${pad(fitView.m + 1)}`;
  if (fitSelected.slice(0, 7) !== prefix) fitSelected = `${prefix}-01`;
}

$('cal-prev').addEventListener('click', () => {
  fitView.m -= 1;
  if (fitView.m < 0) { fitView.m = 11; fitView.y -= 1; }
  fitSelectVisible();
  renderFitness();
});

$('cal-next').addEventListener('click', () => {
  fitView.m += 1;
  if (fitView.m > 11) { fitView.m = 0; fitView.y += 1; }
  fitSelectVisible();
  renderFitness();
});

// 输入时长时即时更新本月统计，不重建表单（避免打断输入）
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset || el.dataset.fit !== 'duration' || !fitSelected) return;
  const rec = fitRecord(fitSelected);
  rec.duration = Math.max(0, Math.min(600, Number(el.value) || 0));
  save();
  const s = fitMonthStats(fitView.y, fitView.m);
  $('fit-month-minutes').textContent = `${s.minutes} 分钟`;
});

document.addEventListener('change', e => {
  const el = e.target;
  if (!el.dataset || !el.dataset.fit || !fitSelected) return;
  const rec = fitRecord(fitSelected);
  if (el.dataset.fit === 'done') rec.done = el.checked;
  else if (el.dataset.fit === 'duration') rec.duration = Math.max(0, Math.min(600, Number(el.value) || 0));
  else rec[el.dataset.fit] = el.value.trim();
  save();
  renderFitness();
  renderDash();
  if (state.ui.tab === 'data') renderData();
});

/* ===== 事件：点击操作 ===== */
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;

  if (act === 'adopt') { adoptSuggestion(); return; }
  if (act === 'adopt-one') { adoptOne(id); return; }
  if (act === 'dismiss') { $('suggest-box').classList.add('hidden'); pendingSuggest = null; return; }

  if (act === 'del-course') {
    const c = state.courses.find(x => x.id === id);
    if (c && confirm(`删除课程「${c.name}」？`)) {
      state.courses = state.courses.filter(x => x.id !== id);
      save(); renderAll();
    }
    return;
  }

  const t = state.tasks.find(x => x.id === id);
  if (!t) return;

  if (act === 'start') startTaskTimer(t);
  else if (act === 'pause') pauseTaskTimer(t);
  else if (act === 'stop') endTaskTimer(t);
  else if (act === 'del-task') {
    if (confirm(`删除任务「${t.name}」？`)) {
      if (state.focus && state.focus.taskId === t.id) state.focus = null;
      state.tasks = state.tasks.filter(x => x.id !== t.id);
      save(); renderAll();
    }
  }
});

/* ===== 事件：任务完成勾选 ===== */
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.act !== 'done' || !el.dataset.id) return;
  const t = state.tasks.find(x => x.id === el.dataset.id);
  if (!t) return;
  t.done = el.checked;
  if (t.done && t.run) pauseTimer(t);
  save(); renderAll();
});

/* ===== 课表点击删除 ===== */
$('week-grid').addEventListener('click', e => {
  const el = e.target.closest('[data-course]');
  if (!el) return;
  const c = state.courses.find(x => x.id === el.dataset.course);
  if (c && confirm(`删除课程「${c.name}」？`)) {
    state.courses = state.courses.filter(x => x.id !== c.id);
    save(); renderAll();
  }
});

/* ===== 启动 ===== */
(function init() {
  const TABS = ['dash', 'courses', 'tasks', 'fitness', 'data'];
  const hashTab = (location.hash || '').replace('#', '');
  if (TABS.includes(hashTab)) state.ui.tab = hashTab;
  if (!TABS.includes(state.ui.tab)) state.ui.tab = 'dash'; // 旧存档可能停在已删除的倒计时页
  if (!state.ui.taskDate) state.ui.taskDate = todayStr();
  if (!Number(state.ui.focusMin)) state.ui.focusMin = 25;
  // 专注会话指向的任务被删除/已完成时清理
  if (state.focus && !state.tasks.some(t => t.id === state.focus.taskId && !t.done)) state.focus = null;
  fitToday = todayStr();
  switchTab();
  renderAll();
  save(); // 持久化一次性迁移标记
  initCloud();
  liveUpdate();
  setInterval(liveUpdate, 1000);
})();
