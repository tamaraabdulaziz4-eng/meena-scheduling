// ── API helper ────────────────────────────────────────────────────────────────
class APIError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.data = data;
  }
}

const API = {
  // Requests that legitimately take a while (the solver runs up to ~60s) get a
  // longer ceiling; everything else fails fast so a cold/hung backend shows a
  // clear error instead of an endless spinner.
  _timeoutFor(path) {
    if (/\/(generate|autofill-cross-cover)/.test(path)) return 180000;  // 3 min
    return 45000;                                                        // 45 s
  },
  async request(method, path, body) {
    // no-store: never read API data from the browser cache — a GET right after a
    // save must hit the server, or the rota looks like it reverted.
    const opts = { method, credentials: 'include', cache: 'no-store', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    // Abort the request if the server takes too long, so a slow/stuck backend
    // surfaces as a retry-able error rather than hanging the UI forever.
    const ctrl = new AbortController();
    opts.signal = ctrl.signal;
    const timer = setTimeout(() => ctrl.abort(), API._timeoutFor(path));
    let res;
    try {
      res = await fetch('/api' + path, opts);
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        throw new APIError('The server took too long to respond. Please try again.', 0, {});
      }
      throw new APIError('Network error — check your connection and try again.', 0, {});
    }
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A 401 on any non-auth call after we were signed in means the session
      // died under us (token expired, password changed elsewhere, account
      // removed). Bounce to a clean login with a notice instead of leaving the
      // user staring at error toasts on a half-broken page.
      if (res.status === 401 && !path.startsWith('/auth/') &&
          typeof currentUser !== 'undefined' && currentUser &&
          typeof handleSessionExpired === 'function') {
        handleSessionExpired();
      }
      const msg = (typeof data.detail === 'string' ? data.detail : data.detail?.error) || data.error || `HTTP ${res.status}`;
      throw new APIError(msg, res.status, data);
    }
    return data;
  },
  get:    (path)        => API.request('GET',    path),
  post:   (path, body)  => API.request('POST',   path, body),
  put:    (path, body)  => API.request('PUT',    path, body),
  delete: (path, body)  => API.request('DELETE', path, body),
};
