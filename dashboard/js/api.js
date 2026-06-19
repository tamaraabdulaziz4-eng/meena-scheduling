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
  async request(method, path, body) {
    const opts = { method, credentials: 'include', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api' + path, opts);
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
