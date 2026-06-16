// ── Auth state ────────────────────────────────────────────────────────────────
let currentUser = null;

function togglePw() {
  const inp = document.getElementById('login-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.textContent = '';
  if (!username || !password) { errEl.textContent = 'Enter username and password'; return; }
  try {
    const user = await API.post('/auth/login', { username, password });
    currentUser = user;
    document.getElementById('login-overlay').style.display = 'none';
    // Branded welcome splash stays up while the app loads its first data
    // (initApp awaits the schedule render). Enforce a minimum on-screen time
    // so the greeting is readable even when loading is very fast.
    showWelcomeSplash(user.username || username);
    const _splashStart = Date.now();
    await initApp();
    const MIN_SPLASH_MS = 1600;
    const elapsed = Date.now() - _splashStart;
    if (elapsed < MIN_SPLASH_MS) {
      await new Promise(r => setTimeout(r, MIN_SPLASH_MS - elapsed));
    }
    hideWelcomeSplash();
  } catch (err) {
    errEl.textContent = err.message || 'Login failed';
  }
}

async function doLogout() {
  await API.post('/auth/logout').catch(() => {});
  currentUser = null;
  location.reload();
}

async function checkAuth() {
  try {
    currentUser = await API.get('/auth/me');
    return true;
  } catch {
    return false;
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-overlay')?.style.display !== 'none') {
    doLogin();
  }
});
