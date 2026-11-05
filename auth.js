/* Supabase 登录外壳：只负责登录状态，不碰课表 / 任务数据 */
(function () {
  const SUPABASE_URL = 'https://hukmzzlchsaeasxsgqmt.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_ym0DctAco1wn_icyHeNzRw_ULR7659G';
  const FALLBACK_SDK = 'https://unpkg.com/@supabase/supabase-js@2';

  const btn = document.getElementById('auth-btn');
  const modal = document.getElementById('auth-modal');
  const form = document.getElementById('auth-form');
  const emailEl = document.getElementById('auth-email');
  const passEl = document.getElementById('auth-password');
  const msgEl = document.getElementById('auth-msg');
  const loginBtn = document.getElementById('auth-login');
  const signupBtn = document.getElementById('auth-signup');
  const closeBtn = document.getElementById('auth-close');

  if (!btn || !modal || !form) return;

  let client = null;      // Supabase 客户端，加载成功后才有
  let starting = false;

  function setMsg(text, ok) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.classList.toggle('ok', !!ok);
  }
  function openModal() {
    modal.classList.remove('hidden');
    setMsg('');
    if (emailEl) emailEl.focus();
  }
  function closeModal() {
    modal.classList.add('hidden');
  }
  function renderUser(user) {
    if (user) {
      btn.textContent = `已登录：${user.email}`;
      btn.classList.add('logged-in');
      btn.title = '点击退出登录';
    } else {
      btn.textContent = '登录 / 注册';
      btn.classList.remove('logged-in');
      btn.title = '';
    }
  }

  // 等 SDK 加载完成（head 里是 defer 引入，不阻塞页面渲染）
  function boot() {
    if (window.supabase) { start(window.supabase); return; }
    let tries = 0;
    const timer = setInterval(() => {
      if (window.supabase) {
        clearInterval(timer);
        start(window.supabase);
      } else if (++tries > 80) {
        clearInterval(timer);
        loadFallback();
      }
    }, 100);
  }

  function loadFallback() {
    const s = document.createElement('script');
    s.src = FALLBACK_SDK;
    s.onload = () => (window.supabase ? start(window.supabase) : notReady());
    s.onerror = notReady;
    document.head.appendChild(s);
  }

  function notReady() {
    btn.textContent = '登录（服务未连接）';
    btn.addEventListener('click', () => {
      openModal();
      setMsg('登录服务未加载，请检查网络后刷新重试。');
    });
  }

  function start(sdk) {
    if (starting || !sdk || !sdk.createClient) return;
    starting = true;
    client = sdk.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce'
      }
    });

    // 供 app.js 的云端同步复用同一个客户端
    window.studyhubClient = client;

    function notifyAuth(user) {
      window.studyhubUser = user || null;
      document.dispatchEvent(new CustomEvent('studyhub:auth', { detail: { user: window.studyhubUser } }));
    }

    client.auth.onAuthStateChange((_event, session) => {
      const user = session && session.user;
      renderUser(user);
      notifyAuth(user);
    });
    client.auth.getSession().then(({ data }) => {
      const user = data && data.session && data.session.user;
      renderUser(user);
      notifyAuth(user);
    });

    // 连接自检：失败时在控制台给出明确原因（不影响页面其他功能）
    fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_KEY } })
      .then(r => console.info('[auth] Supabase health:', r.status))
      .catch(err => console.warn('[auth] 无法连接 Supabase：', err.message,
        '\n请检查 Project URL 是否正确、项目是否被暂停，以及网络/DNS 是否能访问 *.supabase.co'));
  }

  function friendlyError(err) {
    const msg = (err && err.message) || '未知错误';
    if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)) {
      return '无法连接 Supabase（网络或 DNS 失败）。请确认 Project URL 正确、项目未暂停，且当前网络能访问 *.supabase.co。';
    }
    return msg;
  }

  // ===== 交互 =====
  btn.addEventListener('click', async () => {
    if (!client) { openModal(); setMsg('登录服务加载中，请稍候…'); return; }
    const { data } = await client.auth.getSession();
    const user = data && data.session && data.session.user;
    if (user) {
      if (confirm(`当前登录：${user.email}\n要退出登录吗？`)) {
        await client.auth.signOut();
      }
      return;
    }
    openModal();
  });

  closeBtn && closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!client) { setMsg('登录服务还在加载，请稍后再试'); return; }
    const email = (emailEl.value || '').trim();
    const password = passEl.value || '';
    if (!email || !password) return;
    loginBtn.disabled = true;
    setMsg('登录中…');
    try {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) { setMsg(friendlyError(error), false); return; }
      setMsg('登录成功', true);
      form.reset();
      closeModal();
    } catch (err) {
      setMsg(friendlyError(err), false);
    } finally {
      loginBtn.disabled = false;
    }
  });

  signupBtn.addEventListener('click', async () => {
    if (!client) { setMsg('注册服务还在加载，请稍后再试'); return; }
    const email = (emailEl.value || '').trim();
    const password = passEl.value || '';
    if (!email || !password) { setMsg('请先填写邮箱和密码'); return; }
    if (password.length < 6) { setMsg('密码至少 6 位'); return; }
    signupBtn.disabled = true;
    setMsg('注册中…');
    try {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) { setMsg(friendlyError(error), false); return; }
      if (data && data.session) {
        setMsg('注册成功，已自动登录', true);
        form.reset();
        closeModal();
      } else {
        setMsg('注册成功，请到邮箱点击确认链接后再登录', true);
      }
    } catch (err) {
      setMsg(friendlyError(err), false);
    } finally {
      signupBtn.disabled = false;
    }
  });

  boot();
})();
