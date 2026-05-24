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
    initApp();
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
