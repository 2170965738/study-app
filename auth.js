/* Supabase 登录外壳：只负责登录状态与头像，不碰课表 / 任务数据 */
(function () {
  const SUPABASE_URL = 'https://hukmzzlchsaeasxsgqmt.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_ym0DctAco1wn_icyHeNzRw_ULR7659G';
  const FALLBACK_SDK = 'https://unpkg.com/@supabase/supabase-js@2';

  const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
  const DEFAULT_AVATAR_EMOJI = '🌱';
  console.info('[auth] avatar build: 20261106d');

  const btn = document.getElementById('auth-btn');
  const modal = document.getElementById('auth-modal');
  const form = document.getElementById('auth-form');
  const emailEl = document.getElementById('auth-email');
  const passEl = document.getElementById('auth-password');
  const msgEl = document.getElementById('auth-msg');
  const loginBtn = document.getElementById('auth-login');
  const signupBtn = document.getElementById('auth-signup');
  const closeBtn = document.getElementById('auth-close');

  const avatarWrap = document.getElementById('avatar-wrap');
  const avatarBtn = document.getElementById('avatar-btn');
  const avatarMenu = document.getElementById('avatar-menu');
  const avatarImg = document.getElementById('avatar-img');
  const avatarEmoji = document.getElementById('avatar-emoji');
  const avatarMenuImg = document.getElementById('avatar-menu-img');
  const avatarMenuEmoji = document.getElementById('avatar-menu-emoji');
  const avatarEmail = document.getElementById('avatar-email');
  const avatarFile = document.getElementById('avatar-file');
  const avatarUpload = document.getElementById('avatar-upload');
  const avatarPreviewBox = document.getElementById('avatar-preview');
  const avatarLocalImg = document.getElementById('avatar-local-img');
  const avatarPreviewHint = document.getElementById('avatar-preview-hint');
  const avatarSaveBtn = document.getElementById('avatar-save');
  const avatarCancelBtn = document.getElementById('avatar-cancel');
  const avatarResetBtn = document.getElementById('avatar-reset');
  const avatarStatus = document.getElementById('avatar-status');
  const avatarLogoutBtn = document.getElementById('avatar-logout');
  const avatarAlert = document.getElementById('avatar-alert');
  const avatarAlertTitle = document.getElementById('avatar-alert-title');
  const avatarAlertIcon = document.getElementById('avatar-alert-icon');
  const avatarAlertMsg = document.getElementById('avatar-alert-msg');
  const avatarAlertClose = document.getElementById('avatar-alert-close');

  if (!btn || !modal || !form) return;

  if (!avatarWrap || !avatarBtn || !avatarMenu || !avatarImg || !avatarEmoji) {
    console.error('[auth] 头像 DOM 不完整：请确认 index.html 是最新版，并强制刷新（Ctrl + F5）。');
  }

  let client = null;      // Supabase 客户端，加载成功后才有
  let starting = false;
  let currentUser = null;
  let pendingAvatarFile = null;
  let pendingAvatarUrl = '';
  let avatarSaving = false;

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
  function avatarUrlOf(user) {
    const url = user && user.user_metadata && user.user_metadata.avatar_url;
    return typeof url === 'string' ? url.trim() : '';
  }

  function setAvatarVisual(img, emoji, url) {
    if (!img || !emoji) return;
    if (url) {
      if (img.getAttribute('src') !== url) img.src = url;
      img.classList.remove('hidden');
      img.hidden = false;
      img.style.display = 'block';
      emoji.classList.add('hidden');
      emoji.hidden = true;
      emoji.style.display = 'none';
    } else {
      img.classList.add('hidden');
      img.hidden = true;
      img.style.display = 'none';
      img.removeAttribute('src');
      emoji.classList.remove('hidden');
      emoji.hidden = false;
      emoji.style.display = 'inline-block';
    }
  }

  function renderAvatar(user) {
    const url = avatarUrlOf(user);
    if (avatarEmoji) avatarEmoji.textContent = DEFAULT_AVATAR_EMOJI;
    if (avatarMenuEmoji) avatarMenuEmoji.textContent = DEFAULT_AVATAR_EMOJI;
    setAvatarVisual(avatarImg, avatarEmoji, url);
    setAvatarVisual(avatarMenuImg, avatarMenuEmoji, url);
    if (avatarEmail) avatarEmail.textContent = (user && user.email) || '';
    if (avatarBtn) avatarBtn.title = user ? `${user.email || ''} · 账户菜单` : '账户菜单';
  }

  function renderUser(user) {
    currentUser = user || null;
    const avatarUrl = user && user.user_metadata && user.user_metadata.avatar_url;
    // 排查用：打开控制台应能看到这行；若看不到，说明加载的仍是旧版 auth.js
    console.info('[auth] renderUser →', {
      email: user && user.email,
      avatar_url: avatarUrl,
      hasAvatarWrap: !!avatarWrap,
      hasAvatarBtn: !!avatarBtn
    });

    renderAvatar(user);

    if (user) {
      if (avatarWrap) {
        avatarWrap.classList.remove('hidden');
        avatarWrap.hidden = false;
        avatarWrap.style.display = 'inline-flex';

        // 头像接管后，原文字按钮三重隐藏，并清空邮箱文字
        btn.classList.add('hidden');
        btn.hidden = true;
        btn.style.display = 'none';
        btn.setAttribute('aria-hidden', 'true');
        btn.classList.add('logged-in');
        btn.textContent = '';
        btn.title = '账户菜单';
      } else {
        // HTML 还是旧版时的兜底：保留可见按钮，便于确认问题
        btn.classList.remove('hidden');
        btn.hidden = false;
        btn.style.display = '';
        btn.removeAttribute('aria-hidden');
        btn.classList.add('logged-in');
        btn.textContent = `已登录：${user.email || ''}`;
        btn.title = '账户菜单';
        console.error('[auth] #avatar-wrap 不存在，无法显示头像；index.html 不是最新版。');
      }
    } else {
      btn.classList.remove('hidden');
      btn.hidden = false;
      btn.style.display = '';
      btn.removeAttribute('aria-hidden');
      btn.classList.remove('logged-in');
      btn.textContent = '登录 / 注册';
      btn.title = '';

      if (avatarWrap) {
        avatarWrap.classList.add('hidden');
        avatarWrap.hidden = true;
        avatarWrap.style.display = 'none';
      }
      closeAvatarMenu();
      closeAvatarAlert();
    }
  }

  function setAvatarStatus(text, ok) {
    if (!avatarStatus) return;
    avatarStatus.textContent = text || '';
    avatarStatus.classList.toggle('ok', !!ok);
  }

  function clearPendingAvatarUrl() {
    if (pendingAvatarUrl) {
      URL.revokeObjectURL(pendingAvatarUrl);
      pendingAvatarUrl = '';
    }
  }

  function clearAvatarPreviewUI() {
    pendingAvatarFile = null;
    clearPendingAvatarUrl();
    if (avatarLocalImg) avatarLocalImg.removeAttribute('src');
    if (avatarPreviewBox) avatarPreviewBox.classList.add('hidden');
    if (avatarFile) avatarFile.value = '';
  }

  function cancelAvatarPreview() {
    clearAvatarPreviewUI();
    setAvatarStatus('');
  }

  function openAvatarMenu() {
    if (!avatarMenu || !avatarBtn || !currentUser) return;
    avatarMenu.classList.remove('hidden');
    avatarBtn.setAttribute('aria-expanded', 'true');
    setAvatarStatus('');
  }

  function closeAvatarMenu() {
    if (!avatarMenu || !avatarBtn) return;
    avatarMenu.classList.add('hidden');
    avatarBtn.setAttribute('aria-expanded', 'false');
    cancelAvatarPreview();
  }

  function showAvatarAlert(text, title, icon) {
    if (!avatarAlert) { window.alert(text); return; }
    if (avatarAlertTitle) avatarAlertTitle.textContent = title || '头像上传失败';
    if (avatarAlertIcon) avatarAlertIcon.textContent = icon || '⚠️';
    if (avatarAlertMsg) avatarAlertMsg.textContent = text || '';
    avatarAlert.classList.remove('hidden');
    if (avatarAlertClose) avatarAlertClose.focus();
  }

  function closeAvatarAlert() {
    if (avatarAlert) avatarAlert.classList.add('hidden');
  }

  function avatarErrorText(err) {
    const msg = (err && err.message) || '未知错误';
    if (/exceeded the maximum allowed size|Payload too large|too large|413/i.test(msg)) {
      return '图片超过 10MB，请换一张更小的图片再试。';
    }
    if (/Bucket not found/i.test(msg)) {
      return '没有找到 avatars 存储桶，请确认 Bucket 名称是否完全一致。';
    }
    if (/row-level security|permission denied|not authorized|Unauthorized|403|new row violates/i.test(msg)) {
      return '上传被拒绝。请检查 avatars 存储桶的 RLS 策略，确认登录用户可以上传和覆盖文件。';
    }
    if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)) {
      return '无法连接 Supabase 存储服务，请检查网络后重试。';
    }
    return msg;
  }

  function formatAvatarSize(bytes) {
    const mb = Number(bytes) / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(Number(bytes) / 1024))} KB`;
  }

  function avatarExtension(file) {
    const type = String((file && file.type) || '').toLowerCase();
    const known = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif'
    };
    if (known[type]) return known[type];
    const match = String((file && file.name) || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1] : 'png';
  }

  function showAvatarPreview(file) {
    clearPendingAvatarUrl();
    pendingAvatarFile = file;
    pendingAvatarUrl = URL.createObjectURL(file);
    if (avatarLocalImg) avatarLocalImg.src = pendingAvatarUrl;
    if (avatarPreviewHint) {
      avatarPreviewHint.textContent = `${file.name || '已选图片'} · ${formatAvatarSize(file.size)} · 保存后才会更新`;
    }
    if (avatarPreviewBox) avatarPreviewBox.classList.remove('hidden');
    setAvatarStatus('已选择图片，点击「保存头像」上传', true);
  }

  function setAvatarBusy(busy) {
    if (avatarSaveBtn) {
      avatarSaveBtn.disabled = busy;
      avatarSaveBtn.textContent = busy ? '上传中…' : '保存头像';
    }
    if (avatarCancelBtn) avatarCancelBtn.disabled = busy;
    if (avatarResetBtn) avatarResetBtn.disabled = busy;
    if (avatarFile) avatarFile.disabled = busy;
  }

  async function currentAuthUser() {
    if (!client) return null;
    try {
      const { data } = await client.auth.getUser();
      const user = (data && data.user) || null;
      if (user) currentUser = user;
      return user;
    } catch (e) {
      return currentUser;
    }
  }

  async function saveAvatar() {
    if (avatarSaving) return;
    if (!pendingAvatarFile) { setAvatarStatus('请先选择一张图片'); return; }
    if (!client) { showAvatarAlert('登录服务还没加载好，请稍后再试。'); return; }

    const file = pendingAvatarFile;
    if (file.size > MAX_AVATAR_BYTES) {
      showAvatarAlert(`图片大小 ${formatAvatarSize(file.size)}，超过 10MB 限制，请换一张。`);
      return;
    }

    avatarSaving = true;
    setAvatarBusy(true);
    setAvatarStatus('正在上传头像…');
    const user = await currentAuthUser();
    if (!user) {
      avatarSaving = false;
      setAvatarBusy(false);
      setAvatarStatus('');
      showAvatarAlert('登录状态已失效，请重新登录后再上传头像。');
      return;
    }

    try {
      const ext = avatarExtension(file);
      const path = `${user.id}/avatar.${ext}`;
      const contentType = file.type || (ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
      const { error: uploadError } = await client.storage.from('avatars').upload(path, file, {
        cacheControl: '3600',
        upsert: true,
        contentType
      });
      if (uploadError) throw uploadError;

      const { data: publicData } = client.storage.from('avatars').getPublicUrl(path);
      const publicUrl = publicData && publicData.publicUrl;
      if (!publicUrl) throw new Error('没有拿到图片的公开地址');

      // 固定路径会命中浏览器缓存，存一个带版本号的 URL，刷新后也能立刻看到新头像
      const url = `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
      const meta = Object.assign({}, user.user_metadata || {}, { avatar_url: url });
      const { data: updateData, error: updateError } = await client.auth.updateUser({ data: meta });
      if (updateError) throw updateError;
      if (!currentUser || currentUser.id !== user.id) return;

      const baseUser = (updateData && updateData.user) || user;
      const updatedUser = Object.assign({}, baseUser, {
        user_metadata: Object.assign({}, baseUser.user_metadata || {}, { avatar_url: url })
      });
      clearAvatarPreviewUI();
      renderUser(updatedUser);
      setAvatarStatus('头像已更新 ✨', true);
    } catch (err) {
      console.error('[avatar] upload failed', err);
      const text = avatarErrorText(err);
      showAvatarAlert(text);
      setAvatarStatus('上传失败，请重试');
    } finally {
      avatarSaving = false;
      setAvatarBusy(false);
    }
  }

  async function resetAvatar() {
    if (!client) { showAvatarAlert('登录服务还没加载好，请稍后再试。'); return; }
    const user = await currentAuthUser();
    if (!user) { showAvatarAlert('登录状态已失效，请重新登录后再操作。'); return; }
    if (!window.confirm('恢复默认 Emoji 头像？')) return;

    if (avatarResetBtn) avatarResetBtn.disabled = true;
    if (avatarSaveBtn) avatarSaveBtn.disabled = true;
    setAvatarStatus('正在恢复默认头像…');
    try {
      const meta = Object.assign({}, user.user_metadata || {}, { avatar_url: '' });
      const { data, error } = await client.auth.updateUser({ data: meta });
      if (error) throw error;
      if (!currentUser || currentUser.id !== user.id) return;

      const baseUser = (data && data.user) || user;
      const updatedUser = Object.assign({}, baseUser, {
        user_metadata: Object.assign({}, baseUser.user_metadata || {}, { avatar_url: '' })
      });
      clearAvatarPreviewUI();
      renderUser(updatedUser);
      setAvatarStatus('已恢复默认 Emoji 🌱', true);
    } catch (err) {
      console.error('[avatar] reset failed', err);
      const text = avatarErrorText(err);
      showAvatarAlert(text);
      setAvatarStatus('恢复失败，请重试');
    } finally {
      if (avatarResetBtn) avatarResetBtn.disabled = false;
      if (avatarSaveBtn && !avatarSaving) avatarSaveBtn.disabled = false;
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
      console.info('[auth] auth event:', _event, {
        id: user && user.id,
        email: user && user.email,
        avatar_url: user && user.user_metadata && user.user_metadata.avatar_url
      });
      renderUser(user);
      notifyAuth(user);
    });
    client.auth.getSession().then(({ data }) => {
      const user = data && data.session && data.session.user;
      console.info('[auth] getSession user:', user, '| avatar_url:', user && user.user_metadata && user.user_metadata.avatar_url);
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
  // 头像图片加载失败时回退到 Emoji
  [[avatarImg, avatarEmoji], [avatarMenuImg, avatarMenuEmoji]].forEach(pair => {
    const img = pair[0], emoji = pair[1];
    if (!img) return;
    img.addEventListener('error', () => {
      img.classList.add('hidden');
      img.hidden = true;
      img.style.display = 'none';
      if (emoji) {
        emoji.classList.remove('hidden');
        emoji.hidden = false;
        emoji.style.display = 'inline-block';
      }
    });
  });

  if (avatarBtn && avatarMenu) {
    avatarBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (avatarMenu.classList.contains('hidden')) openAvatarMenu();
      else closeAvatarMenu();
    });
    document.addEventListener('click', e => {
      if (avatarMenu.classList.contains('hidden')) return;
      if (avatarAlert && !avatarAlert.classList.contains('hidden')) return;
      if (avatarAlert && avatarAlert.contains(e.target)) return;
      if (!avatarWrap || !avatarWrap.contains(e.target)) closeAvatarMenu();
    });
  }

  if (avatarFile) {
    avatarFile.addEventListener('change', () => {
      const file = avatarFile.files && avatarFile.files[0];
      avatarFile.value = '';
      if (!file) return;
      if (file.size > MAX_AVATAR_BYTES) {
        showAvatarAlert(`图片大小 ${formatAvatarSize(file.size)}，超过 10MB 限制，请换一张。`);
        return;
      }
      if (file.type && !/^image\//i.test(file.type)) {
        showAvatarAlert('请选择图片文件（PNG、JPG 等）。');
        return;
      }
      showAvatarPreview(file);
    });
  }

  if (avatarUpload && avatarFile) {
    avatarUpload.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        avatarFile.click();
      }
    });
  }

  if (avatarSaveBtn) avatarSaveBtn.addEventListener('click', saveAvatar);
  if (avatarCancelBtn) avatarCancelBtn.addEventListener('click', cancelAvatarPreview);
  if (avatarResetBtn) avatarResetBtn.addEventListener('click', resetAvatar);

  if (avatarLogoutBtn) {
    avatarLogoutBtn.addEventListener('click', async () => {
      if (!client) { showAvatarAlert('登录服务还没加载好，请稍后再试。'); return; }
      if (!window.confirm('要退出登录吗？')) return;
      avatarLogoutBtn.disabled = true;
      try {
        const { error } = await client.auth.signOut();
        if (error) throw error;
        renderUser(null);
        closeAvatarMenu();
      } catch (err) {
        console.error('[avatar] logout failed', err);
        showAvatarAlert('退出登录失败：' + ((err && err.message) || '请稍后重试'));
      } finally {
        avatarLogoutBtn.disabled = false;
      }
    });
  }

  if (avatarAlertClose) avatarAlertClose.addEventListener('click', closeAvatarAlert);
  if (avatarAlert) {
    avatarAlert.addEventListener('click', e => { if (e.target === avatarAlert) closeAvatarAlert(); });
  }

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
    if (e.key !== 'Escape') return;
    if (avatarAlert && !avatarAlert.classList.contains('hidden')) { closeAvatarAlert(); return; }
    if (avatarMenu && !avatarMenu.classList.contains('hidden')) { closeAvatarMenu(); return; }
    if (!modal.classList.contains('hidden')) closeModal();
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

  renderUser(null);
  boot();
})();
