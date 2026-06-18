// ── Auth state ────────────────────────────────────────────────────────────────
let currentUser = null;

function togglePw(id = 'login-password') {
  const inp = document.getElementById(id);
  if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
}

// ── Forgot / reset password ──────────────────────────────────────────────────
function _showAuthView(view) {
  ['login-view', 'forgot-view', 'reset-view'].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = (v === view) ? 'block' : 'none';
  });
  document.getElementById('login-overlay').style.display = 'flex';
}
function showLoginView()  { _showAuthView('login-view'); }
function showForgotView() {
  const m = document.getElementById('forgot-msg'); if (m) m.textContent = '';
  _showAuthView('forgot-view');
  setTimeout(() => document.getElementById('forgot-ident')?.focus(), 50);
}

async function sendResetLink() {
  const ident = document.getElementById('forgot-ident').value.trim();
  const msg   = document.getElementById('forgot-msg');
  if (!ident) { msg.style.color = ''; msg.textContent = 'Enter your username or email'; return; }
  try {
    const r = await API.post('/auth/forgot', { username: ident });
    msg.style.color = 'var(--muted)';
    msg.textContent = r.message || 'If the account exists, a reset link has been sent.';
  } catch (e) { msg.style.color = ''; msg.textContent = e.message || 'Something went wrong'; }
}

// Opened from the emailed link (?reset=TOKEN).
let _resetToken = null;
function startPasswordReset(token) {
  _resetToken = token;
  _showAuthView('reset-view');
  setTimeout(() => document.getElementById('reset-password')?.focus(), 50);
}

async function submitNewPassword() {
  const pw  = document.getElementById('reset-password').value;
  const msg = document.getElementById('reset-msg');
  if (!pw || pw.length < 6) { msg.style.color = ''; msg.textContent = 'Password must be at least 6 characters'; return; }
  try {
    await API.post('/auth/reset', { token: _resetToken, password: pw });
    // Drop the ?reset= param and return to a clean sign-in.
    history.replaceState(null, '', location.pathname);
    msg.style.color = 'var(--green)';
    msg.textContent = 'Password updated — you can sign in now.';
    setTimeout(showLoginView, 1200);
  } catch (e) { msg.style.color = ''; msg.textContent = e.message || 'Reset failed'; }
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
