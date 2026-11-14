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
// 统一日期键：所有任务日期都存成 YYYY-MM-DD，避免时间戳/时区字符串导致过滤失败
const dateOnly = s => String(s == null ? '' : s).slice(0, 10);
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
  out.date = dateOnly(out.date);
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
let taskDatePicked = false; // 用户是否手动改过“添加任务”的日期

/* ===== 云端同步（任务 / 课表 / 健身） ===== */
const FIT_OWNER_KEY = 'studyhub.fitnessOwner'; // 记住本机健身数据属于哪个账号，防止串号上传
const cloud = {
  client: null,
  user: null,
  channel: null,
  stickyChannel: null,     // 便签 / 时间胶囊 的独立 Realtime 通道
  pushing: false,
  pendingPush: false,
  pushTimer: 0,
  pullTimer: 0,
  pullPending: false,
  taskMutating: 0,
  mutationSeq: 0,
  fitnessWarned: false
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

// 右上角提醒 Toast：与底部 syncToast 同一套毛玻璃外观，只是位置和出场方向不同
// 独立节点，不与底部的 syncToast 抢同一个元素
let cornerToastTimer = 0;
function cornerToast(text, ms) {
  let el = document.getElementById('corner-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'corner-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(cornerToastTimer);
  cornerToastTimer = setTimeout(() => { el.classList.remove('show'); }, ms || 5200);
}

function taskToRow(t, uid) {
  return {
    id: t.id,
    user_id: uid,
    name: t.name,
    cat: t.cat || 'other',
    task_date: dateOnly(t.date),
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
    date: dateOnly(r.task_date),
    start: r.start_time ? String(r.start_time).slice(0, 5) : '',
    end: r.end_time ? String(r.end_time).slice(0, 5) : '',
    priority: Number(r.priority) || 2,
    est: Number(r.est) || 60,
    done: !!r.done,
    actualSeconds: Number(r.actual_seconds) || 0,
    run: 0
  };
}

/* ===== 每天重复 & 子任务（只存本机，不新增云端字段） ===== */
const openSubtasks = new Set();

function recurringDefs() {
  if (!Array.isArray(state.ui.recurring)) state.ui.recurring = [];
  return state.ui.recurring;
}

// 重复设置按账号隔离，避免换账号后把别人的重复任务带到新账号
function recurringOwner() {
  const user = (cloud.user && cloud.user.id) || (window.studyhubUser && window.studyhubUser.id);
  return user || 'local';
}

function recurringInstanceId(defId, date) {
  return 'ri_' + defId + '_' + dateOnly(date);
}

function recurringDefIdOfTask(task) {
  if (!task) return '';
  if (task.recurId) return String(task.recurId);
  const match = /^ri_(rec_[a-z0-9]+)_(\d{4}-\d{2}-\d{2})$/.exec(String(task.id || ''));
  return match ? match[1] : '';
}

function recurringDefForTask(task) {
  const id = recurringDefIdOfTask(task);
  if (!id) return null;
  return recurringDefs().find(def => def && def.id === id) || null;
}

function recurringTaskOf(def, date) {
  return {
    id: recurringInstanceId(def.id, date),
    recurId: def.id,
    name: def.name,
    cat: def.cat || 'other',
    date,
    start: def.start || '',
    end: def.end || '',
    priority: Number(def.priority) || 2,
    est: Number(def.est) || 60,
    done: false,
    actualSeconds: 0,
    run: 0
  };
}

// 每天/跨天时补齐当天实例；返回本次新增数量，由调用方决定什么时候 save
function ensureRecurringInstances() {
  const defs = recurringDefs();
  if (!defs.length) return 0;
  const today = todayStr();
  const owner = recurringOwner();
  let added = 0;

  for (const def of defs) {
    if (!def || !def.id || !def.name) continue;
    if ((def.owner || 'local') !== owner) continue;
    if (def.startDate && today < def.startDate) continue;
    if (Array.isArray(def.skipped) && def.skipped.includes(today)) continue;
    if (state.tasks.some(t => t.id === recurringInstanceId(def.id, today))) continue;
    state.tasks.push(recurringTaskOf(def, today));
    added++;
  }
  return added;
}

// 删除某一天的任务时记一笔，避免当天又被自动补回来；只清理 60 天前的记录
function skipRecurringDate(task) {
  const def = recurringDefForTask(task);
  if (!def) return;
  const date = dateOnly(task.date) || todayStr();
  def.skipped = Array.isArray(def.skipped) ? def.skipped : [];
  if (!def.skipped.includes(date)) def.skipped.push(date);
  const cutoff = addDays(todayStr(), -60);
  def.skipped = def.skipped.filter(d => d >= cutoff);
}

function stopRecurring(task) {
  const def = recurringDefForTask(task);
  if (!def) return false;
  const defs = recurringDefs();
  const index = defs.findIndex(d => d && d.id === def.id);
  if (index < 0) return false;
  defs.splice(index, 1);
  return true;
}

// 登录前创建的“本机重复任务”，第一次登录时归到当前账号，避免登录后失效
function claimLocalRecurringDefs(userId) {
  if (!userId || userId === 'local') return 0;
  let claimed = 0;
  for (const def of recurringDefs()) {
    if (def && (def.owner || 'local') === 'local') {
      def.owner = userId;
      claimed++;
    }
  }
  return claimed;
}

function subtasksOf(taskId) {
  if (!state.ui.subtasks || typeof state.ui.subtasks !== 'object' || Array.isArray(state.ui.subtasks)) {
    state.ui.subtasks = {};
  }
  const list = state.ui.subtasks[taskId];
  return Array.isArray(list) ? list.filter(s => s && typeof s === 'object') : [];
}

function addSubtask(taskId, text) {
  const value = String(text || '').trim().slice(0, 60);
  if (!taskId || !value || !state.tasks.some(t => t.id === taskId)) return false;
  const list = subtasksOf(taskId).slice();
  list.push({ id: uid(), text: value, done: false });
  state.ui.subtasks[taskId] = list;
  openSubtasks.add(taskId);
  saveLocal();
  renderTasks();
  requestAnimationFrame(() => {
    const input = document.querySelector('[data-subtask-input="' + taskId + '"]');
    if (input) input.focus();
  });
  return true;
}

function toggleSubtask(taskId, subId, done) {
  const list = subtasksOf(taskId);
  const sub = list.find(s => s && String(s.id) === String(subId));
  if (!sub) return;
  sub.done = !!done;
  saveLocal();
  renderTasks();
}

function deleteSubtask(taskId, subId) {
  if (!state.ui.subtasks || !state.ui.subtasks[taskId]) return;
  state.ui.subtasks[taskId] = subtasksOf(taskId)
    .filter(s => s && String(s.id) !== String(subId));
  if (!state.ui.subtasks[taskId].length) delete state.ui.subtasks[taskId];
  saveLocal();
  renderTasks();
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

/* 健身按「用户 + 日期」存一行，日期就是主键的一部分 */
function fitnessToRow(date, rec, uid) {
  rec = rec || {};
  return {
    user_id: uid,
    workout_date: date,
    type: rec.type || '',
    duration: Math.max(0, Math.round(Number(rec.duration) || 0)),
    done: !!rec.done,
    note: rec.note || ''
  };
}
function rowToFitness(r) {
  return {
    date: String(r.workout_date || '').slice(0, 10),
    type: r.type || '',
    duration: Number(r.duration) || 0,
    done: !!r.done,
    note: r.note || ''
  };
}
// 对象键顺序不稳定，用排序后的指纹比较健身数据是否有变化
function workoutsSig(w) {
  return Object.keys(w || {}).sort().map(d => {
    const r = w[d] || {};
    return [d, r.type || '', Number(r.duration) || 0, r.done ? 1 : 0, r.note || ''].join('|');
  }).join('\n');
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

function beginTaskMutation() {
  cloud.taskMutating++;
  cloud.mutationSeq++;
}

function endTaskMutation() {
  cloud.taskMutating = Math.max(0, cloud.taskMutating - 1);
  if (cloud.taskMutating) return;
  if (cloud.pendingPush) {
    cloud.pendingPush = false;
    schedulePush();
    // 让下一次 push 的 finally 处理 pullPending，避免 push 未完成就被拉取覆盖
    return;
  }
  if (cloud.pullPending) {
    cloud.pullPending = false;
    pullCloud();
  }
}

function waitForPushIdle() {
  if (!cloud.pushing) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (!cloud.pushing) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}

// 添加任务：本地先渲染，再显式 insert 云端，成功后用服务端返回行回写 state.tasks
async function addTask(task) {
  if (!task) return null;
  const manual = !!task.dateManual;
  const rawDate = dateOnly(task.date);
  const date = manual && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : todayStr();
  delete task.dateManual;
  task.date = date;
  state.ui.taskDate = date; // 任务列表切到新增任务的日期，添加后立即可见
  console.log('--- 添加任务（已规整日期）---', task);

  beginTaskMutation();
  try {
    state.tasks.push(task);
    saveLocal();
    renderDash();
    renderTasks();
    renderHeatmap();

    if (!cloud.user) await ensureCloudUser();
    if (!cloud.client || !cloud.user) {
      if (task.date !== todayStr()) syncToast(`任务已保存到 ${task.date}，仪表盘只显示今天的任务`);
      return task;
    }

    await waitForPushIdle(); // 等旧 push 结束，避免它的删除阶段把刚插入的任务删掉
    const { data, error } = await cloud.client
      .from('tasks')
      .insert(taskToRow(task, cloud.user.id))
      .select();
    if (error) throw error;

    const savedRow = Array.isArray(data) && data.length ? data[0] : null;
    if (savedRow) {
      const saved = rowToTask(savedRow);
      const i = state.tasks.findIndex(x => x.id === task.id);
      const current = i >= 0 ? state.tasks[i] : task;
      const merged = Object.assign({}, saved, {
        run: current.run || 0,
        actualSeconds: Number(current.actualSeconds) || 0
      });
      if (i >= 0) state.tasks[i] = merged;
      else state.tasks.push(merged);
    }
    saveLocal();
    renderDash();
    renderTasks();
    renderHeatmap();
    syncToast('任务已同步到云端' +
      (task.date === todayStr() ? '' : `（日期 ${task.date}，非今天）`));
    return state.tasks.find(x => x.id === task.id) || task;
  } catch (err) {
    console.error('[task] add failed', err);
    state.tasks = state.tasks.filter(x => x.id !== task.id);
    saveLocal();
    renderDash();
    renderTasks();
    renderHeatmap();
    const extra = [err && err.message, err && err.code, err && err.hint].filter(Boolean).join(' · ');
    syncError('任务添加失败：' + (extra || '请检查网络或 RLS'));
    syncToast('任务添加失败：' + (extra || '请检查网络或 RLS'));
    return null;
  } finally {
    endTaskMutation();
  }
}

// 删除任务：先锁定拉取，再本地移除 + 云端 delete，失败则回滚
async function deleteTask(task) {
  if (!task) return false;
  const index = state.tasks.findIndex(x => x.id === task.id);
  if (index < 0) return false;

  const prevFocus = state.focus ? { ...state.focus } : null;
  const prevSubtasks = state.ui.subtasks && typeof state.ui.subtasks === 'object'
    ? state.ui.subtasks[task.id]
    : undefined;
  beginTaskMutation();
  try {
    if (task.run) pauseTimer(task);
    skipRecurringDate(task);
    openSubtasks.delete(task.id);
    state.tasks.splice(index, 1);
    if (state.ui.subtasks && typeof state.ui.subtasks === 'object') delete state.ui.subtasks[task.id];
    if (state.focus && state.focus.taskId === task.id) state.focus = null;
    saveLocal();
    renderDash();
    renderTasks();
    renderFocus();
    renderHeatmap();

    if (!cloud.user) await ensureCloudUser();
    if (!cloud.client || !cloud.user) {
      syncToast('任务已在本地删除');
      return true;
    }

    await waitForPushIdle(); // 等旧 push 结束，避免它把刚删的任务又 upsert 回来
    const { error } = await cloud.client
      .from('tasks')
      .delete()
      .eq('id', task.id)
      .eq('user_id', cloud.user.id);
    if (error) throw error;

    syncToast('任务已从云端删除');
    return true;
  } catch (err) {
    console.error('[task] delete failed', err);
    state.tasks.push(task);
    if (prevFocus) state.focus = prevFocus;
    if (prevSubtasks && state.ui.subtasks && typeof state.ui.subtasks === 'object') {
      state.ui.subtasks[task.id] = prevSubtasks;
    }
    saveLocal();
    renderDash();
    renderTasks();
    renderFocus();
    renderHeatmap();
    const extra = [err && err.message, err && err.code, err && err.hint].filter(Boolean).join(' · ');
    syncError('任务删除失败：' + (extra || '请检查网络或 RLS'));
    syncToast('任务删除失败：' + (extra || '请检查网络或 RLS'));
    return false;
  } finally {
    endTaskMutation();
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
  if (cloud.taskMutating) { cloud.pendingPush = true; return; }
  if (cloud.pushing) { cloud.pendingPush = true; return; }
  cloud.pushing = true;
  const uid = cloud.user.id;
  let taskRows = [];
  let courseRows = [];
  let fitnessRows = [];
  const fitOwner = localStorage.getItem(FIT_OWNER_KEY);
  const canSyncFitness = !fitOwner || fitOwner === uid; // 换账号后先等 pull 替换本机数据
  try {
    taskRows = state.tasks.map(t => taskToRow(t, uid));
    courseRows = state.courses.map(c => courseToRow(c, uid));
    if (canSyncFitness) {
      fitnessRows = Object.keys(state.workouts)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) // 只同步合法日期，避免脏键导致整批失败
        .map(d => fitnessToRow(d, state.workouts[d], uid));
    }
    console.info('[sync] push', {
      uid, tasks: taskRows.length, courses: courseRows.length, fitness: fitnessRows.length
    });

    if (taskRows.length) {
      const { error } = await cloud.client.from('tasks').upsert(taskRows, { onConflict: 'id' });
      if (error) throw error;
    }
    if (courseRows.length) {
      const { error } = await cloud.client.from('courses').upsert(courseRows, { onConflict: 'id' });
      if (error) throw error;
    }

    // 健身记录只 upsert，不删除云端旧行（本模块没有删除入口，避免旧设备误删另一端的新打卡）
    if (fitnessRows.length) {
      try {
        const { error } = await cloud.client.from('fitness')
          .upsert(fitnessRows, { onConflict: 'user_id,workout_date' });
        if (error) throw error;
        localStorage.setItem(FIT_OWNER_KEY, uid);
        cloud.fitnessWarned = false;
      } catch (fitErr) {
        console.error('[sync] fitness push failed', fitErr);
        if (!cloud.fitnessWarned) {
          cloud.fitnessWarned = true;
          syncError('健身数据同步失败：' + (fitErr.message || '请先执行 fitness 建表 SQL'));
        }
      }
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
  if (cloud.taskMutating) { cloud.pullPending = true; return; }
  const uid = cloud.user.id;
  const seq = cloud.mutationSeq;
  try {
    const [tRes, cRes, fRes] = await Promise.all([
      cloud.client.from('tasks').select('*').eq('user_id', uid).order('created_at', { ascending: true }),
      cloud.client.from('courses').select('*').eq('user_id', uid).order('created_at', { ascending: true }),
      cloud.client.from('fitness').select('*').eq('user_id', uid).order('workout_date', { ascending: true })
    ]);
    if (tRes.error) throw tRes.error;
    if (cRes.error) throw cRes.error;

    // 拉取过程中如果开始了任务增删，丢弃这次旧快照，避免覆盖本地新状态
    if (cloud.taskMutating || seq !== cloud.mutationSeq) {
      cloud.pullPending = true;
      return;
    }

    // 健身表缺失 / RLS 未配置时，只提示健身，不拖垮任务和课表的同步
    const fitnessOk = !fRes.error;
    if (!fitnessOk) {
      console.warn('[sync] fitness pull failed', fRes.error);
      if (!cloud.fitnessWarned) {
        cloud.fitnessWarned = true;
        syncError('健身数据读取失败：' + (fRes.error.message || '请检查 fitness 表和 RLS 策略'));
      }
    } else {
      cloud.fitnessWarned = false;
    }

    const cloudTasks = (tRes.data || []).map(rowToTask);
    const cloudCourses = (cRes.data || []).map(rowToCourse);
    const cloudWorkouts = {};
    (fRes.data || []).forEach(r => {
      const w = rowToFitness(r);
      if (w.date) cloudWorkouts[w.date] = w;
    });
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

    // 健身：同账号合并本机独有记录（首次上线会自动补传）；换账号时以云端为准，避免串号
    let mergedWorkouts = state.workouts;
    let needFitPush = false;
    if (fitnessOk) {
      const owner = localStorage.getItem(FIT_OWNER_KEY);
      const sameAccount = !owner || owner === uid;
      mergedWorkouts = Object.assign({}, cloudWorkouts);
      if (sameAccount) {
        Object.keys(state.workouts).forEach(d => {
          if (!mergedWorkouts[d]) mergedWorkouts[d] = state.workouts[d];
        });
        needFitPush = Object.keys(state.workouts).some(d => !cloudWorkouts[d]);
      }
    }

    const changed = JSON.stringify(mergedTasks) !== JSON.stringify(state.tasks) ||
      JSON.stringify(cloudCourses) !== JSON.stringify(state.courses) ||
      workoutsSig(mergedWorkouts) !== workoutsSig(state.workouts);

    state.tasks = mergedTasks;
    state.courses = cloudCourses;
    state.workouts = mergedWorkouts;
    if (fitnessOk) localStorage.setItem(FIT_OWNER_KEY, uid);
    const addedRecurring = ensureRecurringInstances(); // 云端快照里可能没有今天刚补的重复任务
    saveLocal();
    if (changed || forceRender || addedRecurring) renderAll();
    if (needFitPush || addedRecurring) schedulePush(); // 本机有、云端没有的打卡/重复任务，拉取后补推
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
  if (cloud.pushing || cloud.taskMutating) { cloud.pullPending = true; return; }
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fitness', filter: `user_id=eq.${uid}` }, onRemoteChange)
    .subscribe();
}

/* ---- 便签 / 时间胶囊：独立的 Realtime 通道，与上面的任务通道互不影响 ---- */
function subscribeStickyRealtime() {
  if (!cloud.client || !cloud.user) return;
  if (cloud.stickyChannel) { cloud.client.removeChannel(cloud.stickyChannel); cloud.stickyChannel = null; }
  const uid = cloud.user.id;
  // 本端刚改过时忽略自己触发的回声，避免抖动
  const ignore = () => stickySync.pending.size > 0 || stickySync.loading;
  cloud.stickyChannel = cloud.client
    .channel('studyhub-stickies-' + uid)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stickies', filter: `user_id=eq.${uid}` },
      () => { if (!ignore()) stickyPull(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'time_capsules', filter: `user_id=eq.${uid}` },
      () => { if (!ignore()) capsulePull(); })
    .subscribe();
}

function handleAuthUser(user) {
  const prevId = cloud.user && cloud.user.id;
  cloud.user = user || null;
  if (!user) {
    if (cloud.client && cloud.channel) { cloud.client.removeChannel(cloud.channel); cloud.channel = null; }
    if (cloud.client && cloud.stickyChannel) { cloud.client.removeChannel(cloud.stickyChannel); cloud.stickyChannel = null; }
    onMoodAuth(null);
    onPlansAuth(null);
    stickyResetLocal();
    capsuleResetLocal();
    return;
  }
  if (prevId !== user.id) {
    console.info('[sync] signed in as', user.id, user.email);
    const signedInId = user.id;
    if (claimLocalRecurringDefs(user.id)) saveLocal();
    cloud.fitnessWarned = false;
    pullCloud(true).then(() => {
      // 拉取失败/被任务操作延后时，也保证今天的重复任务能出现
      if (!cloud.user || cloud.user.id !== signedInId) return;
      if (cloud.taskMutating) return;
      if (ensureRecurringInstances() > 0) {
        save();
        renderAll();
      }
    });
    subscribeRealtime();
    onMoodAuth(user);
    onPlansAuth(user);
    // 便签与时间胶囊：登录后拉云端（云端为空则自动迁移本机数据）
    stickyPull();
    capsulePull();
    subscribeStickyRealtime();
  }
}

function initCloud() {
  const bind = () => {
    if (!window.studyhubClient) return false;
    cloud.client = window.studyhubClient;
    cloud.client.auth.getSession().then(({ data }) => {
      const user = data && data.session && data.session.user;
      handleAuthUser(user);
      if (user) syncToast('已连接云端，任务、课表和健身会自动同步');
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

/* ===== 心情树洞（moods 表：全部记录） ===== */
const MOOD_TEXT_MAX = 120;
let moodRows = [];
let moodLoading = false;
let moodSeq = 0; // 增删期间丢弃迟到的旧查询结果

const moodCacheKey = uid => 'studyhub.moods.' + uid;

function moodClient() {
  return cloud.client || window.studyhubClient || null;
}

// 按账号缓存全部记录，刷新页面时先显示缓存，再等云端覆盖
function moodCacheRead(uid) {
  try {
    const rows = JSON.parse(localStorage.getItem(moodCacheKey(uid)) || '[]');
    return Array.isArray(rows) ? rows.filter(r => r && r.content) : [];
  } catch (e) {
    return [];
  }
}
function moodCacheWrite(uid, rows) {
  if (!uid) return;
  try { localStorage.setItem(moodCacheKey(uid), JSON.stringify(rows || [])); }
  catch (e) { /* 隐私模式或配额不足时忽略 */ }
}

function moodTimeText(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = todayStr(d);
  if (day === todayStr()) return `今天 ${hm}`;
  if (day === addDays(todayStr(), -1)) return `昨天 ${hm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

function moodMsg(text, ok) {
  const el = $('mood-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function moodErrorText(err) {
  const msg = (err && err.message) || '未知错误';
  if (/relation .*moods.* does not exist|Could not find the table|schema cache/i.test(msg)) {
    return 'moods 表还没建好：先在 Supabase SQL Editor 执行 supabase-moods.sql';
  }
  if (/row-level security|permission denied|violates row-level/i.test(msg)) {
    return '心情表权限不足：请检查 moods 表的 RLS 策略';
  }
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)) {
    return '无法连接云端，请检查网络后再试';
  }
  return '操作失败：' + msg;
}

/* ===== 情绪树：纯前端高频词提取 ===== */
const MOOD_STOP_WORDS = new Set([
  '今天', '但是', '我们', '自己', '觉得', '然后', '现在', '已经', '因为', '所以',
  '如果', '可以', '这个', '那个', '什么', '时候', '还是', '一个', '没有', '就是',
  '不是', '这么', '那么', '真的', '有点', '一些', '感觉', '心情', '碎碎念', '记录',
  '每天', '生活', '事情', '东西', '这里', '那里', '这样', '那样', '可能', '应该',
  '知道', '看到', '想到', '还有', '而且', '虽然', '不过', '只是', '比较', '非常',
  '特别', '一直', '总是', '其实', '开始', '结束', '起来', '下去', '出来', '进去',
  '我的', '你的', '他的', '她的', '它的', '地方', '一天', '今晚', '明天', '昨天',
  '上午', '下午', '晚上', '最近', '一点', '很多', '很少', '这种', '那种', '不能',
  '不会', '不要', '不用', '好多', '一样', '一起', '之后', '之前', '后来', '于是'
]);

function hashMoodWord(word) {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function extractMoodWords(text) {
  const source = String(text || '');
  const words = [];
  const debug = { segmented: false, mode: '', raw: 0, kept: 0, err: '' };

  // ① 优先用浏览器原生分词；但必须校验它“真的产出了词”，
  //    移动端（iOS Safari / 微信内核）存在 Segmenter 可用却返回空 / 全是非单词项的情况，
  //    以前只要不抛错就把 segmented 置 true，结果直接返回空数组，树就光秃秃了。
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      let segmenter = null;
      // 部分内核只认 'zh-CN' / undefined（按系统语言），逐个兜底
      for (const loc of ['zh', 'zh-CN', undefined]) {
        try {
          segmenter = new Intl.Segmenter(loc, { granularity: 'word' });
          break;
        } catch (err) {
          segmenter = null;
        }
      }
      if (segmenter) {
        for (const part of segmenter.segment(source)) {
          if (!part || !part.isWordLike) continue;
          const word = String(part.segment || '').trim();
          if (/^[\u4e00-\u9fa5]{2,}$/.test(word) && !MOOD_STOP_WORDS.has(word)) {
            words.push(word);
            debug.raw++;
          }
        }
      }
    } catch (err) {
      debug.err = String((err && err.message) || err);
    }
  }

  // ② 原生分词没产出任何词（不支持 / 词典缺失 / 只切出单个字）→ 退回双字 + 单字滑窗
  if (!words.length) {
    debug.mode = 'fallback';
    const runs = source.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (const run of runs) {
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i <= run.length - n; i++) {
          const word = run.slice(i, i + n);
          if (!MOOD_STOP_WORDS.has(word)) { words.push(word); debug.raw++; }
        }
      }
    }
    // ③ 还是空（比如原文全是停用词 / 全是英文）：至少把单字也当候选，保证树上有内容
    if (!words.length) {
      debug.mode = 'single';
      const chars = source.match(/[\u4e00-\u9fa5]/g) || [];
      for (const ch of chars) {
        if (!MOOD_STOP_WORDS.has(ch)) { words.push(ch); debug.raw++; }
      }
    }
  } else {
    debug.mode = 'segmenter';
  }

  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  const result = Array.from(counts, ([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, 'zh'))
    .slice(0, 10);
  debug.kept = result.length;
  // 现场诊断：控制台执行 studyhubMoods.debugWords() 可看到下面这行
  console.log('[mood-tree] 分词:', debug.mode, '| 候选', debug.raw, '| 保留', debug.kept,
    debug.err ? ('| error: ' + debug.err) : '', result);
  return result;
}

function renderMoodTree() {
  const cloud = $('mood-tree-cloud');
  if (!cloud) return;

  // 只看历史总条数，不判断“今天有没有写”
  const total = moodRows.length;

  // 正在从云端拉历史时，先显示唤醒提示，避免被误判成光秃秃的空树
  if (moodLoading && total < 3) {
    cloud.innerHTML = '<p class="mood-tree-empty">正在唤醒你的情绪树…</p>';
    return;
  }

  if (total < 3) {
    cloud.innerHTML = '<p class="mood-tree-empty">继续记录碎碎念，让这棵树长满叶子吧~</p>';
    return;
  }

  // 历史很多时只取最近 100 条，避免一次性处理过多文本
  const history = moodRows.slice(0, 100);
  const source = history.map(m => String(m && m.content || '')).join('\n');
  let words = [];
  try {
    words = extractMoodWords(source);
  } catch (err) {
    console.error('[mood-tree] 分词异常，已兜底', err);
    words = [];
  }

  // 兜底：有 ≥3 条记录却一个词都没提取到，直接把最近几条原文截断当“词”显示，别让树空着
  if (!words.length) {
    const fallback = history.map(m => String(m && m.content || '').trim()).filter(Boolean).slice(0, 6);
    words = fallback.map(t => ({ word: t.length > 6 ? t.slice(0, 6) : t, count: 1 }));
    if (words.length) console.warn('[mood-tree] 未提取到词语，回退显示原文片段', words);
  }

  if (!words.length) {
    cloud.innerHTML = '<p class="mood-tree-empty">继续记录碎碎念，让这棵树长满叶子吧~</p>';
    return;
  }

  const max = words[0].count;
  const min = words[words.length - 1].count;
  const range = max - min;

  cloud.innerHTML = words.map((item, i) => {
    const seed = hashMoodWord(item.word);
    const angle = (i * 137.5 + (seed % 29)) * Math.PI / 180;
    const radius = 10 + i * 2.7 + (seed % 4);
    const x = Math.min(88, Math.max(12, 50 + Math.cos(angle) * radius * 1.05));
    const y = Math.min(70, Math.max(18, 44 + Math.sin(angle) * radius * 0.72));
    // 字号 12~24px 按词频插值；全部同频时取中间值 18px
    const size = range > 0 ? Math.round(12 + ((item.count - min) / range) * 12) : 18;
    const rot = ((seed >> 3) % 9) - 4;
    const title = `${item.word} · 出现 ${item.count} 次`;
    return `<span class="mood-tree-word" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;font-size:${Math.max(12, Math.min(24, size))}px;--rot:${rot}deg" title="${esc(title)}">${esc(item.word)}</span>`;
  }).join('');
  console.log('[mood-tree] 渲染', words.length, '个词，记录数', total);
}

function renderMoods() {
  const list = $('mood-list');
  if (!list) return;
  renderMoodTree();
  const count = $('mood-count');
  if (count) count.textContent = `${moodRows.length} 条`;
  const sub = $('mood-sub');
  if (sub) {
    sub.textContent = cloud.user
      ? '今天的情绪，也值得被轻轻记下来。'
      : '登录后，可以把心情说给树洞听。';
  }
  if (!moodRows.length) {
    list.innerHTML = `<li class="mood-empty">${cloud.user ? '还没有记录，写下第一条碎碎念吧 🌿' : '登录后即可查看你的碎碎念'}</li>`;
    return;
  }
  list.innerHTML = moodRows.map(m => `<li class="mood-item">
      <p class="mood-text">${esc(m.content)}</p>
      <div class="mood-foot">
        <span class="mood-time">${esc(moodTimeText(m.created_at))}</span>
        <button class="mood-del" type="button" data-mood-del="${esc(m.id)}" title="删除这条记录" aria-label="删除这条心情">×</button>
      </div>
    </li>`).join('');
}

async function loadMoods(force) {
  // force = 强制执行一次云端拉取（移动端切回碎碎念时用，避免只显示旧缓存）
  moodLoading = true;
  renderMoods();

  if (!cloud.user) await ensureCloudUser();
  const uid = cloud.user && cloud.user.id;
  if (!uid) {
    moodLoading = false;
    moodRows = [];
    renderMoods();
    return;
  }

  moodRows = moodCacheRead(uid);
  renderMoods();

  const client = moodClient();
  if (!client) {
    moodLoading = false;
    renderMoods();
    return;
  }
  const seq = moodSeq;
  try {
    const { data, error } = await client.from('moods')
      .select('id, content, created_at')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (seq !== moodSeq) return; // 查询期间发生了增删，丢弃这份旧快照
    if (!cloud.user || cloud.user.id !== uid) return; // 请求期间切换了账号
    moodLoading = false;
    moodRows = Array.isArray(data) ? data : [];
    moodCacheWrite(uid, moodRows);
    renderMoods();
    moodMsg('');
    if (force) console.log('[mood] 强制刷新完成，记录数', moodRows.length);
  } catch (err) {
    console.warn('[mood] load failed', err);
    if (seq === moodSeq) {
      moodLoading = false;
      if (!moodRows.length) moodMsg(moodErrorText(err));
      renderMoods();
    }
  } finally {
    // 任何分支都不让“正在唤醒”卡住：卡住时树会一直显示加载提示
    if (moodLoading) {
      moodLoading = false;
      renderMoods();
    }
  }
}

async function addMood(raw) {
  const content = String(raw || '').trim().slice(0, MOOD_TEXT_MAX);
  if (!content) { moodMsg('先写一句心情再记录哦'); return; }
  const btn = $('mood-submit');
  if (btn && btn.disabled) return;

  if (!cloud.user) await ensureCloudUser();
  if (!cloud.user) { moodMsg('登录后才能把心情写进树洞'); return; }
  const client = moodClient();
  if (!client) { moodMsg('云端还没连上，稍后再试'); return; }
  const uid = cloud.user.id;

  moodSeq++;
  if (btn) btn.disabled = true;
  moodMsg('正在记录…');
  try {
    const { data, error } = await client.from('moods')
      .insert({ user_id: uid, content })
      .select('id, content, created_at')
      .single();
    if (error) throw error;
    if (!data) throw new Error('云端没有返回这条记录');
    if (!cloud.user || cloud.user.id !== uid) return;

    moodLoading = false;
    moodRows = [data].concat(moodRows.filter(m => String(m.id) !== String(data.id)));
    moodCacheWrite(uid, moodRows);
    const input = $('mood-input');
    if (input) input.value = '';
    renderMoods();
    moodMsg('已经收好啦 🌱', true);
    syncToast('心情已收进树洞');
  } catch (err) {
    console.error('[mood] insert failed', err);
    const text = moodErrorText(err);
    moodMsg(text);
    syncError(text);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteMood(id) {
  const index = moodRows.findIndex(m => String(m.id) === String(id));
  if (index < 0) return;
  if (!confirm('删除这条心情记录？')) return;

  const row = moodRows[index];
  const backup = moodRows.slice();
  moodSeq++;
  moodLoading = false;
  moodRows = moodRows.filter((_, i) => i !== index);
  renderMoods();

  if (!cloud.user) await ensureCloudUser();
  const client = moodClient();
  if (!cloud.user || !client) {
    moodRows = backup;
    renderMoods();
    moodMsg('登录后才能删除心情');
    return;
  }
  const uid = cloud.user.id;
  try {
    const { error } = await client.from('moods').delete().eq('id', row.id).eq('user_id', uid);
    if (error) throw error;
    moodCacheWrite(uid, moodRows);
    moodMsg('已删除', true);
  } catch (err) {
    console.error('[mood] delete failed', err);
    moodRows = backup;
    renderMoods();
    const text = moodErrorText(err);
    moodMsg(text);
    syncError(text);
  }
}

// 登录状态变化时由 handleAuthUser 调用
function onMoodAuth(user) {
  if (!user) {
    moodLoading = false;
    moodRows = [];
    renderMoods();
    moodMsg('');
    return;
  }
  loadMoods();
}

function initMoods() {
  const form = $('mood-form');
  const list = $('mood-list');
  if (!form || !list) return;

  form.addEventListener('submit', e => {
    e.preventDefault();
    addMood($('mood-input').value);
  });

  const input = $('mood-input');
  if (input) {
    input.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        addMood(input.value);
      }
    });
  }

  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-mood-del]');
    if (btn) deleteMood(btn.dataset.moodDel);
  });

  // 先进入“唤醒中”，避免登录状态还没就绪时树被误显示成空树
  moodLoading = true;
  renderMoods();
  // 启动时主动拉一次：移动端常因为首屏慢、登录回调晚而拿到空数据
  loadMoods(true);
  // 兜底解锁：8 秒还没拿到用户就不再显示“正在唤醒”
  setTimeout(() => {
    if (moodLoading && !cloud.user && !window.studyhubUser) {
      moodLoading = false;
      renderMoods();
    }
  }, 8000);
}

// 移动端诊断入口：控制台执行 studyhubMoods.debugWords() 查看分词结果
function moodDebugWords() {
  const texts = moodRows.map(m => String(m && m.content || ''));
  const source = texts.slice(0, 100).join('\n');
  const words = extractMoodWords(source);
  const info = {
    records: moodRows.length,
    joinedLength: source.length,
    recordsPreview: texts.slice(0, 3),
    hasIntl: typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function',
    words,
    treeHtmlLength: ($('mood-tree-cloud') || {}).innerHTML ? $('mood-tree-cloud').innerHTML.length : 0
  };
  console.log('[mood-debug]', JSON.stringify(info, null, 2));
  return info;
}

window.studyhubMoods = { reload: loadMoods, add: addMood, debugWords: moodDebugWords };


/* ===== 长期计划（plans 表：CRUD 直连 Supabase） ===== */
let planRows = [];
let plansLoaded = false;
let plansLoading = false;
let plansSeq = 0;

function plansClient() {
  return cloud.client || window.studyhubClient || null;
}

function plansMsg(text, ok) {
  const el = $('plans-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function plansErrorText(err) {
  const msg = (err && err.message) || '未知错误';
  if (/relation .*plans.* does not exist|Could not find the table|schema cache/i.test(msg)) {
    return 'plans 表还没建好：先在 Supabase SQL Editor 执行 supabase-plans.sql';
  }
  if (/row-level security|permission denied|violates row-level/i.test(msg)) {
    return '长期计划表权限不足：请检查 plans 表的 RLS 策略';
  }
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)) {
    return '无法连接云端，请检查网络后再试';
  }
  return '操作失败：' + msg;
}

function sortPlans(rows) {
  return rows.slice().sort((a, b) =>
    String(a.start_date || '').localeCompare(String(b.start_date || '')) ||
    String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function planDateText(plan) {
  const start = dateOnly(plan.start_date);
  const end = dateOnly(plan.end_date);
  if (!start || !end) return { range: '—', sub: '' };
  const s = parseDate(start);
  const e = parseDate(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return { range: '—', sub: '' };
  const range = `${pad(s.getMonth() + 1)}/${pad(s.getDate())} - ${pad(e.getMonth() + 1)}/${pad(e.getDate())}`;
  const years = s.getFullYear() === e.getFullYear()
    ? String(s.getFullYear())
    : `${s.getFullYear()} - ${e.getFullYear()}`;
  const days = Math.max(1, Math.round((e - s) / 86400000) + 1);
  return { range, sub: `${years} · ${days} 天` };
}

function planStatus(plan) {
  const today = todayStr();
  const start = dateOnly(plan.start_date);
  const end = dateOnly(plan.end_date);
  if (start && today < start) return { key: 'upcoming', text: '未开始' };
  if (end && today > end) return { key: 'ended', text: '已结束' };
  return { key: 'active', text: '进行中' };
}

function renderPlans() {
  const box = $('plans-timeline');
  if (!box) return;
  const hint = $('plans-hint');
  const user = cloud.user || window.studyhubUser;

  if (!user) {
    box.classList.add('is-empty');
    box.innerHTML = plansLoaded
      ? '<p class="plan-empty">登录后即可安排长期计划，并同步到云端。</p>'
      : '<p class="plan-empty">正在准备…</p>';
    if (hint) hint.textContent = plansLoaded ? '登录后同步到云端' : '按开始日期排列';
    return;
  }

  if (plansLoading && !planRows.length) {
    box.classList.add('is-empty');
    box.innerHTML = '<p class="plan-empty">正在读取云端计划…</p>';
    if (hint) hint.textContent = '同步中…';
    return;
  }

  if (!plansLoaded && !planRows.length) {
    box.classList.add('is-empty');
    box.innerHTML = '<p class="plan-empty">正在准备…</p>';
    if (hint) hint.textContent = '按开始日期排列';
    return;
  }

  if (!planRows.length) {
    box.classList.add('is-empty');
    box.innerHTML = '<p class="plan-empty">还没有阶段，点上面的“添加新阶段”开始吧 🌱</p>';
    if (hint) hint.textContent = '按开始日期排列';
    return;
  }

  box.classList.remove('is-empty');
  if (hint) hint.textContent = `${planRows.length} 个阶段 · 按开始日期排列`;
  box.innerHTML = planRows.map(plan => {
    const status = planStatus(plan);
    const dateText = planDateText(plan);
    const completed = !!plan.is_completed;
    const detail = String(plan.detail || '').trim();
    return `<div class="plan-item ${status.key}${completed ? ' is-completed' : ''}">
      <article class="plan-card">
        <div class="plan-date">
          <span class="plan-date-range">${dateText.range}</span>
          <span class="plan-date-sub">${dateText.sub}</span>
        </div>
        <div class="plan-main">
          <div class="plan-head">
            <h3 class="plan-title">${esc(plan.title || '未命名阶段')}</h3>
            <div class="plan-tags">
              <span class="plan-status ${status.key}">${status.text}</span>
              ${completed ? '<span class="plan-completed">✓ 已完成</span>' : ''}
            </div>
          </div>
          <p class="plan-detail${detail ? '' : ' is-empty'}">${detail ? esc(detail) : '还没有填写核心任务'}</p>
          <div class="plan-actions">
            <button class="plan-btn done${completed ? ' is-done' : ''}" type="button"
              data-plan-act="toggle" data-id="${esc(plan.id)}"
              title="${completed ? '点击取消完成' : '标记为已完成'}">${completed ? '✓ 已完成' : '标记为已完成'}</button>
            <button class="plan-btn del" type="button" data-plan-act="del" data-id="${esc(plan.id)}">删除</button>
          </div>
        </div>
      </article>
    </div>`;
  }).join('');
}

async function loadPlans() {
  const seq = ++plansSeq;
  if (!cloud.user) await ensureCloudUser();
  if (seq !== plansSeq) return;
  const userId = cloud.user && cloud.user.id;
  if (!userId) {
    planRows = [];
    plansLoaded = true;
    plansLoading = false;
    plansMsg('');
    renderPlans();
    return;
  }

  plansLoading = true;
  renderPlans();
  try {
    const client = plansClient();
    if (!client) throw new Error('云端还没连上');
    const { data, error } = await client.from('plans')
      .select('*')
      .eq('user_id', userId)
      .order('start_date', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (seq !== plansSeq) return;
    if (!cloud.user || cloud.user.id !== userId) return;
    planRows = sortPlans(Array.isArray(data) ? data : []);
    plansLoaded = true;
    plansMsg('');
  } catch (err) {
    console.warn('[plans] load failed', err);
    if (seq === plansSeq) {
      plansLoaded = true;
      plansMsg(plansErrorText(err));
    }
  } finally {
    if (seq === plansSeq) {
      plansLoading = false;
      renderPlans();
    }
  }
}

function onPlansAuth(user) {
  if (!user) {
    planRows = [];
    plansLoaded = true;
    plansLoading = false;
    plansMsg('');
    renderPlans();
    return;
  }
  plansMsg('');
  loadPlans();
}

function resetPlanForm() {
  const form = $('plan-form');
  if (!form) return;
  form.reset();
  form.elements.start.value = todayStr();
  form.elements.end.value = addDays(todayStr(), 14);
}

function closePlanForm() {
  const panel = $('plan-form-panel');
  const active = document.activeElement;
  const shouldFocus = !!(panel && active && panel.contains(active));
  setFormPanel('plan-form-panel', 'plan-form-toggle', false);
  const toggle = $('plan-form-toggle');
  if (shouldFocus && toggle) toggle.focus();
}

async function submitPlan(e) {
  e.preventDefault();
  const form = e.target;
  const el = form.elements;
  const title = String(el.title.value || '').trim();
  const start = dateOnly(el.start.value);
  const end = dateOnly(el.end.value);
  const detail = String(el.detail.value || '').trim().slice(0, 300);
  if (!title) { plansMsg('请填写阶段名称'); return; }
  if (!start || !end) { plansMsg('请选择起止日期'); return; }
  if (end < start) { plansMsg('结束日期不能早于开始日期'); return; }

  if (!cloud.user) await ensureCloudUser();
  const userId = cloud.user && cloud.user.id;
  const client = plansClient();
  if (!userId || !client) { plansMsg('登录后才能保存到云端'); return; }

  const btn = form.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  plansMsg('正在保存…');
  try {
    const row = {
      id: uid(),
      user_id: userId,
      title,
      start_date: start,
      end_date: end,
      detail,
      is_completed: false
    };
    const { data, error } = await client.from('plans').insert(row).select().single();
    if (error) throw error;
    planRows = sortPlans(planRows.concat(data || row));
    plansLoaded = true;
    closePlanForm();
    resetPlanForm();
    renderPlans();
    plansMsg('阶段已添加 🌱', true);
  } catch (err) {
    console.error('[plans] insert failed', err);
    plansMsg(plansErrorText(err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '添加阶段'; }
  }
}

async function togglePlanComplete(id) {
  const plan = planRows.find(p => String(p.id) === String(id));
  if (!plan) return;
  const next = !plan.is_completed;
  plan.is_completed = next;
  renderPlans();
  try {
    if (!cloud.user) await ensureCloudUser();
    const client = plansClient();
    if (!client || !cloud.user) throw new Error('登录后才能同步');
    const { error } = await client.from('plans')
      .update({ is_completed: next })
      .eq('id', plan.id)
      .eq('user_id', cloud.user.id);
    if (error) throw error;
    plansMsg(next ? '已标记为完成 ✓' : '已取消完成', true);
  } catch (err) {
    console.warn('[plans] update failed', err);
    plan.is_completed = !next;
    renderPlans();
    plansMsg(plansErrorText(err));
  }
}

async function deletePlan(id) {
  const index = planRows.findIndex(p => String(p.id) === String(id));
  if (index < 0) return;
  const plan = planRows[index];
  if (!confirm(`删除阶段「${plan.title || '未命名阶段'}」？`)) return;
  planRows.splice(index, 1);
  renderPlans();
  try {
    if (!cloud.user) await ensureCloudUser();
    const client = plansClient();
    if (!client || !cloud.user) throw new Error('登录后才能同步');
    const { error } = await client.from('plans')
      .delete()
      .eq('id', plan.id)
      .eq('user_id', cloud.user.id);
    if (error) throw error;
    plansMsg('阶段已删除', true);
  } catch (err) {
    console.warn('[plans] delete failed', err);
    planRows.splice(index, 0, plan);
    planRows = sortPlans(planRows);
    renderPlans();
    plansMsg(plansErrorText(err));
  }
}

function initPlans() {
  const form = $('plan-form');
  const timeline = $('plans-timeline');
  if (form && !form.dataset.bound) {
    form.dataset.bound = '1';
    form.addEventListener('submit', submitPlan);
    form.elements.start.value = todayStr();
    form.elements.end.value = addDays(todayStr(), 14);
  }
  if (timeline && !timeline.dataset.bound) {
    timeline.dataset.bound = '1';
    timeline.addEventListener('click', e => {
      const btn = e.target.closest('[data-plan-act]');
      if (!btn) return;
      if (btn.dataset.planAct === 'toggle') togglePlanComplete(btn.dataset.id);
      else if (btn.dataset.planAct === 'del') deletePlan(btn.dataset.id);
    });
  }
  renderPlans();
}

window.studyhubPlans = { reload: loadPlans, state: () => planRows };




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

/* ===== 番茄钟提示音（Web Audio 合成，无音频文件） ===== */
let audioCtx = null;

// 浏览器要求音频在用户手势中解锁：开始专注时调用一次
function primeAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch (e) {
    return null;
  }
}

function scheduleChime(ctx) {
  try {
    const t0 = ctx.currentTime + 0.02;
    const notes = [880, 1108.73, 1318.51]; // A5 · C#6 · E6，柔和上行三音
    notes.forEach((freq, i) => {
      const start = t0 + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1.2);
    });
  } catch (e) {
    console.warn('[focus] 提示音播放失败', e);
  }
}

function playFocusChime() {
  if (navigator.vibrate) {
    try { navigator.vibrate([120, 90, 120]); } catch (e) { /* 忽略 */ }
  }
  const ctx = primeAudio();
  if (!ctx) return;
  if (ctx.state === 'running') { scheduleChime(ctx); return; }
  // 后台久了可能被挂起：恢复后再响（需此前被用户手势解锁过）
  ctx.resume().then(() => { if (ctx.state === 'running') scheduleChime(ctx); }).catch(() => {});
}

/* ===== 专注结束系统通知（可选，不依赖任何外部服务） ===== */
let notificationAsked = false;

function ensureNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default' || notificationAsked) return;
  notificationAsked = true;
  try {
    const result = Notification.requestPermission();
    if (result && typeof result.then === 'function') {
      result.then(() => {}).catch(() => {});
    }
  } catch (e) {
    console.warn('[focus] 通知权限申请失败', e);
  }
}

function notifyFocusEnd(taskName) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const note = new Notification('专注结束', {
      body: '专注结束，快起来喝水休息一下吧！' + (taskName ? `\n刚才专注：${taskName}` : ''),
      tag: 'studyhub-focus-end',
      renotify: true,
      silent: true
    });
    note.onclick = () => {
      try { window.focus(); note.close(); } catch (e) { /* 忽略 */ }
    };
  } catch (e) {
    console.warn('[focus] 系统通知失败', e);
  }
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
  primeAudio(); // 借这次点击解锁音频，倒计时结束时才能响
  ensureNotificationPermission(); // 借这次用户手势申请通知权限
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
  playFocusChime();                 // 倒计时自然结束 / 手动结束都响铃
  notifyFocusEnd(t && t.name);      // 有通知权限时弹系统通知
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
  const timeText = t.start && t.end ? `${t.start}–${t.end}` : '';
  const running = !!t.run;
  const focusing = !!state.focus && state.focus.taskId === t.id;
  const used = elapsed(t);
  const started = running || used > 0;
  const showActual = used > 0 || running;
  const repeatDef = recurringDefForTask(t);
  const subs = subtasksOf(t.id);
  const subDone = subs.filter(s => s.done).length;
  const subOpen = openSubtasks.has(t.id) ? ' open' : '';
  return `<li class="task-item ${t.done ? 'done' : ''} ${running ? 'running' : ''} ${focusing ? 'focusing' : ''}">
    <div class="task-row">
      <input type="checkbox" data-act="done" data-id="${t.id}" ${t.done ? 'checked' : ''}>
      <div class="t-main">
        <div class="t-name"><span class="tag cat-${esc(t.cat || 'other')}">${cat}</span>${esc(t.name)}
          <span class="pri ${Number(t.priority) === 1 ? 'high' : ''}">${PRI_TEXT[Number(t.priority)] || '中'}</span>
          ${repeatDef ? `<button class="repeat-chip" type="button" data-act="stop-repeat" data-id="${t.id}" title="每天重复 · 点击停止">🔁 每天</button>` : ''}</div>
        <div class="t-meta">
          ${timeText ? `<span>${timeText}</span>` : ''}
          <span>计划 ${Number(t.est) || 60} 分</span>
          ${showActual ? `<span>实际用时 <em data-actual="${t.id}">${hms(used)}</em></span>` : ''}
        </div>
      </div>
      ${showActual ? `<span class="timer ${running ? 'running' : ''}" data-timer="${t.id}">${hms(used)}</span>` : ''}
      <div class="t-actions">
        ${t.done ? '' : `<button data-act="${running ? 'pause' : 'start'}" data-id="${t.id}">${running ? '⏸ 暂停' : (started ? '▶ 继续专注' : '▶ 开始专注')}</button>`}
        ${running ? `<button data-act="stop" data-id="${t.id}">⏹ 结束</button>` : ''}
        <button class="del" data-act="del-task" data-id="${t.id}">删除</button>
      </div>
    </div>
    <details class="subtasks" data-subtask-for="${t.id}"${subOpen}>
      <summary title="展开 / 收起子任务">子任务 <span class="subtask-count">${subDone}/${subs.length}</span></summary>
      ${subs.length ? `<ul class="subtask-list">
        ${subs.map(s => `<li class="subtask-item ${s.done ? 'subtask-done' : ''}">
          <input type="checkbox" data-subtask-toggle="${s.id}" data-task="${t.id}" aria-label="完成子任务：${esc(s.text)}" ${s.done ? 'checked' : ''}>
          <span class="subtask-text">${esc(s.text)}</span>
          <button type="button" class="subtask-del" data-act="del-subtask" data-id="${t.id}" data-sub="${s.id}" aria-label="删除子任务">×</button>
        </li>`).join('')}
      </ul>` : ''}
      <div class="subtask-add">
        <input type="text" maxlength="60" data-subtask-input="${t.id}" placeholder="添加子任务…" aria-label="添加子任务">
        <button type="button" data-act="add-subtask" data-id="${t.id}">添加</button>
      </div>
    </details>
  </li>`;
}

// 仪表盘专用：单行紧凑任务行
function compactTaskRow(t) {
  const cat = CATS[t.cat] || '其他';
  const running = !!t.run;
  const focusing = !!state.focus && state.focus.taskId === t.id;
  const used = elapsed(t);
  const started = running || used > 0;
  const prio = Number(t.priority) || 2;
  const prioCls = prio === 1 ? 'prio-high' : prio === 3 ? 'prio-low' : 'prio-mid';
  const timeText = t.start && t.end ? `${t.start}–${t.end}` : '';
  const recurring = !!recurringDefForTask(t);
  return `<li class="compact ${prioCls} ${t.done ? 'done' : ''} ${running ? 'running' : ''} ${focusing ? 'focusing' : ''}">
    <input type="checkbox" data-act="done" data-id="${t.id}" ${t.done ? 'checked' : ''}>
    <div class="t-main">
      <div class="t-name">
        <span class="tag cat-${esc(t.cat || 'other')}">${cat}</span>
        <span class="t-title" title="${esc(t.name)}">${esc(t.name)}</span>
        ${recurring ? '<span class="repeat-mark" title="每天重复">🔁</span>' : ''}
      </div>
    </div>
    ${timeText ? `<span class="t-time">${timeText}</span>` : ''}
    <div class="t-actions">
      ${t.done ? '' : `<button data-act="${running ? 'pause' : 'start'}" data-id="${t.id}" title="${running ? '暂停' : (started ? '继续专注' : '开始专注')}">${running ? '⏸' : '▶'}</button>`}
      ${running ? `<button data-act="stop" data-id="${t.id}" title="结束">⏹</button>` : ''}
      <button class="del" data-act="del-task" data-id="${t.id}" title="删除">×</button>
    </div>
  </li>`;
}

/* ===== 渲染：仪表盘 ===== */
function renderDash() {
  const now = new Date(), today = todayStr();
  $('d-date').textContent = `${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  $('d-week').textContent = `${now.getFullYear()} 年 · ${WEEKDAYS[weekdayOf(today) - 1]}`;

  const todays = state.tasks.filter(t => dateOnly(t.date) === today);
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
    ? todays.slice().sort((a, b) => (a.done - b.done) || (toMin(a.start) ?? 9999) - (toMin(b.start) ?? 9999)).map(t => compactTaskRow(t)).join('')
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
  const date = dateOnly(state.ui.taskDate || todayStr());
  $('task-date').value = date;
  const dateInput = $('task-form').elements.date;
  if (!taskDatePicked || !dateInput.value) dateInput.value = todayStr();
  $('focus-min').value = Number(state.ui.focusMin) || 25;

  const list = state.tasks.filter(t => dateOnly(t.date) === date).sort((a, b) =>
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
  renderCustomCountdowns();
}


/* ===== 自定义倒计时（仅本机 localStorage，不进 Supabase） ===== */
const CD_KEY = 'studyhub.customCountdowns';
const CD_MAX = 12;          // 顶栏放不下太多，最多 12 个
const CD_NAME_MAX = 20;
let cdModalIndex = -1;      // 正在编辑的倒计时下标；-1 表示新增
let cdMsgTimer = 0;

// 两个日期之间差几天：按“日期”而不是“时刻”计算，避免时区与时分误差
function cdDaysLeft(dateStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const target = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(target.getTime())) return null;
  const today = parseDate(todayStr());
  return Math.round((target - today) / 86400000);
}

function cdListRead() {
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem(CD_KEY) || '[]'); } catch (e) { raw = []; }
  return (Array.isArray(raw) ? raw : [])
    .filter(it => it && typeof it === 'object' && it.name && /^\d{4}-\d{2}-\d{2}$/.test(String(it.date || '')))
    .map(it => ({
      id: String(it.id || uid()),
      name: String(it.name).trim().slice(0, CD_NAME_MAX),
      date: String(it.date)
    }));
}

function cdListWrite(list) {
  try { localStorage.setItem(CD_KEY, JSON.stringify(list)); }
  catch (e) { console.warn('[countdown] 保存失败', e); }
}

// 把自定义倒计时条贴到「省考倒计时」右侧：量出它的实际宽度写进 CSS 变量
// （倒计时数字每秒变宽变窄，所以每次渲染与每秒刷新都量一次，失败就保持原值）
function cdSyncOffset() {
  const pill = document.querySelector('.top-exam');
  const wrap = $('top-cds');
  if (!pill || !wrap || !pill.getBoundingClientRect) return;
  const w = pill.getBoundingClientRect().width;
  if (w > 0) wrap.style.setProperty('--top-exam-w', Math.ceil(w) + 'px');
}

function cdItemMeta(left) {
  if (left == null) return { cls: 'is-invalid', num: '--', unit: '', label: '日期无效' };
  if (left > 0) return { cls: '', num: String(left), unit: '天', label: '' };
  if (left === 0) return { cls: 'is-today', num: '今天', unit: '', label: '就是今天！' };
  return { cls: 'is-past', num: String(-left), unit: '天', label: '已过去' };
}

function renderCustomCountdowns() {
  const list = $('top-cd-list');
  if (!list) return;
  const items = cdListRead();
  const wrap = $('top-cds');
  if (wrap) wrap.classList.toggle('has-items', items.length > 0);
  cdSyncOffset();
  const addBtn = $('top-cd-add');
  if (addBtn) {
    const full = items.length >= CD_MAX;
    addBtn.disabled = full;
    addBtn.title = full ? `最多添加 ${CD_MAX} 个倒计时` : '添加倒计时';
  }
  if (!items.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = items.map((it, i) => {
    const left = cdDaysLeft(it.date);
    const meta = cdItemMeta(left);
    const title = `${esc(it.name)} · ${it.date}${meta.label ? ' · ' + meta.label : ''}`;
    return `<span class="top-cd ${meta.cls}" role="listitem" data-cd-id="${esc(it.id)}" title="${title}">
        <span class="top-cd-name">${esc(it.name)}</span>
        <span class="top-cd-num">${meta.num}<i>${meta.unit}</i></span>
        <button class="top-cd-del" type="button" data-cd-del="${esc(it.id)}" data-cd-index="${i}"
          title="删除「${esc(it.name)}」" aria-label="删除倒计时 ${esc(it.name)}">×</button>
      </span>`;
  }).join('');
}

function cdSetMsg(text, ok) {
  const el = $('cd-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
  clearTimeout(cdMsgTimer);
  if (text) cdMsgTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

function openCdModal() {
  const modal = $('cd-modal');
  if (!modal) return;
  if (cdListRead().length >= CD_MAX) { syncToast(`最多添加 ${CD_MAX} 个倒计时`); return; }
  cdModalIndex = -1;
  const form = $('cd-form');
  if (form) form.reset();
  const nameEl = $('cd-name');
  const dateEl = $('cd-date');
  if (dateEl) {
    const t = todayStr();
    dateEl.min = t;                       // 只能选今天或以后
    dateEl.value = addDays(t, 30);        // 默认一个月后，省得手动翻日历
  }
  cdSetMsg('');
  modal.classList.remove('hidden');
  if (nameEl) setTimeout(() => { try { nameEl.focus(); } catch (e) { /* 忽略 */ } }, 60);
}

function closeCdModal() {
  const modal = $('cd-modal');
  if (modal) modal.classList.add('hidden');
  cdSetMsg('');
}

function submitCdForm(e) {
  e.preventDefault();
  const name = String(($('cd-name') || {}).value || '').trim().slice(0, CD_NAME_MAX);
  const date = String(($('cd-date') || {}).value || '').trim();
  if (!name) { cdSetMsg('先给倒计时起个名字吧'); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { cdSetMsg('请选择一个目标日期'); return; }
  const left = cdDaysLeft(date);
  if (left == null) { cdSetMsg('日期格式不对，请重新选择'); return; }
  if (left < 0) { cdSetMsg('目标日期不能早于今天～'); return; }

  const list = cdListRead();
  if (list.some(it => it.name === name && it.date === date)) {
    cdSetMsg('已经有一个同名同日期的倒计时啦');
    return;
  }
  if (list.length >= CD_MAX) { cdSetMsg(`最多添加 ${CD_MAX} 个倒计时`); return; }

  list.push({ id: uid(), name, date });
  list.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'zh'));
  cdListWrite(list);
  closeCdModal();
  renderCustomCountdowns();
  syncToast(left === 0 ? `「${name}」就是今天，加油！` : `已添加：距离「${name}」还有 ${left} 天`);
}

function deleteCd(id) {
  const list = cdListRead();
  const item = list.find(it => it.id === String(id));
  if (!item) return;
  if (!window.confirm(`删除倒计时「${item.name}」？`)) return;
  cdListWrite(list.filter(it => it.id !== String(id)));
  renderCustomCountdowns();
  syncToast(`已删除倒计时「${item.name}」`);
}

function initCustomCountdowns() {
  const addBtn = $('top-cd-add');
  const list = $('top-cd-list');
  const modal = $('cd-modal');
  const form = $('cd-form');
  if (addBtn) addBtn.addEventListener('click', openCdModal);
  if (list) {
    // 点 × 删除；点卡片其它位置只是看信息，不做操作
    list.addEventListener('click', e => {
      const del = e.target.closest('[data-cd-del]');
      if (del) { e.stopPropagation(); deleteCd(del.dataset.cdDel); }
    });
  }
  if (form) form.addEventListener('submit', submitCdForm);
  const closeBtn = $('cd-close');
  const cancelBtn = $('cd-cancel');
  if (closeBtn) closeBtn.addEventListener('click', closeCdModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeCdModal);
  if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeCdModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeCdModal();
  });
  renderCustomCountdowns();
}

window.studyhubCountdowns = {
  list: cdListRead,
  render: renderCustomCountdowns,
  add: (name, date) => cdListWrite(cdListRead().concat({ id: uid(), name, date }))
};


/* ===== 每日微习惯（仅本机 localStorage；每天按日期自动重置勾选） ===== */
const HABIT_KEY = 'studyhub.habits';           // { date: 'YYYY-MM-DD', items: [{ id, name, done }] }
const HABIT_MAX = 20;
const HABIT_NAME_MAX = 16;
let habitTodayCache = '';
let habitCheckedAt = 0;
let habitPendingDelete = null;
let habitFlashTimer = 0;

// 读取时做两件事：① 日期不是今天就整体重置勾选；② 兼容旧的纯字符串数组
function habitsRead() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(HABIT_KEY) || 'null'); } catch (e) { raw = null; }
  const today = todayStr();
  habitTodayCache = today;

  if (Array.isArray(raw)) raw = { date: today, items: raw };
  if (!raw || typeof raw !== 'object') raw = { date: today, items: [] };
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map(it => (typeof it === 'string'
      ? { id: uid(), name: String(it).trim(), done: false }
      : { id: String((it && it.id) || uid()), name: String((it && it.name) || '').trim(), done: !!(it && it.done) }))
    .filter(it => it.name);

  const sameDay = raw.date === today;
  const list = {
    date: today,
    items: items.map(it => ({ id: it.id, name: it.name, done: sameDay ? !!it.done : false }))
  };
  // 跨天时立即把“全部未完成”的新状态写回，避免刷新前又被旧勾选复活
  if (!sameDay && Array.isArray(raw.items) && raw.items.length) habitsWrite(list, 'silent');
  return list;
}

function habitsWrite(list) {
  habitTodayCache = list.date || todayStr();
  try { localStorage.setItem(HABIT_KEY, JSON.stringify(list)); }
  catch (e) { console.warn('[habit] 保存失败', e); }
}

function habitsSave(items) {
  habitsWrite({ date: todayStr(), items });
  renderHabits();
}

// 跨天检测：跨过零点就重绘一次（liveUpdate 每秒调用）
function habitsTick() {
  const now = Date.now();
  if (now - habitCheckedAt < 1000) return;
  habitCheckedAt = now;
  if (habitTodayCache && habitTodayCache !== todayStr()) renderHabits();
}

function habitEncourage(done, total) {
  if (!total) return '还没有微习惯，点右上角的 ＋ 加一个吧 🌱';
  if (done >= total) return `今日 ${done} / ${total} 个小习惯全部完成，太棒啦！🎉`;
  if (done === 0) return `今日已完成 0 / ${total} 个微习惯，先从一件小事开始吧 🌱`;
  if (done / total >= 0.5) return `今日已完成 ${done} / ${total} 个微习惯，继续保持！`;
  return `今日已完成 ${done} / ${total} 个微习惯，再坚持一下下 💪`;
}

function renderHabits() {
  const listEl = $('habit-list');
  if (!listEl) return;
  const list = habitsRead();
  const items = list.items;
  const done = items.filter(it => it.done).length;

  const sub = $('habit-sub');
  if (sub) sub.textContent = habitEncourage(done, items.length);
  const addBtn = $('habit-add');
  if (addBtn) addBtn.disabled = items.length >= HABIT_MAX;

  if (!items.length) {
    listEl.innerHTML = `<li class="habit-empty">还没有微习惯～点右上角 ＋ 添加「不熬夜」「喝八杯水」这样的小事</li>`;
    return;
  }
  listEl.innerHTML = items.map(it => `<li class="habit-item${it.done ? ' is-done' : ''}" data-habit-id="${esc(it.id)}">
      <button class="habit-check" type="button" data-habit-toggle="${esc(it.id)}"
        role="checkbox" aria-checked="${it.done ? 'true' : 'false'}"
        aria-label="${esc(it.name)}${it.done ? '（已完成）' : '（未完成）'}">
        <span class="habit-check-icon" aria-hidden="true">✓</span>
      </button>
      <span class="habit-name">${esc(it.name)}</span>
      <button class="habit-del" type="button" data-habit-del="${esc(it.id)}"
        title="删除「${esc(it.name)}」" aria-label="删除微习惯 ${esc(it.name)}">×</button>
    </li>`).join('');
  // 全部完成时给顶部一句小彩带式反馈
  if (done === items.length && done > 0) {
    listEl.classList.add('is-all-done');
    clearTimeout(habitFlashTimer);
    habitFlashTimer = setTimeout(() => listEl.classList.remove('is-all-done'), 1200);
  }
}

function toggleHabit(id) {
  const list = habitsRead();
  const hit = list.items.find(it => it.id === String(id));
  if (!hit) return;
  // 跨天后的第一次点击：habitsRead 已把旧勾选重置，直接基于新状态翻转
  hit.done = !hit.done;
  habitsSave(list.items);
  if (hit.done) syncToast(`「${hit.name}」完成啦 🌱`);
}

function addHabit(name) {
  const value = String(name || '').trim().slice(0, HABIT_NAME_MAX);
  if (!value) { syncToast('先写一个习惯名字吧'); return false; }
  const list = habitsRead();
  if (list.items.some(it => it.name === value)) { syncToast('这个习惯已经在列表里啦'); return false; }
  if (list.items.length >= HABIT_MAX) { syncToast(`最多 ${HABIT_MAX} 个微习惯`); return false; }
  list.items.push({ id: uid(), name: value, done: false });
  habitsSave(list.items);
  syncToast(`已添加微习惯「${value}」`);
  return true;
}

function askDeleteHabit(id) {
  const list = habitsRead();
  const hit = list.items.find(it => it.id === String(id));
  if (!hit) return;
  habitPendingDelete = hit.id;
  const box = $('habit-alert');
  const msg = $('habit-alert-msg');
  if (msg) msg.textContent = `删除后「${hit.name}」会从列表里消失，今天的打卡记录也会一并清掉。`;
  if (box) box.classList.remove('hidden');
}

function closeHabitAlert() {
  habitPendingDelete = null;
  const box = $('habit-alert');
  if (box) box.classList.add('hidden');
}

function confirmDeleteHabit() {
  const id = habitPendingDelete;
  closeHabitAlert();
  if (!id) return;
  const list = habitsRead();
  const hit = list.items.find(it => it.id === id);
  habitsSave(list.items.filter(it => it.id !== id));
  if (hit) syncToast(`已删除微习惯「${hit.name}」`);
}

function toggleHabitForm(open) {
  const wrap = $('habit-form-wrap');
  const input = $('habit-input');
  if (!wrap) return;
  const show = open === undefined ? wrap.classList.contains('hidden') : !!open;
  wrap.classList.toggle('hidden', !show);
  const addBtn = $('habit-add');
  if (addBtn) addBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show && input) setTimeout(() => { try { input.focus(); } catch (e) { /* 忽略 */ } }, 60);
  if (!show && input) input.value = '';
}

function initHabits() {
  const list = $('habit-list');
  const form = $('habit-form');
  if (!list) return;
  list.addEventListener('click', e => {
    const check = e.target.closest('[data-habit-toggle]');
    if (check) { toggleHabit(check.dataset.habitToggle); return; }
    const del = e.target.closest('[data-habit-del]');
    if (del) askDeleteHabit(del.dataset.habitDel);
  });
  const addBtn = $('habit-add');
  if (addBtn) addBtn.addEventListener('click', () => toggleHabitForm());
  if (form) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const input = $('habit-input');
      if (addHabit(input && input.value)) toggleHabitForm(false);
    });
  }
  const cancelBtn = $('habit-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => toggleHabitForm(false));
  const alertBox = $('habit-alert');
  const okBtn = $('habit-alert-ok');
  const noBtn = $('habit-alert-cancel');
  if (okBtn) okBtn.addEventListener('click', confirmDeleteHabit);
  if (noBtn) noBtn.addEventListener('click', closeHabitAlert);
  if (alertBox) alertBox.addEventListener('click', e => { if (e.target === alertBox) closeHabitAlert(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && alertBox && !alertBox.classList.contains('hidden')) closeHabitAlert();
  });
  renderHabits();
}

window.studyhubHabits = {
  list: () => habitsRead().items,
  add: addHabit,
  toggle: toggleHabit,
  render: renderHabits
};

/* ===== 学习足迹（最近 12 周热力图） ===== */
let heatToday = '';
let heatTodayMin = -1;

function dailyStudySeconds() {
  const map = {};
  for (const t of state.tasks) {
    const sec = elapsed(t);
    if (sec > 0) map[t.date] = (map[t.date] || 0) + sec;
  }
  return map;
}

function heatMinute(sec) {
  return sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0;
}

function heatLevel(min) {
  if (min <= 0) return 0;
  if (min < 15) return 1;
  if (min < 30) return 2;
  if (min < 60) return 3;
  return 4;
}

function heatTip(date, min) {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日，专注了${min}分钟`;
}

// 从 11 周前的周一开始，7 行正好对应周一到周日
function heatmapStart(today) {
  return addDays(today, -(weekdayOf(today) - 1) - 77);
}

function refreshHeatSummary(byDate, start, today) {
  const summary = $('heatmap-summary');
  if (!summary) return;
  byDate = byDate || dailyStudySeconds();
  today = today || todayStr();
  start = start || heatmapStart(today);
  let totalSec = 0;
  let activeDays = 0;
  for (let i = 0; i < 84; i++) {
    const date = addDays(start, i);
    if (date > today) continue;
    const sec = byDate[date] || 0;
    if (sec > 0) {
      activeDays++;
      totalSec += sec;
    }
  }
  summary.textContent = `最近 12 周 · 学习 ${activeDays} 天 · 累计 ${hoursText(Math.round(totalSec / 60))}`;
}

function renderHeatmap() {
  const grid = $('heatmap');
  if (!grid) return;
  const today = todayStr();
  const start = heatmapStart(today);
  const byDate = dailyStudySeconds();
  let html = '';
  for (let i = 0; i < 84; i++) {
    const date = addDays(start, i);
    if (date > today) {
      html += `<div class="heat-cell heat-future" data-heat-date="${date}" aria-hidden="true"></div>`;
      continue;
    }
    const min = heatMinute(byDate[date] || 0);
    const tip = heatTip(date, min);
    html += `<div class="heat-cell heat-${heatLevel(min)}" data-heat-date="${date}" title="${tip}" aria-label="${tip}"></div>`;
  }
  grid.innerHTML = html;
  heatToday = today;
  heatTodayMin = heatMinute(byDate[today] || 0);
  refreshHeatSummary(byDate, start, today);
}

// 秒级刷新时只改“今天”这格，避免整张图重建
function updateHeatmapToday() {
  const today = todayStr();
  if (heatToday !== today) { renderHeatmap(); return; }
  const cell = document.querySelector(`[data-heat-date="${today}"]`);
  if (!cell) return;
  const min = heatMinute(todayStudySec(today));
  if (min === heatTodayMin) return;
  heatTodayMin = min;
  cell.className = 'heat-cell heat-' + heatLevel(min);
  const tip = heatTip(today, min);
  cell.title = tip;
  cell.setAttribute('aria-label', tip);
  refreshHeatSummary();
}

/* ===== 渲染：数据统计（学习周报） ===== */
function reportMinutes(sec) {
  const s = Math.max(0, Number(sec) || 0);
  return s > 0 ? Math.max(1, Math.round(s / 60)) : 0;
}

// 统一时长展示：> 60 分钟用一位小数小时，否则保持分钟
function formatStudyDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m > 60) return `${(m / 60).toFixed(1)} 小时`;
  return `${m} 分钟`;
}

function weekHoursText(sec) {
  const h = Math.max(0, Number(sec) || 0) / 3600;
  if (h <= 0) return '0';
  if (h < 0.05) return '<0.1';
  return h.toFixed(1).replace(/\.0$/, '');
}

function weekDateLabel(date) {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

function weekReportStats() {
  const today = todayStr();
  const start = weekStartStr(today);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    days.push({ date, weekday: WEEKDAYS[i], seconds: 0 });
  }
  const byDate = new Map(days.map(d => [d.date, d]));
  const catSeconds = {};
  let totalSeconds = 0;

  for (const t of state.tasks) {
    // state.tasks 本地字段是 date；兼容旧数据 / 云端行的 task_date
    const date = dateOnly(t.date || t.task_date);
    const day = byDate.get(date);
    if (!day) continue;
    const sec = Math.max(0, elapsed(t)); // 以 actualSeconds 为基准，计时中补上当前这一段
    day.seconds += sec;
    totalSeconds += sec;
    if (sec > 0) {
      const cat = t.cat || 'other';
      catSeconds[cat] = (catSeconds[cat] || 0) + sec;
    }
  }

  const topCats = Object.keys(catSeconds)
    .sort((a, b) => catSeconds[b] - catSeconds[a])
    .slice(0, 3)
    .map(cat => ({ cat, seconds: catSeconds[cat], minutes: reportMinutes(catSeconds[cat]) }));

  return {
    today, start, end: addDays(start, 6), days, totalSeconds,
    totalMinutes: reportMinutes(totalSeconds),
    activeDays: days.filter(d => d.seconds > 0).length,
    topCats
  };
}

function renderStats() {
  const hoursEl = $('stats-week-hours');
  const subEl = $('stats-week-sub');
  const chartEl = $('stats-chart');
  const rankEl = $('stats-rank');
  if (!chartEl || !rankEl) return;

  const report = weekReportStats();
  if (hoursEl) hoursEl.textContent = weekHoursText(report.totalSeconds);
  if (subEl) {
    subEl.textContent = `${weekDateLabel(report.start)} – ${weekDateLabel(report.end)} · 共 ${report.totalMinutes} 分钟 · ${report.activeDays} 天有专注`;
  }

  const maxSec = Math.max(...report.days.map(d => d.seconds), 0);
  chartEl.innerHTML = report.days.map((d, i) => {
    const isToday = d.date === report.today;
    const isFuture = d.date > report.today;
    const isZero = d.seconds <= 0;
    const pct = !isZero && maxSec > 0 ? Math.max(4, (d.seconds / maxSec) * 86) : 0;
    const minutes = reportMinutes(d.seconds);
    const full = formatStudyDuration(minutes);
    const tip = `${WEEKDAYS[i]} ${weekDateLabel(d.date)}，专注 ${full}`;
    const cls = ['weekly-col'];
    if (isToday) cls.push('today');
    if (isFuture) cls.push('future');
    return `<div class="${cls.join(' ')}" style="--bar:${pct.toFixed(1)}%" title="${tip}" aria-label="${tip}">
      <div class="weekly-plot">
        <span class="weekly-val" title="${tip}">
          <span class="weekly-val-full">${full}</span>
          <span class="weekly-val-short">${minutes}</span>
        </span>
        <div class="weekly-bar${isZero ? ' is-zero' : ''}"></div>
      </div>
      <div class="weekly-axis"><b>${WEEKDAYS[i]}</b><span>${weekDateLabel(d.date)}</span></div>
    </div>`;
  }).join('');
  chartEl.setAttribute('aria-label',
    '本周每日专注时长：' + report.days.map((d, i) => `${WEEKDAYS[i]} ${formatStudyDuration(reportMinutes(d.seconds))}`).join('，'));

  const maxCatSec = report.topCats.length ? report.topCats[0].seconds : 0;
  rankEl.innerHTML = report.topCats.length
    ? report.topCats.map((c, i) => {
      const name = CATS[c.cat] || '其他';
      const pct = maxCatSec > 0 ? Math.max(6, (c.seconds / maxCatSec) * 100) : 0;
      return `<li class="weekly-rank-item">
        <span class="weekly-rank-no">${i + 1}</span>
        <div class="weekly-rank-main">
          <div class="weekly-rank-top">
            <span class="weekly-rank-name"><span class="tag cat-${esc(c.cat)}">${esc(name)}</span></span>
            <span class="weekly-rank-min">${formatStudyDuration(c.minutes)}</span>
          </div>
          <div class="weekly-rank-track"><span class="weekly-rank-fill" style="--p:${pct.toFixed(1)}%"></span></div>
        </div>
      </li>`;
    }).join('')
    : '<li class="weekly-rank-empty">本周还没有专注记录，去完成任务试试 🌱</li>';
}

/* ===== 渲染：全部 ===== */
function renderAll() {
  renderDash();
  renderCourses();
  renderTasks();
  renderFitness();
  renderCountdown();
  renderHeatmap();
  renderStats();
  renderFocus();
}

/* ===== 全屏沉浸自习室
   只做视觉层面的覆盖：不改 state、不碰同步、不重建任何页面。
   退出时只需移除 .studyroom-open，原有布局与状态自动复原。 ===== */
const studyroom = {
  open: false,
  prevScroll: 0,
  keyHandler: null,
  fsHandler: null,
  raf: 0
};

function srClockText(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 用 requestAnimationFrame 对齐到整秒边界刷新，比 setInterval 更准（不会跳秒）
function srTick() {
  if (!studyroom.open) return;
  const el = $('sr-clock');
  const now = new Date();
  if (el) {
    const text = srClockText(now);
    if (el.textContent !== text) el.textContent = text;
  }
  const wait = 1000 - now.getMilliseconds();
  studyroom.raf = setTimeout(() => {
    studyroom.raf = requestAnimationFrame(srTick);
  }, wait);
}

function srStopTick() {
  if (studyroom.raf) {
    clearTimeout(studyroom.raf);
    studyroom.raf = 0;
  }
}

function srCurrentFullscreenEl() {
  try {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  } catch (e) {
    return null;
  }
}

function srRequestFullscreen() {
  const el = document.documentElement;
  try {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return; // 不支持全屏时只做沉浸层，不影响功能
    const ret = fn.call(el);
    if (ret && typeof ret.catch === 'function') ret.catch(() => { /* 被浏览器策略拒绝，忽略 */ });
  } catch (e) {
    /* iframe / 权限限制下会抛错，静默忽略 */
  }
}

function srExitFullscreen() {
  try {
    if (!srCurrentFullscreenEl()) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn) return;
    const ret = fn.call(document);
    if (ret && typeof ret.catch === 'function') ret.catch(() => { /* 忽略 */ });
  } catch (e) {
    /* 忽略 */
  }
}

function enterStudyroom() {
  if (studyroom.open) return;
  const layer = $('studyroom');
  if (!layer) return;

  // 记下滚动位置，退出后原样还原；同时锁住背景滚动
  studyroom.prevScroll = window.pageYOffset || document.documentElement.scrollTop || 0;
  studyroom.open = true;
  document.documentElement.classList.add('studyroom-open');
  document.body.classList.add('studyroom-open');
  layer.classList.remove('hidden');

  const clock = $('sr-clock');
  if (clock) clock.textContent = srClockText(new Date());
  srTick();

  srRequestFullscreen();

  // ESC 自己处理：浏览器全屏时 ESC 会先被浏览器吞掉，所以要兜底
  studyroom.keyHandler = e => {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    e.preventDefault();
    exitStudyroom();
  };
  document.addEventListener('keydown', studyroom.keyHandler, true);

  // 用户按 F11 / 浏览器原生方式退出全屏时，同步收起沉浸层，避免“半退出”
  studyroom.fsHandler = () => {
    if (!studyroom.open) return;
    if (!srCurrentFullscreenEl()) exitStudyroom();
  };
  document.addEventListener('fullscreenchange', studyroom.fsHandler);
  document.addEventListener('webkitfullscreenchange', studyroom.fsHandler);

  try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) { window.scrollTo(0, 0); }
}

function exitStudyroom() {
  if (!studyroom.open) return;
  studyroom.open = false;
  srStopTick();

  const layer = $('studyroom');
  if (layer) layer.classList.add('hidden');
  document.documentElement.classList.remove('studyroom-open');
  document.body.classList.remove('studyroom-open');
  srExitFullscreen();

  if (studyroom.keyHandler) {
    document.removeEventListener('keydown', studyroom.keyHandler, true);
    studyroom.keyHandler = null;
  }
  if (studyroom.fsHandler) {
    document.removeEventListener('fullscreenchange', studyroom.fsHandler);
    document.removeEventListener('webkitfullscreenchange', studyroom.fsHandler);
    studyroom.fsHandler = null;
  }

  // 还原滚动位置与焦点，页面布局不重建、Tab / 计时 / 悬浮球状态都保留
  try { window.scrollTo({ top: studyroom.prevScroll, behavior: 'auto' }); }
  catch (e) { window.scrollTo(0, studyroom.prevScroll); }
  const btn = $('studyroom-btn');
  if (btn && btn.focus) {
    try { btn.focus({ preventScroll: true }); } catch (e) { /* 老浏览器忽略 */ }
  }
}

function initStudyroom() {
  const btn = $('studyroom-btn');
  const layer = $('studyroom');
  const exitBtn = $('sr-exit');
  if (btn) btn.addEventListener('click', enterStudyroom);
  if (exitBtn) exitBtn.addEventListener('click', exitStudyroom);
  if (layer) {
    layer.addEventListener('click', e => {
      // 点空白区域也退出（点文字/时钟不退出，避免误触）
      if (e.target === layer) exitStudyroom();
    });
  }
}

window.studyhubStudyroom = { enter: enterStudyroom, exit: exitStudyroom, isOpen: () => studyroom.open };


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

  // 小盆栽：专注时长跨过阶段阈值时才更新，避免每秒重排
  if (plantLastStage !== null) {
    const m = plantMinutes();
    const s = plantStageOf(m);
    if (s !== plantLastStage || m !== plantLastMinutes) renderPlant();
  }

  // 微习惯跨天检测：过了零点把勾选恢复成未完成
  habitsTick();
  // 顶栏倒计时：数字宽度每秒变化，顺手校正一次位置
  cdSyncOffset();

  // 跨天：自动切到今天并高亮
  const now = todayStr();
  if (fitToday && now !== fitToday) {
    fitToday = now;
    fitSelected = now;
    const d = parseDate(now);
    fitView = { y: d.getFullYear(), m: d.getMonth() };
    renderFitness();
    if (ensureRecurringInstances() > 0) {
      save();
      renderAll();
    }
    if (state.ui.tab === 'plans') renderPlans();
  }

  // 专注倒计时
  if (state.focus) {
    const t = state.tasks.find(x => x.id === state.focus.taskId);
    if (!t || t.done) {
      state.focus = null;
      save();
      renderFocus();
    } else {
      const remain = focusRemain();
      const timeEl = $('fp-time');
      if (timeEl) timeEl.textContent = focusText(remain);
      if (remain <= 0) {
        syncToast(`🍅 番茄钟完成：${t.name}，休息一下吧`);
        endTaskTimer(t); // 内部播放提示音并弹系统通知，再自动结算
      }
    }
  }

  updateHeatmapToday();
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
  renderActiveTab();
});

function switchTab() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.ui.tab));
  // 先彻底摘掉所有页面的 active，再只给目标页加上——保证任何情况下都只有一个页面可见
  const pages = document.querySelectorAll('.page');
  pages.forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + state.ui.tab);
  if (target) {
    target.classList.add('active');
  } else if (pages.length) {
    // 兜底：存档里的 tab 对不上任何页面时，回到仪表盘，避免出现“所有页面都隐藏”的白屏
    state.ui.tab = 'dash';
    const dash = document.getElementById('page-dash');
    if (dash) dash.classList.add('active');
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'dash'));
  }
  const hash = '#' + state.ui.tab;
  if (location.hash !== hash) {
    try { history.replaceState(null, '', hash); } catch (e) { /* file:// 下可能被限制 */ }
  }
}

// 切回某个标签时重新渲染它，确保拿到最新的 state.tasks / moods
function renderActiveTab() {
  if (state.ui.tab === 'dash') {
    renderDash();
    renderHeatmap();
  } else if (state.ui.tab === 'courses') {
    renderCourses();
  } else if (state.ui.tab === 'tasks') {
    renderTasks();
  } else if (state.ui.tab === 'fitness') {
    renderFitness();
  } else if (state.ui.tab === 'mood') {
    loadMoods(true);              // 切回碎碎念：强制重新拉一次云端，别只显示本机缓存
    capsuleRender();              // 切回来时按当前系统日期重新判断哪些信已解锁
  } else if (state.ui.tab === 'stats') {
    renderStats();
  } else if (state.ui.tab === 'plans') {
    renderPlans();
    loadPlans();
  }
}

// 手动改 hash / 浏览器前进后退时也同步刷新
window.addEventListener('hashchange', () => {
  const tab = (location.hash || '').replace('#', '');
  if (!['dash', 'courses', 'tasks', 'fitness', 'mood', 'stats', 'plans'].includes(tab) || tab === state.ui.tab) return;
  state.ui.tab = tab;
  save();
  switchTab();
  renderActiveTab();
});

/* ===== 添加表单：默认收起，点击展开 ===== */
function setFormPanel(panelId, toggleId, open) {
  const panel = $(panelId);
  const toggle = $(toggleId);
  if (!panel || !toggle) return;
  open = !!open;
  panel.classList.toggle('is-open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) panel.removeAttribute('inert');
  else panel.setAttribute('inert', '');
  toggle.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  const icon = toggle.querySelector('.form-toggle-icon');
  const text = toggle.querySelector('.form-toggle-text');
  const hint = toggle.querySelector('.form-toggle-hint');
  if (icon) icon.textContent = open ? '－' : '＋';
  if (text) text.textContent = open
    ? (toggle.dataset.openText || '收起')
    : (toggle.dataset.closedText || '展开');
  if (hint) hint.textContent = open ? '点击收起' : '点击展开';
}

function bindFormPanel(panelId, toggleId) {
  const panel = $(panelId);
  const toggle = $(toggleId);
  if (!panel || !toggle) return;
  toggle.addEventListener('click', () => {
    const open = !panel.classList.contains('is-open');
    setFormPanel(panelId, toggleId, open);
    if (!open) return;
    const first = panel.querySelector('input:not([type="hidden"]):not([type="checkbox"]), select, textarea');
    if (!first) return;
    setTimeout(() => {
      if (panel.classList.contains('is-open')) first.focus();
    }, 220);
  });
  setFormPanel(panelId, toggleId, false);
}

function closeTaskForm() {
  const panel = $('task-form-panel');
  const active = document.activeElement;
  const shouldFocus = !!(panel && active && panel.contains(active));
  setFormPanel('task-form-panel', 'task-form-toggle', false);
  const toggle = $('task-form-toggle');
  if (shouldFocus && toggle) toggle.focus();
}

function closeCourseForm() {
  const panel = $('course-form-panel');
  const active = document.activeElement;
  const shouldFocus = !!(panel && active && panel.contains(active));
  setFormPanel('course-form-panel', 'course-form-toggle', false);
  const toggle = $('course-form-toggle');
  if (shouldFocus && toggle) toggle.focus();
}

function resetTaskForm() {
  const form = $('task-form');
  if (!form) return;
  form.reset();
  form.elements.date.value = state.ui.taskDate || todayStr();
  form.elements.est.value = 60;
  form.elements.priority.value = '2';
}

function setCourseListPanel(open) {
  const panel = $('course-list-panel');
  const toggle = $('course-list-toggle');
  if (!panel || !toggle) return;
  open = !!open;
  panel.classList.toggle('is-open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) panel.removeAttribute('inert');
  else panel.setAttribute('inert', '');
  toggle.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  const hint = toggle.querySelector('.section-toggle-hint');
  if (hint) hint.textContent = open ? '点击收起' : '点击展开';
}

function bindCourseListPanel() {
  const panel = $('course-list-panel');
  const toggle = $('course-list-toggle');
  if (!panel || !toggle) return;
  toggle.addEventListener('click', () => {
    setCourseListPanel(!panel.classList.contains('is-open'));
  });
  setCourseListPanel(false);
}

bindFormPanel('task-form-panel', 'task-form-toggle');
bindFormPanel('course-form-panel', 'course-form-toggle');
bindFormPanel('plan-form-panel', 'plan-form-toggle');
bindCourseListPanel();

/* ===== 事件：表单 ===== */
$('task-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, el = f.elements;
  const name = String(el.name.value || '').trim();
  if (!name) { alert('请填写任务名'); return; }
  const start = el.start.value || '', end = el.end.value || '';
  if (start && end && toMin(end) <= toMin(start)) { alert('计划结束时间要晚于开始时间'); return; }

  const today = todayStr();
  const picked = dateOnly(el.date.value || today);
  const date = taskDatePicked && /^\d{4}-\d{2}-\d{2}$/.test(picked) ? picked : today;
  const repeat = !!(el.repeat && el.repeat.checked);
  const cat = el.cat.value || 'other';
  const priority = Number(el.priority.value) || 2;
  const est = Number(el.est.value) || 60;
  if (repeat && !cloud.user) await ensureCloudUser(); // 尽量把重复任务记到当前账号名下
  if (repeat) claimLocalRecurringDefs(recurringOwner());

  const repeatDef = repeat ? {
    id: 'rec_' + uid(),
    owner: recurringOwner(),
    name,
    cat,
    start,
    end,
    priority,
    est,
    startDate: date,
    skipped: []
  } : null;
  if (repeatDef) recurringDefs().push(repeatDef);

  const payload = {
    id: repeatDef ? recurringInstanceId(repeatDef.id, date) : uid(),
    recurId: repeatDef ? repeatDef.id : '',
    name,
    cat,
    date,
    start, end,
    priority,
    est,
    dateManual: taskDatePicked,
    done: false, actualSeconds: 0, run: 0
  };
  addTask(payload).then(saved => {
    if (saved) {
      closeTaskForm();
      resetTaskForm();
    }
    if (!saved && repeatDef) {
      const defs = recurringDefs();
      const i = defs.findIndex(d => d && d.id === repeatDef.id);
      if (i >= 0) defs.splice(i, 1);
      saveLocal();
    } else if (saved && repeatDef && ensureRecurringInstances() > 0) {
      save(); // 起始日期填了过去的日期时，补建今天的实例并同步
      renderAll();
    }
  });
});

// 用户手动改过添加日期后，才允许任务落到非今天
['input', 'change'].forEach(evt => {
  $('task-form').elements.date.addEventListener(evt, () => { taskDatePicked = true; });
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
  closeCourseForm();
});

$('task-date').addEventListener('change', e => {
  const d = e.target.value || todayStr();
  state.ui.taskDate = d;
  if (e.target.value) {
    taskDatePicked = true;
    $('task-form').elements.date.value = d;
  } else {
    taskDatePicked = false;
    $('task-form').elements.date.value = todayStr();
  }
  save();
  $('suggest-box').classList.add('hidden');
  renderTasks();
  renderDash();
});

$('btn-today').addEventListener('click', () => {
  state.ui.taskDate = todayStr();
  taskDatePicked = false;
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

  if (act === 'add-subtask') {
    const row = btn.closest('li');
    const input = row && row.querySelector('[data-subtask-input]');
    addSubtask(id, input && input.value);
    return;
  }
  if (act === 'del-subtask') {
    deleteSubtask(id, btn.dataset.sub);
    return;
  }

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

  if (act === 'stop-repeat') {
    if (!recurringDefForTask(t)) { syncToast('没有找到这个任务的重复设置'); return; }
    if (confirm(`停止「${t.name}」的每天重复？\n当前任务会保留。`)) {
      if (stopRecurring(t)) {
        saveLocal();
        renderAll();
        syncToast('已停止每天重复');
      }
    }
    return;
  }

  if (act === 'start') startTaskTimer(t);
  else if (act === 'pause') pauseTaskTimer(t);
  else if (act === 'stop') endTaskTimer(t);
  else if (act === 'del-task') {
    if (confirm(`删除任务「${t.name}」？`)) deleteTask(t);
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

/* ===== 事件：子任务 ===== */
document.addEventListener('change', e => {
  const el = e.target;
  if (!el.dataset || !el.dataset.subtaskToggle || !el.dataset.task) return;
  toggleSubtask(el.dataset.task, el.dataset.subtaskToggle, el.checked);
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const input = e.target && e.target.closest ? e.target.closest('[data-subtask-input]') : null;
  if (!input) return;
  e.preventDefault();
  addSubtask(input.dataset.subtaskInput, input.value);
});

// details 的 toggle 事件不冒泡，用捕获阶段记住展开状态，重渲染后不自动收起
document.addEventListener('toggle', e => {
  const box = e.target;
  if (!box || !box.matches || !box.matches('details.subtasks')) return;
  const taskId = box.dataset.subtaskFor;
  if (!taskId) return;
  if (box.open) openSubtasks.add(taskId);
  else openSubtasks.delete(taskId);
}, true);

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

/* ===== 赛博木鱼（Web Audio 合成音效 + localStorage 计数，无外部音频） ===== */
const WF_KEY = 'studyhub.woodfish';
let wfCtx = null;

// { date: 'YYYY-MM-DD', today: n, total: n }；跨天时 today 归零、total 累加保留
function wfRead() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(WF_KEY) || 'null'); } catch (e) { raw = null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const today = todayStr();
  const total = Math.max(0, Math.floor(Number(raw.total) || 0));
  if (raw.date !== today) return { date: today, today: 0, total };
  return { date: today, today: Math.max(0, Math.floor(Number(raw.today) || 0)), total };
}

function wfWrite(rec) {
  try { localStorage.setItem(WF_KEY, JSON.stringify(rec)); } catch (e) { /* 隐私模式忽略 */ }
}

// 木鱼音色：短促的低频"咚" + 木头高频"嗒"，两层一起衰减
function wfPlayTok() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!wfCtx) wfCtx = new AC();
    if (wfCtx.state === 'suspended') wfCtx.resume().catch(() => {});
    const ctx = wfCtx;
    const t0 = ctx.currentTime;

    // ① 木腔共鸣：三角波从 260Hz 快速滑到 110Hz，150ms 内衰减
    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = 'triangle';
    body.frequency.setValueAtTime(260, t0);
    body.frequency.exponentialRampToValueAtTime(110, t0 + 0.12);
    bodyGain.gain.setValueAtTime(0.0001, t0);
    bodyGain.gain.exponentialRampToValueAtTime(0.26, t0 + 0.006);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    body.connect(bodyGain).connect(ctx.destination);
    body.start(t0);
    body.stop(t0 + 0.24);

    // ② 敲击脆响：带通白噪声，模拟木头撞击的"嗒"
    const dur = 0.06;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const decay = Math.pow(1 - i / data.length, 3);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(1800, t0);
    band.Q.value = 1.6;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.32, t0);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    noise.connect(band).connect(noiseGain).connect(ctx.destination);
    noise.start(t0);
    noise.stop(t0 + dur);
  } catch (e) {
    console.warn('[woodfish] 音效播放失败', e);
  }
}

// 敲击动画：加类名触发缩放，动画结束自动移除，连续点也能重放
function wfPress() {
  const icon = document.querySelector('#woodfish .wf-body');
  if (!icon) return;
  icon.classList.remove('is-hitting');
  // 强制回流，保证连续点击时动画能重新触发
  void icon.offsetWidth;
  icon.classList.add('is-hitting');
}

// 功德气泡：在木鱼上方随机横向位置飘起并 1 秒内渐隐
function wfBubble(text) {
  const box = $('wf-bubbles');
  if (!box) return;
  const span = document.createElement('span');
  span.className = 'wf-bubble';
  span.textContent = text;
  span.style.left = (28 + Math.round(Math.random() * 44)) + '%';
  span.style.setProperty('--drift', (Math.random() * 28 - 14).toFixed(1) + 'px');
  box.appendChild(span);
  span.addEventListener('animationend', () => {
    if (span.parentNode) span.parentNode.removeChild(span);
  });
  // 兜底清理，避免动画事件被浏览器丢掉后气泡堆积
  setTimeout(() => { if (span.parentNode) span.parentNode.removeChild(span); }, 1400);
}

function wfRefresh() {
  const rec = wfRead();
  const todayEl = $('wf-today');
  if (todayEl) todayEl.textContent = rec.today > 0 ? `今日 ${rec.today}` : '';
  const tip = $('woodfish-tip');
  if (tip) tip.textContent = `今日功德 ${rec.today} · 累计 ${rec.total}`;
  const box = $('woodfish');
  if (box) box.setAttribute('aria-label', `赛博木鱼：今日功德 ${rec.today}，累计 ${rec.total}。点击敲击`);
  return rec;
}

function wfHit() {
  const rec = wfRead();
  rec.today += 1;
  rec.total += 1;
  wfWrite(rec);
  wfRefresh();
  wfPlayTok();
  wfPress();
  wfBubble('功德 +1');
}

function initWoodfish() {
  const box = $('woodfish');
  if (!box) return;
  box.addEventListener('click', e => {
    e.preventDefault();
    wfHit();
  });
  // 键盘可敲：Enter / 空格
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    if (e.repeat) return; // 长按不连发，避免爆数据
    wfHit();
  });
  // 每次悬浮时重新读一次，跨天后 tooltip 立即变回 0
  box.addEventListener('mouseenter', wfRefresh);
  box.addEventListener('focus', wfRefresh);
  wfRefresh();
}

window.studyhubWoodfish = {
  hit: wfHit,
  stats: wfRead,
  reset: () => { wfWrite({ date: todayStr(), today: 0, total: 0 }); wfRefresh(); }
};


/* ===== 每日一签（localStorage 按日期记录，当天只弹一次） ===== */
const FORTUNE_KEY = 'studyhub.dailyFortune';
const FORTUNE_DELAY = 2000;
const FORTUNE_TUBE_ICON = '🎋';

const FORTUNES = [
  { level: '上上签', line: '今日宜：狂刷行测；忌：自我内耗。', sub: '稳住节奏，一天一天都是上岸的路。' },
  { level: '上上签', line: '今日宜：背二十个单词；忌：熬夜刷手机到凌晨。', sub: '四级不过如此，坚持才是一切。' },
  { level: '上上签', line: '今日宜：早睡一小时；忌：说“明天再开始”。', sub: '早睡是最便宜的记忆增强药。' },
  { level: '上上签', line: '今日宜：一鼓作气做完套卷；忌：写一行刷十分钟手机。', sub: '专注 25 分钟，胜过稀里糊涂 2 小时。' },
  { level: '上上签', line: '今日宜：把错题重新看一遍；忌：收藏了就等于学会了。', sub: '错过的题，才是真正的提分点。' },
  { level: '上上签', line: '今日宜：给爸妈打个电话；忌：一个人闷头硬撑。', sub: '你不是一个人在战斗。' },
  { level: '上上签', line: '今日宜：整理课表排好复习节奏；忌：随缘复习，见招拆招。', sub: '计划写下来，就成功了一半。' },
  { level: '上上签', line: '今日宜：认真吃早饭；忌：靠咖啡续命一整天。', sub: '胃舒服了，脑子才转得动。' },
  { level: '上上签', line: '今日宜：刷完一套资料分析；忌：焦虑排名而原地转圈。', sub: '行测是熟练度游戏，题感会来。' },
  { level: '上上签', line: '今日宜：晚上复盘今日进度；忌：无脑熬夜感动自己。', sub: '有效的努力，才值得被记录。' },
  { level: '上上签', line: '今日宜：把大目标拆成三件小事；忌：盯着终点吓自己。', sub: '一天做三件小事，一个学期就是大改变。' },
  { level: '上上签', line: '今日宜：离开座位走走、喝口水；忌：一坐就是一下午。', sub: '身体是所有努力的本钱。' },
  { level: '上上签', line: '今日宜：找一道难题问老师；忌：死磕到心态爆炸。', sub: '求助不是认输，是高效。' },
  { level: '上上签', line: '今日宜：和室友去吃顿好的；忌：边吃边卷自己。', sub: '开心一点，效率会回报你。' },
  { level: '上上签', line: '今日宜：对着镜子说一句“我可以”；忌：自我贬低。', sub: '你比想象中更有韧性。' },
  { level: '上上签', line: '今日宜：复习一遍昨天学的；忌：学了后面忘了前面。', sub: '艾宾浩斯曲线是你的朋友。' }
];

function fortunePick() {
  const saved = fortuneRead();
  // 已经抽过就沿用当天那一条，保证“同一天刷新看到的是同一支签”
  if (saved && saved.text) {
    const hit = FORTUNES.find(f => f.line === saved.text);
    if (hit) return hit;
    return { level: saved.level || '上上签', line: saved.text, sub: saved.sub || '' };
  }
  return FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
}

function fortuneRead() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(FORTUNE_KEY) || 'null'); } catch (e) { raw = null; }
  if (!raw || typeof raw !== 'object') return null;
  return raw.date === todayStr() ? raw : null;
}

function fortuneWrite(data) {
  try { localStorage.setItem(FORTUNE_KEY, JSON.stringify(data)); } catch (e) { /* 隐私模式忽略 */ }
}

function setFortuneDrawn(drawn) {
  const tube = $('fortune-tube');
  const paper = $('fortune-paper');
  const take = $('fortune-take');
  const tip = $('fortune-tip');
  if (tube) tube.classList.toggle('is-drawn', !!drawn);
  if (paper) paper.classList.toggle('hidden', !drawn);
  if (take) take.disabled = !drawn;
  if (tip) tip.textContent = drawn ? '这支签，今天属于你 🌿' : '诚心默念今日的小目标，再敲一敲签筒';
}

function renderFortune(f) {
  const line = $('fortune-line');
  const sub = $('fortune-sub');
  const title = $('fortune-title');
  if (title) title.textContent = `今日一签 · ${f.level || '上上签'}`;
  if (line) line.textContent = f.line;
  if (sub) sub.textContent = f.sub || '';
  setFortuneDrawn(true);
}

function drawFortune() {
  const tube = $('fortune-tube');
  if (!tube || tube.classList.contains('is-drawn')) return;
  tube.classList.remove('is-shaking');
  void tube.offsetWidth;
  tube.classList.add('is-shaking');

  const f = fortunePick();
  fortuneWrite({
    date: todayStr(),
    at: new Date().toISOString(),
    level: f.level,
    text: f.line,
    sub: f.sub,
    drawn: true,
    taken: false
  });
  // 摇一摇再揭签，节奏更顺
  setTimeout(() => renderFortune(f), 420);
}

function closeFortune() {
  const modal = $('fortune-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  const msg = $('fortune-msg');
  if (msg) msg.textContent = '';
}

function takeFortune() {
  const modal = $('fortune-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  const saved = fortuneRead();
  if (!saved || !saved.text) return; // 还没抽，按钮也是 disabled
  fortuneWrite(Object.assign({}, saved, { taken: true }));
  closeFortune();
  syncToast('签文已收下，今天也要加油哦 🌿');
}

function showFortuneModalIfNeeded(delay) {
  const modal = $('fortune-modal');
  if (!modal) return;
  const saved = fortuneRead();
  if (saved && saved.taken) return; // 今天已经收下签文，不再弹

  // 干扰弹窗：登录框 / 头像提示 / 倒计时新增 / 习惯确认 / 沉浸自习室 都别抢焦点
  const busy = ['auth-modal', 'avatar-alert', 'cd-modal', 'habit-alert']
    .some(id => { const el = $(id); return el && !el.classList.contains('hidden'); });
  if (busy || document.documentElement.classList.contains('studyroom-open')) return;

  modal.dataset.timer = String(setTimeout(() => {
    if (!fortuneRead()) {
      // 今天还没抽过：签筒待命
      setFortuneDrawn(false);
      const line = $('fortune-line');
      const sub = $('fortune-sub');
      if (line) line.textContent = '—';
      if (sub) sub.textContent = '—';
      const title = $('fortune-title');
      if (title) title.textContent = '今日一签';
    } else {
      renderFortune(fortunePick());
    }
    modal.classList.remove('hidden');
  }, delay || FORTUNE_DELAY));
}

function initFortune() {
  const modal = $('fortune-modal');
  const tube = $('fortune-tube');
  const take = $('fortune-take');
  const close = $('fortune-close');
  if (!modal) return;
  if (tube) tube.addEventListener('click', drawFortune);
  if (take) take.addEventListener('click', takeFortune);
  if (close) close.addEventListener('click', closeFortune);
  modal.addEventListener('click', e => {
    // 遮罩空白处点击：抽过签就当“收下”，没抽过就当稍后再看
    if (e.target !== modal) return;
    if (fortuneRead() && fortuneRead().text) takeFortune();
    else closeFortune();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (modal.classList.contains('hidden')) return;
    closeFortune();
  });
  showFortuneModalIfNeeded(FORTUNE_DELAY);
}

/* ===== 久坐 / 喝水提醒（45 分钟一次，纯前端定时器） ===== */
const HYDRATE_KEY = 'studyhub.hydrateReminder';
const HYDRATE_INTERVAL = 45 * 60 * 1000;   // 45 分钟
const HYDRATE_TEXT = '该起来接杯水啦，顺便伸个懒腰吧！💧';
const HYDRATE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
  '<path d="M12 2.6c-.35 0-.65.16-.86.42L5.2 10.6A8.3 8.3 0 0 0 3.7 15.2c0 4.6 3.7 8.2 8.3 8.2s8.3-3.6 8.3-8.2' +
  'c0-1.8-.6-3.4-1.5-4.6l-5.94-7.58A1.1 1.1 0 0 0 12 2.6Z" fill="currentColor"/></svg>';

const hydrate = { timer: 0, startedAt: 0, nextAt: 0, resting: true };   // resting=true 表示还没开启

function hydrateOn() {
  let raw = null;
  try { raw = localStorage.getItem(HYDRATE_KEY); } catch (e) { raw = null; }
  return raw === '1';
}

function hydrateWrite(on) {
  try {
    if (on) localStorage.setItem(HYDRATE_KEY, '1');
    else localStorage.removeItem(HYDRATE_KEY);
  } catch (e) { /* 隐私模式忽略 */ }
}

function hydrateSyncUI() {
  const fab = $('hydrate-fab');
  if (!fab) return;
  const on = !hydrate.resting;   // 唯一权威状态：resting=false 即提醒进行中
  fab.classList.toggle('is-on', on);
  fab.setAttribute('aria-pressed', on ? 'true' : 'false');
  fab.setAttribute('aria-label', on ? '喝水提醒：已开启，点击关闭' : '喝水提醒：未开启，点击开启');
  const tip = $('hydrate-tip');
  if (tip) {
    tip.innerHTML = on
      ? `喝水提醒已开启<br>每 ${HYDRATE_INTERVAL / 60000} 分钟提醒一次 · 点击关闭`
      : `喝水提醒：未开启<br>点击开启 · 每 ${HYDRATE_INTERVAL / 60000} 分钟提醒一次`;
  }
}

// 极短提示音：两下轻柔的马林巴式音符（正弦波 + 快速衰减），复用现有 AudioContext 思路但独立生成
let hydrateCtx = null;
function hydrateChime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!hydrateCtx) hydrateCtx = new AC();
    if (hydrateCtx.state === 'suspended') hydrateCtx.resume().catch(() => {});
    const ctx = hydrateCtx;
    const t0 = ctx.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const start = t0 + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.6);
    });
  } catch (e) {
    console.warn('[hydrate] 提示音播放失败', e);
  }
}

function hydrateFire() {
  hydrate.nextAt = Date.now() + HYDRATE_INTERVAL;
  cornerToast(HYDRATE_TEXT, 6000);
  hydrateChime();
}

function hydrateSchedule() {
  clearTimeout(hydrate.timer);
  hydrate.timer = 0;
  hydrate.startedAt = Date.now();
  hydrate.nextAt = hydrate.startedAt + HYDRATE_INTERVAL;
  // 用 setTimeout 链式续期而不是 setInterval：每次触发后重新计时，页面休眠后也不会“补弹”
  const loop = () => {
    hydrate.timer = 0;                  // 定时器已经触发，先清掉句柄，避免残留 id 干扰判断
    if (hydrate.resting) return;        // 已点关闭：不再续期
    hydrateFire();
    hydrate.timer = setTimeout(loop, HYDRATE_INTERVAL);
  };
  hydrate.timer = setTimeout(loop, HYDRATE_INTERVAL);
}

function hydrateStop() {
  clearTimeout(hydrate.timer);
  hydrate.timer = 0;
  hydrate.nextAt = 0;
}

// 关闭判定只看“是否处于休息态”，不依赖 timer 句柄——回调触发后的瞬间 timer 可能为 0
function hydrateToggle() {
  if (!hydrate.resting) {
    hydrate.resting = true;   // 先置休息态，避免同时在跑的 loop 立刻又复排定时器
    hydrateStop();
    hydrateWrite(false);
    hydrateSyncUI();
    syncToast('已关闭喝水提醒，记得自己也要多喝水哦 💧');
    return;
  }
  hydrate.resting = false;
  hydrateSchedule();
  hydrateWrite(true);
  hydrateSyncUI();
  syncToast(`喝水提醒已开启，${HYDRATE_INTERVAL / 60000} 分钟后提醒你一次 💧`);
}

function initHydrate() {
  const fab = $('hydrate-fab');
  if (!fab) return;
  fab.addEventListener('click', () => hydrateToggle());
  fab.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    if (e.repeat) return;
    hydrateToggle();
  });
  // 上次开着提醒的，刷新后自动续上（不跨会话计算剩余时间，重新从 45 分钟开始）
  if (hydrateOn()) { hydrate.resting = false; hydrateSchedule(); }
  else hydrate.resting = true;
  hydrateSyncUI();
}

window.studyhubWellness = {
  fortune: { open: () => showFortuneModalIfNeeded(0), close: closeFortune, data: fortuneRead },
  hydrate: {
    toggle: hydrateToggle,
    isOn: () => !hydrate.resting,
    nextAt: () => hydrate.nextAt
  }
};


/* ===== 全局粒子特效（纯代码，requestAnimationFrame，同屏 ≤ 20 个） =====
   只在私有数组里算坐标，直接写 element.style，不读布局；
   生命周期结束立刻从 DOM 与数组移除；指针事件整层穿透，不影响任何交互。 ===== */
const FX_KEY = 'studyhub.particles';
const FX_MAX = 20;             // 同屏粒子硬上限
const FX_TRAIL_GAP = 110;      // 两个拖尾粒子之间的最小距离（px）
const FX_TRAIL_COOLDOWN = 55;  // 连续移动时的最小发射间隔（ms）

const fx = {
  on: true,
  layer: null,
  parts: [],
  raf: 0,
  last: 0,
  lastEmit: 0,
  lastX: 0,
  lastY: 0,
  moved: false
};

function fxEnabled() {
  let raw = null;
  try { raw = localStorage.getItem(FX_KEY); } catch (e) { raw = null; }
  return raw !== '0';           // 默认开启
}

function fxPersist(on) {
  try {
    if (on) localStorage.removeItem(FX_KEY);   // 默认就是开，不需要存
    else localStorage.setItem(FX_KEY, '0');
  } catch (e) { /* 隐私模式忽略 */ }
}

// 指针是否落在页面“空白处”：排除表单、按钮、可交互悬浮球与弹窗内容
function fxOnBlankTarget(el) {
  if (!el || !el.closest) return true;
  return !el.closest('input, textarea, select, button, a, label, summary, [contenteditable="true"], ' +
    '.woodfish, .hydrate-fab, .noise-fab, .fx-toggle, .auth-card, .studyroom');
}

function fxSyncToggle() {
  const btn = $('fx-toggle');
  if (btn) {
    btn.classList.toggle('is-off', !fx.on);
    btn.setAttribute('aria-pressed', fx.on ? 'true' : 'false');
    btn.title = fx.on ? '关闭粒子特效' : '开启粒子特效';
    btn.setAttribute('aria-label', btn.title);
  }
  const layer = fx.layer || $('fx-layer');
  if (layer) layer.classList.toggle('is-off', !fx.on);
}

// 取顶层保留：不支持时就跳过该粒子
function fxCanvasPos(x, y) {
  let cx = x, cy = y;
  if (typeof document.elementFromPoint === 'function') {
    try {
      const top = document.elementFromPoint(x, y);
      if (top && (top.id === 'fx-layer' || (top.closest && top.closest('.fx-layer')))) {
        cx = x + 1;
        cy = y + 1;
      }
    } catch (e) { /* 忽略 */ }
  }
  return { x: cx, y: cy };
}

function fxSpawn(o) {
  if (!fx.on || !fx.layer) return null;
  if (fx.parts.length >= FX_MAX) return null;
  if (document.hidden) return null;

  const el = document.createElement('span');
  el.className = 'fx-p' + (o.burst ? ' is-burst' : '');
  el.style.setProperty('--s', o.size.toFixed(1) + 'px');
  el.style.setProperty('--c', o.color);
  el.style.setProperty('--a', o.alpha.toFixed(2));
  el.style.opacity = '0';
  fx.layer.appendChild(el);

  const p = {
    el,
    x: o.x, y: o.y,
    vx: o.vx || 0, vy: o.vy || 0,
    life: 0,
    max: o.life,
    size: o.size,
    base: o.size,          // 初始尺寸，缩放比例以它为分母
    rot: Math.random() * 360
  };
  fx.parts.push(p);
  fxStart();
  return p;
}

function fxTrail(x, y) {
  const burst = false;
  const dark = document.documentElement.classList.contains('dark');
  const color = Math.random() < 0.5 ? 'var(--particle-a)' : 'var(--particle-b)';
  fxSpawn({
    x, y,
    size: 7 + Math.random() * 9,               // 7 ~ 16px 的微弱光点
    life: 480 + Math.random() * 360,           // 0.5 ~ 0.85s 后消失
    vx: (Math.random() - 0.5) * 22,
    vy: -8 - Math.random() * 14,               // 轻微上浮
    alpha: dark ? 0.55 : 0.45,
    color,
    burst
  });
}

function fxBurst(x, y, count) {
  const n = count || (3 + Math.floor(Math.random() * 3));   // 3 ~ 5 个
  const dark = document.documentElement.classList.contains('dark');
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const speed = 60 + Math.random() * 70;
    fxSpawn({
      x, y,
      size: 6 + Math.random() * 8,
      life: 420 + Math.random() * 220,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 20,
      alpha: dark ? 0.9 : 0.8,
      color: Math.random() < 0.65 ? 'var(--particle-b)' : 'var(--particle-a)',
      burst: true
    });
  }
}

// 单个 rAF 循环驱动全部粒子：指数衰减 + 抛物线般的轻微重力
function fxFrame(now) {
  fx.raf = 0;
  if (!fx.on || !fx.parts.length) { fx.parts = []; return; }
  const dt = Math.min(48, (now - (fx.last || now)) / 1000);   // 切页/休眠回来时钳住，避免瞬移
  fx.last = now;
  const damping = Math.pow(0.06, dt);                          // 每秒衰减到 6%
  const keep = [];
  for (const p of fx.parts) {
    p.life += dt * 1000;
    const k = p.life / p.max;
    if (k >= 1) {
      if (p.el.parentNode) p.el.parentNode.removeChild(p.el);    // 生命周期结束立刻移除
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= damping;
    p.vy = p.vy * damping + 26 * dt;                            // 轻微下落，像星尘散开
    p.size *= Math.pow(0.55, dt);                               // 逐渐变小
    const scale = Math.min(1, Math.max(0.12, p.size / p.base));
    // 拖尾粒子：先淡入（前 12% 时间）再逐渐淡出
    const fadeIn = k < 0.12 ? k / 0.12 : 1;
    const fadeOut = 1 - k;
    p.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) scale(${scale.toFixed(2)}) rotate(${(p.rot * k).toFixed(0)}deg)`;
    p.el.style.opacity = Math.max(0, Math.min(1, fadeIn * fadeOut)).toFixed(2);
    keep.push(p);
  }
  fx.parts = keep;
  if (keep.length) fx.raf = requestAnimationFrame(fxFrame);
  else fx.last = 0;
}

function fxStart() {
  if (fx.raf || !fx.parts.length) return;
  fx.last = 0;
  fx.raf = requestAnimationFrame(fxFrame);
}

function fxClearAll() {
  if (fx.raf) { cancelAnimationFrame(fx.raf); fx.raf = 0; }
  for (const p of fx.parts) {
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
  }
  fx.parts = [];
  fx.last = 0;
}

function fxSetEnabled(on) {
  fx.on = !!on;
  fxPersist(fx.on);
  if (!fx.on) fxClearAll();
  fxSyncToggle();
}

/* ---- 事件：指针移动拖尾 ---- */
document.addEventListener('pointermove', e => {
  if (!fx.on || !e.isPrimary) return;
  if (e.pointerType === 'mouse' && e.buttons) return;   // 拖动/选中时不放粒子
  if (!fxOnBlankTarget(e.target)) return;
  const now = performance.now();
  const dx = e.clientX - fx.lastX;
  const dy = e.clientY - fx.lastY;
  const first = !fx.moved;
  fx.lastX = e.clientX;
  fx.lastY = e.clientY;
  fx.moved = true;
  if (first) { fx.lastEmit = 0; return; }               // 第一次移动只记坐标，立刻允许下一个点发射
  if (now - fx.lastEmit < FX_TRAIL_COOLDOWN) return;
  if (dx * dx + dy * dy < FX_TRAIL_GAP * FX_TRAIL_GAP) return;
  fx.lastEmit = now;
  const pos = fxCanvasPos(e.clientX, e.clientY);
  fxTrail(pos.x, pos.y);
}, { passive: true });

/* ---- 事件：点击爆发（不吃掉原点击，冒泡后照常触发） ---- */
document.addEventListener('click', e => {
  if (!fx.on) return;
  if (!fxOnBlankTarget(e.target)) return;               // 按钮等交互元素只响应自身，不额外放粒子
  const pos = fxCanvasPos(e.clientX, e.clientY);
  fxBurst(pos.x, pos.y);
});

/* ---- 事件：重新回到页面时清空残留 ---- */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) fxClearAll();
});

function initFx() {
  fx.layer = $('fx-layer');
  if (!fx.layer) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    fx.on = false;            // 系统要求减少动效时默认关闭
  } else {
    fx.on = fxEnabled();
  }
  const btn = $('fx-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      fxSetEnabled(!fx.on);
      syncToast(fx.on ? '粒子特效已开启 ✨' : '粒子特效已关闭，省电模式 🌙');
    });
  }
  fxSyncToggle();
}

window.studyhubFx = {
  toggle: fxSetEnabled,
  isOn: () => fx.on,
  count: () => fx.parts.length,
  burst: (x, y) => fxBurst(x, y),
  clear: fxClearAll
};


/* ===== 白噪音 · 黑胶唱片混音器（三路独立音频实时混音） ===== */
(function initNoise() {
  const deck = $('vinyl-deck');
  const mixer = $('mixer');
  if (!deck || !mixer) return;

  const hint = $('noise-hint');
  const powerBtn = $('vinyl-power');
  const disc = $('vinyl-disc');
  const tonearm = $('vinyl-tonearm');
  const sliders = Array.from(mixer.querySelectorAll('.mix-slider'));
  const audios = Array.from(document.querySelectorAll('.mix-audio'));
  const valEls = {
    rain: $('mix-val-rain'),
    cafe: $('mix-val-cafe'),
    wave: $('mix-val-wave')
  };
  const NAMES = { rain: '雨声', cafe: '咖啡馆', wave: '海浪' };
  const MAX_GAIN = 0.75;          // 单轨最大音量，避免三路叠加破音
  const saved = {};               // 每轨用户设定的 0~1 音量
  let paused = false;             // 用户按了暂停（滑杆值保留）
  let lastError = '';

  const audioOf = track => audios.find(a => a.dataset.track === track) || null;
  sliders.forEach(s => { saved[s.parentNode.dataset.track] = 0; });

  const setHint = text => { if (hint) hint.textContent = text || ''; };

  // 是否有任何一路在真正出声
  const anyAudible = () => Object.keys(saved).some(k => saved[k] > 0) && !paused;
  const anyVolume = () => Object.keys(saved).some(k => saved[k] > 0);

  // 唱片旋转 / 唱针起落：完全由 CSS 控制，这里只切 data 属性
  function syncDeck(playing) {
    deck.dataset.playing = playing ? 'true' : 'false';
    if (powerBtn) {
      powerBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
      powerBtn.title = playing ? '暂停混音' : '播放混音';
      powerBtn.setAttribute('aria-label', playing ? '暂停混音' : '播放混音');
      const icon = powerBtn.querySelector('.vinyl-power-icon');
      if (icon) icon.textContent = playing ? '❚❚' : '▶';
    }
    if (disc) disc.classList.toggle('is-spinning', playing);
    if (tonearm) tonearm.classList.toggle('is-down', playing);
  }

  function stepVolume() {
    audios.forEach(a => {
      const t = a.dataset.track;
      const v = (saved[t] || 0) * MAX_GAIN;
      try { a.volume = Math.max(0, Math.min(1, v)); } catch (e) { /* 忽略 */ }
    });
  }

  function pauseAll() {
    audios.forEach(a => { try { a.pause(); } catch (e) { /* 忽略 */ } });
    syncDeck(false);
    if (anyVolume()) setHint('已暂停，点播放继续');
    else setHint('拖动滑杆开始混音');
  }

  function playAll() {
    let started = 0;
    audios.forEach(a => {
      const t = a.dataset.track;
      if (!(saved[t] > 0)) { try { a.pause(); } catch (e) { /* 忽略 */ } return; }
      // 第一次发声时才写入音源，避免面板一打开就下载三个 mp3
      const row = mixer.querySelector('.mix-row[data-track="' + t + '"]');
      const src = row && row.querySelector('.mix-slider').getAttribute('data-src');
      if (src && a.getAttribute('src') !== src) a.src = src;
      if (a.paused) {
        const p = a.play();
        if (p && p.catch) {
          p.catch(err => {
            const msg = String((err && err.message) || err);
            if (!/interrupted|play\(\) request was interrupted/i.test(msg) && msg !== lastError) {
              lastError = msg;
              console.warn('[noise] play failed', err);
              setHint('音频加载失败，请检查网络或替换 data-src 链接');
            }
          });
        }
      }
      started++;
    });
    // 有任意一路在播放才让唱片转起来
    if (started > 0 && !paused) {
      syncDeck(true);
      const names = Object.keys(saved).filter(k => saved[k] > 0).map(k => NAMES[k]).join(' + ');
      setHint('正在混音：' + names);
    } else {
      syncDeck(false);
      // 有音量但已暂停 / 目前没有任何一路在出声，分别提示
      if (started === 0 && anyVolume()) setHint('已暂停，点播放继续');
      else if (started === 0) setHint('拖动滑杆开始混音');
    }
  }

  // 滑杆变化：实时改音量，按需起停
  function onSlider(e) {
    const input = e.target;
    if (!input || !input.dataset || input.dataset.src === undefined) return;
    const track = input.closest('.mix-row').dataset.track;
    const val = Math.max(0, Math.min(100, Number(input.value) || 0));
    saved[track] = val / 100;
    if (valEls[track]) valEls[track].textContent = val + '%';
    if (val > 0) paused = false;   // 任意滑杆被拉起来就视为想听
    stepVolume();
  }
  // 有无可闻音量 → 唱片转不转，一处判断（滑杆归零时也会走到这里）
  function syncAll() {
    if (anyAudible()) playAll(); else pauseAll();
  }
  sliders.forEach(s => {
    s.addEventListener('input', (e) => { onSlider(e); syncAll(); });
    s.addEventListener('change', (e) => { onSlider(e); syncAll(); });
  });

  // 电源键：有三路音轨在响 → 全部暂停；否则按当前滑杆值恢复播放
  if (powerBtn) {
    powerBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!anyVolume()) {
        setHint('先把任意一个滑杆拉起来吧');
        return;
      }
      paused = !paused;
      if (paused) {
        pauseAll();
        setHint('已暂停，点播放继续');
      } else {
        playAll();
      }
    });
  }

  audios.forEach(a => {
    a.addEventListener('error', () => {
      setHint('音频加载失败，请检查网络或替换 data-src 链接');
    });
  });

  syncDeck(false);
  setHint('拖动滑杆开始混音');
  window.studyhubNoise = {
    volumes: () => Object.assign({}, saved),
    play: () => { paused = false; playAll(); },
    pause: () => { paused = true; pauseAll(); }
  };
})();


/* ===== 桌面像素小盆栽（读取今日学习时长，纯展示，不写数据） ===== */
const PLANT_STAGE_TEXT = {
  0: { name: '枯草', tip: '今天还没开始专注呢，浇点学习时间吧 🌱' },
  1: { name: '小芽', tip: '小盆栽长出了嫩芽，继续保持哦！' },
  2: { name: '绿叶', tip: '绿叶茂盛起来啦，状态不错！' },
  3: { name: '开花', tip: '今天专注超过 3 小时，开花了！🌸' }
};
let plantLastStage = null;    // 上次渲染的阶段，liveUpdate 用它判断是否需要重绘
let plantLastMinutes = -1;

// 0 枯草 / 1 小芽（<60 分钟）/ 2 绿叶（60~180 分钟）/ 3 开花（>180 分钟）
function plantStageOf(minutes) {
  if (!(minutes > 0)) return 0;
  if (minutes < 60) return 1;
  if (minutes <= 180) return 2;
  return 3;
}

function plantMinutes() {
  const sec = todayStudySec(todayStr());
  return Math.max(0, Math.floor(sec / 60));
}

function renderPlant() {
  const fab = $('plant-fab');
  if (!fab) return;
  const stageEl = fab.querySelector('.plant-stage');
  const tip = $('plant-tip');
  const minutes = plantMinutes();
  const stage = plantStageOf(minutes);
  plantLastStage = stage;
  plantLastMinutes = minutes;
  if (stageEl) stageEl.dataset.stage = String(stage);
  fab.dataset.stage = String(stage);
  fab.classList.toggle('is-wilted', stage === 0);

  const tipText = `今日专注 ${minutes} 分钟，小盆栽正在努力生长哦！`;
  if (tip) tip.textContent = tipText;
  fab.setAttribute('aria-label', `今日专注 ${minutes} 分钟 · 小盆栽状态：${PLANT_STAGE_TEXT[stage].name}`);
  // 悬浮提示里补一句状态说明，方便一眼看出成长阶段
  if (tip) tip.dataset.stage = PLANT_STAGE_TEXT[stage].name;
  return { minutes, stage };
}

function initPlant() {
  const fab = $('plant-fab');
  if (!fab) return;
  renderPlant();
  window.studyhubPlant = { render: renderPlant, stage: () => plantStageOf(plantMinutes()), minutes: plantMinutes };
}

/* ===== 桌面随意贴（云端 stickies 表，未登录时 localStorage 兜底） ===== */
const STICKY_KEY = 'studyhub.stickyNotes';
const STICKY_TINTS_KEY = 'studyhub.stickyTints';
const STICKY_MAX = 30;
const STICKY_TINTS = ['butter', 'mint', 'sky', 'peach'];
const STICKY_SAVE_DELAY = 400;          // 拖动 / 输入统一防抖，避免频繁请求
const stickyUi = { drag: null, saveTimer: 0 };
const stickySync = { rows: [], loaded: false, loading: false, pending: new Map() };

// tint（便签颜色）是纯视觉偏好，云端表里没有这一列，继续存本机
function stickyTintsRead() {
  try {
    const raw = JSON.parse(localStorage.getItem(STICKY_TINTS_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    return {};
  }
}

function stickyTintSave(id, tint) {
  if (!id || !tint) return;
  const all = stickyTintsRead();
  all[String(id)] = tint;
  try { localStorage.setItem(STICKY_TINTS_KEY, JSON.stringify(all)); } catch (e) { /* 隐私模式忽略 */ }
}

function stickyNormalize(n) {
  const tints = stickyTintsRead();
  const stored = tints[String(n.id)];
  return {
    id: String(n.id),
    text: String(n.text == null ? '' : n.text),
    x: Math.max(0, Math.round(Number(n.x) || 0)),
    y: Math.max(0, Math.round(Number(n.y) || 0)),
    tint: STICKY_TINTS.includes(n.tint) ? n.tint : (STICKY_TINTS.includes(stored) ? stored : 'butter')
  };
}

function stickyLocalRead() {
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem(STICKY_KEY) || '[]'); } catch (e) { raw = []; }
  return (Array.isArray(raw) ? raw : [])
    .filter(n => n && typeof n === 'object' && n.id)
    .map(stickyNormalize);
}

function stickyLocalWrite(list) {
  try { localStorage.setItem(STICKY_KEY, JSON.stringify(list)); }
  catch (e) { console.warn('[sticky] 本地保存失败', e); }
}

// 读：登录并拉取过就用云端缓存；否则用 localStorage
function stickyRead() {
  return stickySync.loaded ? stickySync.rows.slice() : stickyLocalRead();
}

function stickyClient() {
  return cloud.client || window.studyhubClient || null;
}

function stickyRowToNote(r) {
  return stickyNormalize({ id: r.id, text: r.content, x: r.pos_x, y: r.pos_y });
}

const STICKY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 写：改内存（云端模式）或 localStorage（未登录模式）
function stickyWrite(list) {
  if (stickySync.loaded) stickySync.rows = list.slice();
  else stickyLocalWrite(list);
}

function stickyQueueUpsert(note) {
  stickySync.pending.set(String(note.id), { note: Object.assign({}, note), removed: false });
  stickyFlushSoon();
}

function stickyQueueDelete(id) {
  stickySync.pending.set(String(id), { removed: true });
  stickyFlushSoon();
}

function stickyFlushSoon() {
  clearTimeout(stickyUi.saveTimer);
  stickyUi.saveTimer = setTimeout(stickyFlush, STICKY_SAVE_DELAY);
}

async function stickyFlush() {
  clearTimeout(stickyUi.saveTimer);
  stickyUi.saveTimer = 0;
  if (!stickySync.pending.size) return;
  const client = stickyClient();
  if (!client) return;                       // 未登录：等登录后统一迁移
  if (!cloud.user) await ensureCloudUser();
  const uid = cloud.user && cloud.user.id;
  if (!uid) return;

  const batch = Array.from(stickySync.pending.entries());
  stickySync.pending.clear();

  for (const [id, op] of batch) {
    try {
      if (op.removed) {
        if (!STICKY_UUID_RE.test(String(id))) continue;   // 本地临时 id 还没入库，直接丢弃
        const { error } = await client.from('stickies').delete().eq('id', id).eq('user_id', uid);
        if (error) throw error;
        continue;
      }
      const note = op.note;
      if (!STICKY_UUID_RE.test(String(note.id))) {
        // 新便签：不带 id，让数据库生成 uuid
        const { data, error } = await client.from('stickies')
          .insert({ user_id: uid, content: note.text, pos_x: note.x, pos_y: note.y })
          .select().single();
        if (error) throw error;
        if (data && data.id) {
          stickySync.rows = stickySync.rows.map(n => (n.id === note.id ? Object.assign({}, n, { id: String(data.id) }) : n));
          stickyTintSave(data.id, note.tint);
          stickyRender();
        }
        continue;
      }
      const { error } = await client.from('stickies').upsert({
        id: note.id, user_id: uid, content: note.text, pos_x: note.x, pos_y: note.y
      }, { onConflict: 'id' });
      if (error) throw error;
      stickyTintSave(note.id, note.tint);
      // 云端没有这一行时 upsert 会插入，这里缓存指向的仍是同一 id，无需换号
    } catch (err) {
      console.warn('[sticky] 云端保存失败', err);
      stickySync.pending.set(id, op);       // 放回队列，稍后重试
      syncError('便签同步失败：' + ((err && err.message) || '请检查网络或 RLS'));
      break;
    }
  }
  if (stickySync.pending.size) stickyFlushSoon();
}

// 登录后拉取：云端为空且本机有数据时，先把本机便签迁上去
async function stickyPull() {
  const client = stickyClient();
  if (!client) return;
  if (!cloud.user) await ensureCloudUser();
  const uid = cloud.user && cloud.user.id;
  if (!uid) return;
  stickySync.loading = true;
  try {
    const { data, error } = await client.from('stickies')
      .select('*').eq('user_id', uid).order('updated_at', { ascending: true });
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []).map(stickyRowToNote);
    const local = stickyLocalRead();

    if (!rows.length && local.length) {
      for (const n of local) {
        try {
          const { data: saved, error: insErr } = await client.from('stickies')
            .insert({ user_id: uid, content: n.text, pos_x: n.x, pos_y: n.y })
            .select().single();
          if (insErr) throw insErr;
          if (saved && saved.id) {
            stickyTintSave(saved.id, n.tint);
            rows.push(stickyRowToNote(saved));
          }
        } catch (err) {
          console.warn('[sticky] 迁移失败', err);
        }
      }
      if (rows.length) syncToast('本机便签已迁移到云端 ☁️');
    }

    stickySync.rows = rows;
    stickySync.loaded = true;
    stickyRender();
  } catch (err) {
    console.warn('[sticky] 拉取失败，继续用本机数据', err);
    const msg = String((err && err.message) || '');
    if (/does not exist|schema cache/i.test(msg)) {
      syncError('stickies 表还没建好：请先在 Supabase SQL Editor 执行便签建表 SQL');
    } else {
      syncError('便签读取失败：' + (msg || '请检查网络或 RLS'));
    }
  } finally {
    stickySync.loading = false;
  }
}

// 退出登录：回到本机模式
function stickyResetLocal() {
  stickySync.rows = [];
  stickySync.loaded = false;
  stickySync.pending.clear();
  clearTimeout(stickyUi.saveTimer);
  stickyUi.saveTimer = 0;
  stickyRender();
}

function stickyField() {
  return Math.max(240, document.documentElement.scrollWidth || window.innerWidth || 800);
}

// 让便签始终留在可视范围内
function stickyClamp(x, y) {
  const w = document.documentElement.clientWidth || window.innerWidth || 800;
  const h = window.innerHeight || 600;
  return {
    x: Math.min(Math.max(8, Math.round(x)), Math.max(8, w - 200)),
    y: Math.min(Math.max(8, Math.round(y)), Math.max(8, h - 120))
  };
}

function stickyRender() {
  const layer = $('sticky-layer');
  if (!layer) return;
  const notes = stickyRead();
  layer.innerHTML = notes.map(n => `<div class="sticky-note tint-${esc(n.tint)}" data-note-id="${esc(n.id)}"
      style="left:${n.x}px;top:${n.y}px" role="group" aria-label="便签">
      <div class="sticky-bar" data-note-drag aria-label="拖动便签" title="拖动移动位置">
        <span class="sticky-grip" aria-hidden="true">••••</span>
      </div>
      <button class="sticky-del" type="button" data-note-del="${esc(n.id)}" title="删除便签" aria-label="删除便签">×</button>
      <textarea class="sticky-text" data-note-text="${esc(n.id)}" maxlength="500"
        placeholder="写点什么…" aria-label="便签内容">${esc(n.text)}</textarea>
    </div>`).join('');
  stickyUi.notes = notes;
}

function stickyAdd(x, y) {
  const notes = stickyRead();
  if (notes.length >= STICKY_MAX) { syncToast(`最多只能贴 ${STICKY_MAX} 张便签哦`); return; }
  const pos = stickyClamp(x, y);
  const newId = (window.crypto && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()               // 提前生成合法 uuid，离线也能保持 id 稳定
    : uid();
  const note = stickyNormalize({
    id: newId, text: '', x: pos.x, y: pos.y,
    tint: STICKY_TINTS[notes.length % STICKY_TINTS.length]
  });
  notes.push(note);
  stickyWrite(notes);
  stickyRender();
  stickyQueueUpsert(note);              // 400ms 后写云端
  const ta = document.querySelector('[data-note-text="' + note.id + '"]');
  if (ta) {
    try { ta.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
  }
}

function stickyUpdate(id, patch) {
  const notes = stickyRead();
  const hit = notes.find(n => n.id === String(id));
  if (!hit) return;
  Object.assign(hit, patch);
  stickyWrite(notes);
  stickyQueueUpsert(hit);               // 输入 / 拖动都走 400ms 防抖
}

function stickyDelete(id) {
  const notes = stickyRead().filter(n => n.id !== String(id));
  stickyWrite(notes);
  stickyRender();
  stickyQueueDelete(id);
}

// 双击生成便签：排除输入框、按钮、以及已有的便签内部
function stickyOnBlank(target) {
  if (!target || !target.closest) return true;
  return !target.closest('input, textarea, select, button, a, label, summary, [contenteditable="true"], ' +
    '.sticky-note, .auth-card, .auth-modal, .studyroom, .woodfish, .hydrate-fab, .plant-fab, .noise-fab, .fx-toggle');
}

function initSticky() {
  const layer = $('sticky-layer');
  if (!layer) return;
  stickyRender();

  document.addEventListener('dblclick', e => {
    if (!stickyOnBlank(e.target)) return;
    if (document.documentElement.classList.contains('studyroom-open')) return;
    // 双击选中的文字不生成便签
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).trim()) return;
    e.preventDefault();
    stickyAdd(e.clientX - 80, e.clientY - 18);
  });

  // 输入：防抖 400ms 保存（不重建 DOM，避免打断打字）
  layer.addEventListener('input', e => {
    const ta = e.target.closest('.sticky-text');
    if (!ta) return;
    const id = ta.dataset.noteText;
    const val = ta.value;
    clearTimeout(stickyUi.saveTimer);
    stickyUi.saveTimer = setTimeout(() => stickyUpdate(id, { text: val }), STICKY_SAVE_DELAY);
  });
  // 失焦立刻保存
  layer.addEventListener('focusout', e => {
    const ta = e.target.closest('.sticky-text');
    if (!ta) return;
    clearTimeout(stickyUi.saveTimer);
    stickyUpdate(ta.dataset.noteText, { text: ta.value });
  });
  layer.addEventListener('click', e => {
    const del = e.target.closest('[data-note-del]');
    if (del) {
      e.stopPropagation();
      stickyDelete(del.dataset.noteDel);
    }
  });

  // 拖拽：按住顶部小条移动，松手写回坐标（写回同样走 400ms 防抖的 stickyUpdate）
  layer.addEventListener('pointerdown', e => {
    const bar = e.target.closest('[data-note-drag]');
    if (!bar) return;
    const note = bar.closest('.sticky-note');
    if (!note) return;
    e.preventDefault();
    stickyUi.drag = {
      el: note,
      id: note.dataset.noteId,
      startX: e.clientX,
      startY: e.clientY,
      originX: parseFloat(note.style.left) || 0,
      originY: parseFloat(note.style.top) || 0
    };
    note.classList.add('is-dragging');
    try { bar.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  });
  // 拖动中每 400ms 最多提交一次坐标（长距离慢拖也能上云，不用等松手）
  layer.addEventListener('pointermove', e => {
    const d = stickyUi.drag;
    if (!d) return;
    const pos = stickyClamp(d.originX + (e.clientX - d.startX), d.originY + (e.clientY - d.startY));
    d.el.style.left = pos.x + 'px';
    d.el.style.top = pos.y + 'px';
    d.pos = pos;
    if (!d.lastSave || Date.now() - d.lastSave > STICKY_SAVE_DELAY) {
      d.lastSave = Date.now();
      stickyUpdate(d.id, { x: pos.x, y: pos.y });
    }
  });
  const endDrag = () => {
    const d = stickyUi.drag;
    if (!d) return;
    stickyUi.drag = null;
    d.el.classList.remove('is-dragging');
    const pos = d.pos || { x: d.originX, y: d.originY };
    stickyUpdate(d.id, { x: pos.x, y: pos.y });
  };
  layer.addEventListener('pointerup', endDrag);
  layer.addEventListener('pointercancel', endDrag);

  // 窗口尺寸变化时把越界的便签收回来
  window.addEventListener('resize', () => {
    const notes = stickyRead();
    let changed = false;
    notes.forEach(n => {
      const p = stickyClamp(n.x, n.y);
      if (p.x !== n.x || p.y !== n.y) { n.x = p.x; n.y = p.y; changed = true; }
    });
    if (changed) { stickyWrite(notes); stickyRender(); }
  });

  window.studyhubSticky = {
    add: stickyAdd,
    list: stickyRead,
    pull: stickyPull,
    rows: () => stickySync.rows.slice(),
    clear: () => {
      const ids = stickyRead().map(n => n.id);
      stickyWrite([]);
      stickyRender();
      ids.forEach(stickyQueueDelete);
    }
  };
}


/* ===== 时间胶囊（云端 time_capsules 表，未登录时 localStorage 兜底） ===== */
const CAPSULE_KEY = 'studyhub.timeCapsules';
const CAPSULE_MAX = 50;
let capsuleViewId = '';
const capsuleSync = { rows: [], loaded: false, loading: false };

function capsuleClient() {
  return cloud.client || window.studyhubClient || null;
}

function capsuleNormalize(c) {
  return {
    id: String(c.id),
    text: String(c.text == null ? '' : c.text),
    createdAt: String(c.createdAt || ''),
    unlockDate: /^\d{4}-\d{2}-\d{2}$/.test(String(c.unlockDate || '')) ? String(c.unlockDate) : todayStr()
  };
}

function capsuleLocalRead() {
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem(CAPSULE_KEY) || '[]'); } catch (e) { raw = []; }
  return (Array.isArray(raw) ? raw : [])
    .filter(c => c && typeof c === 'object' && c.id && c.text)
    .map(capsuleNormalize)
    .sort((a, b) => a.unlockDate.localeCompare(b.unlockDate));
}

function capsuleLocalWrite(list) {
  try { localStorage.setItem(CAPSULE_KEY, JSON.stringify(list)); } catch (e) { console.warn('[capsule] 本地保存失败', e); }
}

// 读：登录并拉取过就用云端缓存；否则用 localStorage
function capsuleRead() {
  return capsuleSync.loaded ? capsuleSync.rows.slice() : capsuleLocalRead();
}

function capsuleWrite(list) {
  if (capsuleSync.loaded) capsuleSync.rows = list.slice();
  else capsuleLocalWrite(list);
}

function capsuleRowToItem(r) {
  return capsuleNormalize({
    id: r.id,
    text: r.content,
    createdAt: r.created_at,
    unlockDate: String(r.unlock_date || '').slice(0, 10)
  });
}

// 云端拉取：本机有、云端没有的，登录后自动迁上去（按内容+解锁日去重）
async function capsulePull() {
  const client = capsuleClient();
  if (!client) return;
  if (!cloud.user) await ensureCloudUser();
  const uid = cloud.user && cloud.user.id;
  if (!uid) return;
  capsuleSync.loading = true;
  try {
    const { data, error } = await client.from('time_capsules')
      .select('*').eq('user_id', uid).order('unlock_date', { ascending: true });
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []).map(capsuleRowToItem);
    const local = capsuleLocalRead();
    const seen = new Set(rows.map(r => r.unlockDate + '|' + r.text));

    const toMigrate = local.filter(l => !seen.has(l.unlockDate + '|' + l.text));
    for (const c of toMigrate) {
      try {
        const { data: saved, error: insErr } = await client.from('time_capsules')
          .insert({ user_id: uid, content: c.text, unlock_date: c.unlockDate })
          .select().single();
        if (insErr) throw insErr;
        if (saved) rows.push(capsuleRowToItem(saved));
      } catch (err) {
        console.warn('[capsule] 迁移失败', err);
      }
    }
    if (toMigrate.length && rows.length) syncToast('本机时间胶囊已迁移到云端 ☁️');

    capsuleSync.rows = rows.sort((a, b) => a.unlockDate.localeCompare(b.unlockDate));
    capsuleSync.loaded = true;
    capsuleRender();
  } catch (err) {
    console.warn('[capsule] 拉取失败，继续用本机数据', err);
    const msg = String((err && err.message) || '');
    if (/does not exist|schema cache/i.test(msg)) {
      syncError('time_capsules 表还没建好：请先在 Supabase SQL Editor 执行建表 SQL');
    } else {
      syncError('时间胶囊读取失败：' + (msg || '请检查网络或 RLS'));
    }
  } finally {
    capsuleSync.loading = false;
  }
}

// 退出登录：回到本机模式
function capsuleResetLocal() {
  capsuleSync.rows = [];
  capsuleSync.loaded = false;
  capsuleRender();
}

function capsuleDaysLeft(unlockDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(unlockDate || ''));
  if (!m) return 0;
  const target = new Date(+m[1], +m[2] - 1, +m[3]);
  return Math.round((target - parseDate(todayStr())) / 86400000);
}

// 按系统日期判断：到了解锁日（含）即可打开
function capsuleUnlocked(c) {
  return todayStr() >= c.unlockDate;
}

function capsuleMsg(text, ok) {
  const el = $('capsule-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function capsuleRender() {
  const zone = $('capsule-zone');
  const list = $('capsule-list');
  if (!zone || !list) return;
  const items = capsuleRead();
  zone.classList.toggle('hidden', !items.length);
  if (!items.length) { list.innerHTML = ''; return; }
  list.innerHTML = items.map(c => {
    const open = capsuleUnlocked(c);
    const left = capsuleDaysLeft(c.unlockDate);
    const meta = open
      ? `已解锁 · ${c.unlockDate}`
      : `还有 ${left} 天解锁 · ${c.unlockDate}`;
    return `<button class="capsule-card${open ? ' is-open' : ''}" type="button" data-capsule="${esc(c.id)}"
        aria-label="${open ? '打开这封已解锁的信' : '这封信还没到解锁日期'}">
        <span class="capsule-icon" aria-hidden="true">${open ? '✉️' : '🔒'}</span>
        <span class="capsule-main">
          <span class="capsule-title">${open ? '解锁的信' : '写给未来的信'}</span>
          <span class="capsule-meta">${esc(meta)}</span>
        </span>
        <span class="capsule-action">${open ? '查看' : '未解锁'}</span>
      </button>`;
  }).join('');
}

function capsuleOpenForm() {
  const wrap = $('capsule-form-wrap');
  if (!wrap) return;
  const show = wrap.classList.contains('hidden');
  wrap.classList.toggle('hidden', !show);
  capsuleMsg('');
  const dateEl = $('capsule-date');
  if (show && dateEl) {
    // 用 setAttribute 写 min：部分浏览器对 input.min 属性支持不一致，这里统一用属性设置
    dateEl.setAttribute('min', addDays(todayStr(), 1));   // 至少明天
    dateEl.value = addDays(todayStr(), 30);               // 默认 30 天后
    const ta = $('capsule-text');
    if (ta) setTimeout(() => { try { ta.focus(); } catch (e) { /* 忽略 */ } }, 60);
  }
}

async function capsuleSave() {
  const text = String(($('capsule-text') || {}).value || '').trim();
  const unlockDate = String(($('capsule-date') || {}).value || '').trim();
  if (!text) { capsuleMsg('先写点什么给未来的自己吧'); return; }
  if (text.length > 500) { capsuleMsg('最多 500 字哦'); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(unlockDate)) { capsuleMsg('请选择解锁日期'); return; }
  if (unlockDate <= todayStr()) { capsuleMsg('解锁日期要在明天以后'); return; }

  const list = capsuleRead();
  if (list.length >= CAPSULE_MAX) { capsuleMsg(`最多保存 ${CAPSULE_MAX} 封信`); return; }
  const saveBtn = $('capsule-save');
  if (saveBtn && saveBtn.disabled) return;

  const tempId = (window.crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : uid();
  const item = { id: tempId, text, createdAt: new Date().toISOString(), unlockDate };

  const client = capsuleClient();
  let uidNow = null;
  if (client) {
    if (!cloud.user) await ensureCloudUser();
    uidNow = cloud.user && cloud.user.id;
  }

  if (client && uidNow) {
    // 云端模式：插入成功后再落本地缓存，失败不丢内容
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '封存中…'; }
    try {
      const { data, error } = await client.from('time_capsules')
        .insert({ user_id: uidNow, content: text, unlock_date: unlockDate })
        .select().single();
      if (error) throw error;
      const saved = data ? capsuleRowToItem(data) : item;
      capsuleWrite(capsuleRead().concat([saved]).sort((a, b) => a.unlockDate.localeCompare(b.unlockDate)));
      // 云端模式下拉取过的列表就是真相，同时把本机缓存同步一份，离线也能看到
      if (capsuleSync.loaded) capsuleLocalWrite(capsuleSync.rows);
    } catch (err) {
      console.warn('[capsule] 云端保存失败', err);
      capsuleMsg('云端保存失败：' + ((err && err.message) || '请检查网络或 RLS'));
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '封存这封信'; }
      return;
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '封存这封信'; }
    }
  } else {
    // 未登录：存本机，登录后会自动迁移到云端
    capsuleWrite(list.concat([item]).sort((a, b) => a.unlockDate.localeCompare(b.unlockDate)));
  }

  const ta = $('capsule-text');
  if (ta) ta.value = '';
  $('capsule-form-wrap').classList.add('hidden');
  capsuleMsg('');
  capsuleRender();
  syncToast(`信已封存，${capsuleDaysLeft(unlockDate)} 天后自动解锁 ✉️`);
}

function capsuleOpenView(id) {
  const item = capsuleRead().find(c => c.id === String(id));
  if (!item) return;
  if (!capsuleUnlocked(item)) {
    const left = capsuleDaysLeft(item.unlockDate);
    syncToast(left > 0 ? `这封信还有 ${left} 天才能打开哦 🔒` : '这封信还没到解锁日期');
    return;
  }
  capsuleViewId = item.id;
  const modal = $('capsule-view');
  const textEl = $('capsule-view-text');
  const metaEl = $('capsule-view-meta');
  const titleEl = $('capsule-view-title');
  if (titleEl) titleEl.textContent = '✉️ 解锁的信';
  if (metaEl) {
    const created = item.createdAt ? new Date(item.createdAt) : null;
    const createdText = created && !isNaN(created.getTime())
      ? `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`
      : '—';
    metaEl.textContent = `写于 ${createdText} · 解锁于 ${item.unlockDate}`;
  }
  if (textEl) textEl.textContent = item.text;
  if (modal) {
    modal.classList.remove('hidden');
    const ok = $('capsule-view-ok');
    if (ok) try { ok.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
  }
  void capsuleViewId;
}

function capsuleCloseView() {
  const modal = $('capsule-view');
  if (modal) modal.classList.add('hidden');
  capsuleViewId = '';
}

function initCapsules() {
  const list = $('capsule-list');
  const openBtn = $('capsule-open');
  const saveBtn = $('capsule-save');
  const cancelBtn = $('capsule-cancel');
  const viewModal = $('capsule-view');
  if (openBtn) openBtn.addEventListener('click', capsuleOpenForm);
  if (saveBtn) saveBtn.addEventListener('click', capsuleSave);
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    $('capsule-form-wrap').classList.add('hidden');
    capsuleMsg('');
  });
  if (list) {
    list.addEventListener('click', e => {
      const card = e.target.closest('[data-capsule]');
      if (card) capsuleOpenView(card.dataset.capsule);
    });
  }
  const closeBtn = $('capsule-view-close');
  const okBtn = $('capsule-view-ok');
  if (closeBtn) closeBtn.addEventListener('click', capsuleCloseView);
  if (okBtn) okBtn.addEventListener('click', capsuleCloseView);
  if (viewModal) viewModal.addEventListener('click', e => { if (e.target === viewModal) capsuleCloseView(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (viewModal && !viewModal.classList.contains('hidden')) capsuleCloseView();
  });
  capsuleRender();
}

window.studyhubCapsule = {
  list: capsuleRead,
  open: capsuleOpenView,
  render: capsuleRender,
  save: capsuleSave,
  pull: capsulePull,
  rows: () => capsuleSync.rows.slice()
};


/* ===== 右下角折叠悬浮菜单（纯 UI 收纳：不改动任何业务逻辑） ===== */
function initFabDock() {
  const dock = $('fab-dock');
  const main = $('fab-main');
  if (!dock || !main) return;

  const isOpen = () => dock.dataset.open === 'true';

  function setOpen(open) {
    if (open === isOpen()) return;
    dock.dataset.open = open ? 'true' : 'false';
    main.setAttribute('aria-expanded', open ? 'true' : 'false');
    main.setAttribute('aria-label', open ? '收起快捷工具' : '打开快捷工具');
    // 收起时顺手关闭已经展开的白噪音面板，避免下次点开时它盖住其它球
    if (!open) {
      const noise = $('noise-fab');
      if (noise && noise.open) noise.open = false;
    }
  }

  main.addEventListener('click', e => {
    e.stopPropagation();
    setOpen(!isOpen());
  });

  // 点击页面其他空白处收起（点菜单内部不收起）
  document.addEventListener('click', e => {
    if (!isOpen()) return;
    if (e.target === main) return;
    if (e.target && e.target.closest && e.target.closest('#fab-dock')) return;
    setOpen(false);
  });

  // Esc 收起
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen()) setOpen(false);
  });

  // 进入全屏自习室时强制收起
  const enterBtn = $('studyroom-btn');
  if (enterBtn) enterBtn.addEventListener('click', () => setOpen(false));

  // 监听自习室开合：打开时收起并隐藏（自习室本身 z-index 更高，这里双保险）
  const html = document.documentElement;
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      const open = html.classList.contains('studyroom-open');
      dock.classList.toggle('is-hidden-in-studyroom', open);
      if (open) setOpen(false);
    }).observe(html, { attributes: true, attributeFilter: ['class'] });
  }

  window.studyhubFab = { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!isOpen()) };
}

/* ===== 启动 ===== */
(function init() {
  const TABS = ['dash', 'courses', 'tasks', 'fitness', 'mood', 'stats', 'plans'];
  const hashTab = (location.hash || '').replace('#', '');
  if (TABS.includes(hashTab)) state.ui.tab = hashTab;
  if (!TABS.includes(state.ui.tab)) state.ui.tab = 'dash'; // 旧存档可能停在已删除的倒计时页
  state.ui.taskDate = todayStr();
  taskDatePicked = false;
  if (!Number(state.ui.focusMin)) state.ui.focusMin = 25;
  // 专注会话指向的任务被删除/已完成时清理
  if (state.focus && !state.tasks.some(t => t.id === state.focus.taskId && !t.done)) state.focus = null;
  fitToday = todayStr();
  if (ensureRecurringInstances() > 0) saveLocal(); // 打开网页时补齐当天的重复任务
  switchTab();
  renderAll();
  initMoods();
  initPlans();
  initCustomCountdowns();
  initHabits();
  initStudyroom();
  initWoodfish();
  initHydrate();
  initPlant();
  initSticky();
  initCapsules();
  initFortune();
  initFx();
  initFabDock();
  save(); // 持久化一次性迁移标记
  initCloud();
  liveUpdate();
  setInterval(liveUpdate, 1000);
})();
