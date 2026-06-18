// ── Auth state ────────────────────────────────────────────────────────────────
let currentUser = null;

function togglePw(id = 'login-password') {
  const inp = document.getElementById(id);
  if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
}

// ── Forgot / reset password ──────────────────────────────────────────────────
function _showAuthView(view) {
  ['login-view', 'forgot-view', 'reset-view', 'register-view', 'register-done'].forEach(v => {
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

// Staff self-registration (opened from ?register=CODE).
let _regCode = null;
let _regSection = 'General';
function pickSection(btn) {
  _regSection = btn.dataset.val;
  document.querySelectorAll('#reg-section .onb-pill').forEach(b => b.classList.toggle('active', b === btn));
}
async function startRegistration(code) {
  _regCode = code; _regSection = 'General';
  _showAuthView('register-view');
  const sel = document.getElementById('reg-branch');
  const msg = document.getElementById('reg-msg');
  try {
    const info = await API.get(`/register/info?code=${encodeURIComponent(code)}`);
    sel.innerHTML = '<option value="">Select branch…</option>' +
      (info.branches || []).map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  } catch (e) {
    msg.style.color = ''; msg.textContent = e.message || 'Registration is closed';
    document.querySelectorAll('#register-view input, #register-view select, #register-view .login-btn, #register-view .onb-pill')
      .forEach(el => el.disabled = true);
  }
}

async function submitRegistration() {
  const msg = document.getElementById('reg-msg');
  const body = {
    code: _regCode,
    name: document.getElementById('reg-name').value.trim(),
    branch_id: document.getElementById('reg-branch').value || null,
    section: _regSection,
    employee_id: document.getElementById('reg-empid').value.trim(),
    email: document.getElementById('reg-email').value.trim(),
    phone: document.getElementById('reg-phone').value.trim(),
  };
  if (!body.name || !body.employee_id || !body.branch_id) {
    msg.style.color = ''; msg.textContent = 'Name, Employee/National ID and branch are required'; return;
  }
  try {
    const r = await API.post('/register', body);
    // Premium success screen with the animated check.
    document.getElementById('register-done-msg').textContent =
      r.message || 'Your details were submitted and are awaiting approval.';
    _showAuthView('register-done');
  } catch (e) { msg.style.color = ''; msg.textContent = e.message || 'Submission failed'; }
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

// Return to a CLEAN login screen — drop any ?reset=/?register= still in the URL
// so logging out never reopens the "set new password" / registration views.
function _goToLogin() {
  const clean = location.origin + location.pathname;
  if (location.href !== clean) window.location.replace(clean);
  else window.location.reload();
}

async function doLogout() {
  await API.post('/auth/logout').catch(() => {});
  currentUser = null;
  _goToLogin();
}

// ── Idle auto-logout ──────────────────────────────────────────────────────────
// Sign the user out after a stretch of no activity (mouse/touch/key/scroll), so
// an unattended screen doesn't stay logged in. Client-side: clears the cookie
// and reloads to the login page with a notice.
const IDLE_LIMIT_MS = 5 * 60 * 1000;     // 5 minutes — change here to adjust
let _lastActivity = Date.now();
let _idleTimer = null;
function _bumpActivity() { _lastActivity = Date.now(); }
function startIdleWatch() {
  ['mousedown', 'keydown', 'touchstart', 'scroll', 'click', 'mousemove'].forEach(
    ev => window.addEventListener(ev, _bumpActivity, { passive: true }));
  if (_idleTimer) clearInterval(_idleTimer);
  _idleTimer = setInterval(() => {
    if (Date.now() - _lastActivity >= IDLE_LIMIT_MS) {
      clearInterval(_idleTimer); _idleTimer = null;
      idleLogout();
    }
  }, 20000);                              // re-check every 20s
}
async function idleLogout() {
  try { sessionStorage.setItem('idleLogout', '1'); } catch (e) {}
  await API.post('/auth/logout').catch(() => {});
  _goToLogin();
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
