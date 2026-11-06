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

function handleAuthUser(user) {
  const prevId = cloud.user && cloud.user.id;
  cloud.user = user || null;
  if (!user) {
    if (cloud.client && cloud.channel) { cloud.client.removeChannel(cloud.channel); cloud.channel = null; }
    onMoodAuth(null);
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

function renderMoods() {
  const list = $('mood-list');
  if (!list) return;
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

async function loadMoods() {
  const uid = cloud.user && cloud.user.id;
  if (!uid) {
    moodRows = [];
    renderMoods();
    return;
  }
  moodRows = moodCacheRead(uid);
  renderMoods();

  const client = moodClient();
  if (!client) return;
  const seq = moodSeq;
  try {
    const { data, error } = await client.from('moods')
      .select('id, content, created_at')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (seq !== moodSeq) return; // 查询期间发生了增删，丢弃这份旧快照
    if (!cloud.user || cloud.user.id !== uid) return; // 请求期间切换了账号
    moodRows = Array.isArray(data) ? data : [];
    moodCacheWrite(uid, moodRows);
    renderMoods();
    moodMsg('');
  } catch (err) {
    console.warn('[mood] load failed', err);
    if (!moodRows.length) moodMsg(moodErrorText(err));
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

  renderMoods();
}

window.studyhubMoods = { reload: loadMoods, add: addMood };


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
}

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
    const tip = `${WEEKDAYS[i]} ${weekDateLabel(d.date)}，专注 ${minutes} 分钟`;
    const cls = ['weekly-col'];
    if (isToday) cls.push('today');
    if (isFuture) cls.push('future');
    return `<div class="${cls.join(' ')}" style="--bar:${pct.toFixed(1)}%" title="${tip}" aria-label="${tip}">
      <div class="weekly-plot">
        <span class="weekly-val">${minutes}</span>
        <div class="weekly-bar${isZero ? ' is-zero' : ''}"></div>
      </div>
      <div class="weekly-axis"><b>${WEEKDAYS[i]}</b><span>${weekDateLabel(d.date)}</span></div>
    </div>`;
  }).join('');
  chartEl.setAttribute('aria-label',
    '本周每日专注分钟数：' + report.days.map((d, i) => `${WEEKDAYS[i]} ${reportMinutes(d.seconds)} 分钟`).join('，'));

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
            <span class="weekly-rank-min">${c.minutes} 分钟</span>
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
    if (ensureRecurringInstances() > 0) {
      save();
      renderAll();
    }
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
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + state.ui.tab));
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
    loadMoods();
  } else if (state.ui.tab === 'stats') {
    renderStats();
  }
}

// 手动改 hash / 浏览器前进后退时也同步刷新
window.addEventListener('hashchange', () => {
  const tab = (location.hash || '').replace('#', '');
  if (!['dash', 'courses', 'tasks', 'fitness', 'mood', 'stats'].includes(tab) || tab === state.ui.tab) return;
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

/* ===== 白噪音 ===== */
(function initNoise() {
  const audio = $('noise-audio');
  const hint = $('noise-hint');
  const buttons = Array.from(document.querySelectorAll('.noise-btn'));
  if (!audio || !buttons.length) return;

  let current = null;
  const setHint = text => { if (hint) hint.textContent = text || ''; };
  const markActive = btn => {
    buttons.forEach(b => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  };
  const stopNoise = () => {
    audio.pause();
    current = null;
    markActive(null);
    setHint('');
  };
  const playNoise = btn => {
    if (current === btn && !audio.paused) { stopNoise(); return; }
    const src = btn.dataset.src;
    if (!src) return;
    if (audio.getAttribute('src') !== src) audio.src = src;
    audio.volume = 0.45;
    const playing = audio.play();
    if (playing && playing.catch) {
      playing.catch(err => {
        if (current !== btn) return;
        console.warn('[noise] play failed', err);
        setHint('音频加载失败，请检查网络或替换 data-src 链接');
        current = null;
        markActive(null);
      });
    }
    current = btn;
    markActive(btn);
    setHint(`正在播放：${btn.dataset.name || ''}`);
  };
  buttons.forEach(btn => btn.addEventListener('click', () => playNoise(btn)));
  audio.addEventListener('error', () => {
    if (!current) return;
    setHint('音频加载失败，请检查网络或替换 data-src 链接');
    current = null;
    markActive(null);
  });
})();

/* ===== 启动 ===== */
(function init() {
  const TABS = ['dash', 'courses', 'tasks', 'fitness', 'mood', 'stats'];
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
  save(); // 持久化一次性迁移标记
  initCloud();
  liveUpdate();
  setInterval(liveUpdate, 1000);
})();
