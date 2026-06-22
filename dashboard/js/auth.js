// ── Auth state ────────────────────────────────────────────────────────────────
let currentUser = null;

function togglePw(id = 'login-password') {
  const inp = document.getElementById(id);
  if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
}

// ── Forgot / reset password ──────────────────────────────────────────────────
function _showAuthView(view) {
  ['login-view', 'forgot-view', 'reset-view', 'signup-view', 'register-view', 'register-done'].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = (v === view) ? 'block' : 'none';
  });
  // Widen the card for the multi-field registration form; keep it narrow otherwise.
  document.querySelector('.login-box')?.classList.toggle('reg-wide', view === 'register-view');
  document.getElementById('login-overlay').style.display = 'flex';
}
function showLoginView()  { _showAuthView('login-view'); }

// "New staff? Sign up" — registration is open (no invite code), so drop straight
// into the onboarding form as a staff member.
function startStaffSignup() { startRegistration('', 'staff'); }

// Email a 6-digit verification code to the entered Meena address.
async function sendRegCode() {
  const email = document.getElementById('reg-email').value.trim();
  const msg = document.getElementById('reg-msg');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !email.toLowerCase().includes('@meena')) {
    msg.style.color = ''; msg.textContent = 'Enter your Meena email first (must contain @meena)'; return;
  }
  const btn = document.getElementById('reg-sendcode-btn');
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Sending…';
  try {
    await API.post('/register/send-code', { email });
    msg.style.color = 'var(--muted)'; msg.textContent = 'Code sent — check your Meena email (expires in 10 min).';
    document.getElementById('reg-emailcode')?.focus();
  } catch (e) { msg.style.color = ''; msg.textContent = e.message || 'Could not send the code'; }
  finally { btn.disabled = false; btn.textContent = label; }
}

// Legacy code-gated signup (kept for any older link); no longer the default path.
function showSignupView() {
  const m = document.getElementById('signup-msg'); if (m) m.textContent = '';
  const c = document.getElementById('signup-code'); if (c) c.value = '';
  _showAuthView('signup-view');
  setTimeout(() => document.getElementById('signup-code')?.focus(), 50);
}
async function submitInviteCode() {
  const code = document.getElementById('signup-code').value.trim();
  const msg  = document.getElementById('signup-msg');
  if (!code) { msg.style.color = ''; msg.textContent = 'Enter the invite code your manager gave you'; return; }
  try {
    await API.get(`/register/info?code=${encodeURIComponent(code)}`);
    startRegistration(code);                  // valid → load the onboarding form
  } catch (e) {
    msg.style.color = ''; msg.textContent = e.message || 'That invite code is not valid';
  }
}
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

// Self-registration (opened from ?register=CODE&as=ROLE).
let _regCode = null;
let _regRole = 'staff';
let _regSection = 'General';
const _REG_HEAD = {
  staff:   ['Staff Onboarding',     'Welcome! Fill in your details to join the team.'],
  admin:   ['Team Lead Registration', 'Register as a team lead for your branch.'],
  manager: ['Manager Registration',   'Register as a department manager.'],
};
function pickSection(btn) {
  _regSection = btn.dataset.val;
  document.querySelectorAll('#reg-section .onb-pill').forEach(b => b.classList.toggle('active', b === btn));
}
async function startRegistration(code, role) {
  _regCode = code; _regSection = 'General';
  _regRole = ['staff', 'admin', 'manager'].includes(role) ? role : 'staff';
  _showAuthView('register-view');
  // Tailor the form to the role: a manager spans all branches (no branch/section/
  // employee id); a team lead picks a branch but no section/employee id.
  const head = _REG_HEAD[_regRole];
  const h = document.querySelector('#register-view h2'); if (h) h.textContent = head[0];
  const p = document.querySelector('#register-view > p'); if (p) p.textContent = head[1];
  const showBranch  = _regRole !== 'manager';
  const showStaffly = _regRole === 'staff';   // section + employee id are staff-only
  const fld = id => document.getElementById(id)?.closest('.login-field');
  if (fld('reg-branch')) fld('reg-branch').style.display = showBranch ? '' : 'none';
  if (fld('reg-empid'))  fld('reg-empid').style.display  = showStaffly ? '' : 'none';
  const secField = document.getElementById('reg-section')?.closest('.login-field');
  if (secField) secField.style.display = showStaffly ? '' : 'none';
  const sel = document.getElementById('reg-branch');
  const msg = document.getElementById('reg-msg');
  _resetNafath();
  try {
    const info = await API.get(`/register/info?code=${encodeURIComponent(code)}`);
    if (showBranch && sel) {
      sel.innerHTML = '<option value="">Select branch…</option>' +
        (info.branches || []).map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    } else if (sel) { try { sel.innerHTML = ''; } catch (e) {} }
    // Nafath identity verification (when the server has it configured). When on,
    // identity is verified FIRST and the rest of the form stays hidden until then.
    _nafathEnabled = !!info.nafath_enabled;
    const identity = document.getElementById('reg-identity');
    const rest = document.getElementById('reg-rest');
    const intro = document.getElementById('reg-intro');
    if (identity) identity.style.display = _nafathEnabled ? '' : 'none';
    if (rest) rest.style.display = _nafathEnabled ? 'none' : '';
    if (intro) intro.textContent = _nafathEnabled
      ? 'First, verify your identity with Nafath. Then fill in the rest of your details.'
      : 'Welcome! Fill in your details to join the team.';
  } catch (e) {
    msg.style.color = ''; msg.textContent = e.message || 'Registration is closed';
    document.querySelectorAll('#register-view input, #register-view select, #register-view .login-btn, #register-view .onb-pill')
      .forEach(el => el.disabled = true);
  }
}

// ── Nafath identity verification ──────────────────────────────────────────────
let _nafathEnabled = false, _nafathVerified = false, _nafathRequestId = null, _nafathPollTimer = null;

function _resetNafath() {
  _nafathVerified = false; _nafathRequestId = null;
  clearTimeout(_nafathPollTimer); _nafathPollTimer = null;
  const st = document.getElementById('reg-nafath-status'); if (st) st.innerHTML = '';
  const btn = document.getElementById('reg-nafath-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Verify'; }
  const idInput = document.getElementById('reg-nationalid');
  if (idInput) { idInput.readOnly = false; idInput.value = ''; }
  const nameEl = document.getElementById('reg-name');
  if (nameEl) nameEl.readOnly = false;
}

async function startNafath() {
  const st = document.getElementById('reg-nafath-status');
  const btn = document.getElementById('reg-nafath-btn');
  const nid = (document.getElementById('reg-nationalid')?.value || '').trim();
  if (!/^[12]\d{9}$/.test(nid)) {
    st.innerHTML = `<div class="nf-err">Enter a valid 10-digit National ID / Iqama (starts with 1 or 2)</div>`; return;
  }
  _nafathVerified = false;
  clearTimeout(_nafathPollTimer);
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await API.post('/register/nafath/start', { national_id: nid });
    _nafathRequestId = r.request_id;
    const num = String(r.random || '').trim();
    st.innerHTML = `<div class="nf-waiting">
        <div class="nf-pick">${num ? 'Open the <b>Nafath</b> app and tap the number:' : 'Open the <b>Nafath</b> app and approve the request:'}</div>
        ${num ? `<div class="nf-num">${escapeHtml(num)}</div>` : ''}
        <div class="nf-hint"><span class="nf-spin nf-spin-green"></span> Waiting for your approval…</div>
      </div>`;
    _pollNafath(r.request_id, Date.now());
  } catch (e) {
    st.innerHTML = `<div class="nf-err">${escapeHtml(e.message || 'Could not start Nafath verification')}</div>`;
    btn.disabled = false; btn.textContent = 'Verify';
  }
}

function _pollNafath(rid, startedAt) {
  _nafathPollTimer = setTimeout(async () => {
    if (rid !== _nafathRequestId) return;                 // superseded by a new attempt
    const st = document.getElementById('reg-nafath-status');
    const btn = document.getElementById('reg-nafath-btn');
    try {
      const r = await API.get(`/register/nafath/status?request_id=${encodeURIComponent(rid)}`);
      if (r.status === 'verified') {
        _nafathVerified = true;
        const nm = r.name_en || r.name_ar || '';
        st.innerHTML = `<div class="nf-verified">
            <div class="nf-check">✓</div>
            <div><b>Identity verified${nm ? ` — ${escapeHtml(nm)}` : ''}</b>
              <div class="nf-sub2">Please complete the rest of your details below.</div></div>
          </div>`;
        if (btn) { btn.disabled = true; btn.textContent = 'Verified ✓'; }
        const idInput = document.getElementById('reg-nationalid');
        if (idInput) idInput.readOnly = true;
        // Reveal the rest of the form and adopt the official name (read-only).
        const rest = document.getElementById('reg-rest');
        if (rest) rest.style.display = '';
        const nameEl = document.getElementById('reg-name');
        if (nameEl && nm) { nameEl.value = nm; nameEl.readOnly = true; }
        return;
      }
      if (r.status === 'failed') {
        st.innerHTML = `<div class="nf-err">Nafath verification was rejected or cancelled. Please try again.</div>`;
        if (btn) { btn.disabled = false; btn.textContent = 'Verify'; }
        return;
      }
    } catch (e) { /* keep polling */ }
    if (Date.now() - startedAt > 120000) {                // give up after 2 minutes
      st.innerHTML = `<div class="nf-err">Verification timed out. Please try again.</div>`;
      if (btn) { btn.disabled = false; btn.textContent = 'Verify'; }
      return;
    }
    _pollNafath(rid, startedAt);
  }, 3000);
}

async function submitRegistration() {
  const msg = document.getElementById('reg-msg');
  const pw  = document.getElementById('reg-password').value;
  const pw2 = document.getElementById('reg-password2').value;
  const body = {
    code: _regCode,
    role: _regRole,
    name: document.getElementById('reg-name').value.trim(),
    branch_id: document.getElementById('reg-branch').value || null,
    section: _regSection,
    employee_id: document.getElementById('reg-empid').value.trim(),
    email: document.getElementById('reg-email').value.trim(),
    phone: document.getElementById('reg-phone').value.trim(),
    join_date: document.getElementById('reg-joindate')?.value || null,
    leave_balance: parseFloat(document.getElementById('reg-leavebal')?.value || '0') || 0,
    email_code: document.getElementById('reg-emailcode')?.value.trim(),
    nafath_request_id: _nafathRequestId,
    username: document.getElementById('reg-username').value.trim(),
    password: pw,
  };
  if (!body.name) { msg.style.color = ''; msg.textContent = 'Your name is required'; return; }
  if (_regRole !== 'manager' && !body.branch_id) {
    msg.style.color = ''; msg.textContent = 'Please choose your branch'; return;
  }
  if (_regRole === 'staff' && !body.employee_id) {
    msg.style.color = ''; msg.textContent = 'Employee ID is required'; return;
  }
  // Mobile is required; email must be a Meena work email (not a personal one).
  if (!body.phone) { msg.style.color = ''; msg.textContent = 'Mobile number is required'; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email) || !body.email.toLowerCase().includes('@meena')) {
    msg.style.color = ''; msg.textContent = 'Use your Meena work email (must contain @meena)'; return;
  }
  if (!body.email_code || body.email_code.length < 4) {
    msg.style.color = ''; msg.textContent = 'Enter the verification code we emailed you (tap "Send code")'; return;
  }
  if (_nafathEnabled && !_nafathVerified) {
    msg.style.color = ''; msg.textContent = 'Please verify your identity with Nafath first'; return;
  }
  if (body.leave_balance < 0) { msg.style.color = ''; msg.textContent = 'Leave balance can\'t be negative'; return; }
  if (!body.username || body.username.length < 3) {
    msg.style.color = ''; msg.textContent = 'Choose a username (at least 3 characters)'; return;
  }
  if (!pw || pw.length < 6) {
    msg.style.color = ''; msg.textContent = 'Password must be at least 6 characters'; return;
  }
  if (pw !== pw2) {
    msg.style.color = ''; msg.textContent = 'Passwords do not match'; return;
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

// ── Change own password (any signed-in role) ──────────────────────────────────
function openChangePassword() {
  ['pw-current', 'pw-new', 'pw-new2'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  const m = document.getElementById('pw-msg'); if (m) m.textContent = '';
  document.getElementById('pw-modal-overlay').classList.add('open');
  if (typeof closeSidebarMobile === 'function') closeSidebarMobile();
  setTimeout(() => document.getElementById('pw-current')?.focus(), 60);
}
function closeChangePassword() {
  document.getElementById('pw-modal-overlay').classList.remove('open');
}
async function saveChangePassword() {
  const cur = document.getElementById('pw-current').value;
  const nw  = document.getElementById('pw-new').value;
  const nw2 = document.getElementById('pw-new2').value;
  const msg = document.getElementById('pw-msg');
  msg.className = 'msg';
  if (!cur || !nw) { msg.classList.add('err'); msg.textContent = 'Fill in all fields'; return; }
  if (nw.length < 6) { msg.classList.add('err'); msg.textContent = 'New password must be at least 6 characters'; return; }
  if (nw !== nw2) { msg.classList.add('err'); msg.textContent = 'New passwords do not match'; return; }
  const btn = document.getElementById('pw-save-btn'); btn.disabled = true;
  try {
    await API.post('/auth/change-password', { current_password: cur, new_password: nw });
    closeChangePassword();
    toast('Password updated');
  } catch (e) {
    msg.classList.add('err'); msg.textContent = e.message || 'Could not change password';
  } finally { btn.disabled = false; }
}

// Called by the API layer when a request comes back 401 mid-session. Fire once,
// flag it, and return to a clean login with a "session expired" notice.
let _sessionExpiredHandled = false;
function handleSessionExpired() {
  if (_sessionExpiredHandled) return;
  _sessionExpiredHandled = true;
  currentUser = null;
  try { sessionStorage.setItem('sessionExpired', '1'); } catch (e) {}
  // Stop background polling/idle timers from firing again during the redirect.
  if (_idleTimer) { clearInterval(_idleTimer); _idleTimer = null; }
  API.post('/auth/logout').catch(() => {}).finally(_goToLogin);
}

// ── Idle auto-logout ──────────────────────────────────────────────────────────
// Sign the user out after a stretch of no activity (mouse/touch/key/scroll), so
// an unattended screen doesn't stay logged in. Client-side: clears the cookie
// and reloads to the login page with a notice.
const IDLE_LIMIT_MS = 8 * 60 * 60 * 1000;  // 8 hours (a work shift). Was 5 min,
                                           // which signed people out the moment
                                           // they stepped away.
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
  if (e.key !== 'Enter') return;
  const overlay = document.getElementById('login-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  // Fire the primary action of whichever auth view is on screen — so Enter
  // never triggers the wrong form (e.g. logging in from the reset view).
  const vis = id => { const el = document.getElementById(id); return el && el.style.display !== 'none'; };
  // login-view is a real <form> now — its own submit handles Enter, so we skip
  // it here to avoid firing the login twice.
  if (vis('login-view'))        return;
  else if (vis('forgot-view'))  sendResetLink();
  else if (vis('reset-view'))   submitNewPassword();
  else if (vis('signup-view'))  submitInviteCode();
  // register-view has many fields + its own button; leave Enter to the field.
});
