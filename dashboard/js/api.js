// ── API helper ────────────────────────────────────────────────────────────────
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
      const msg = (typeof data.detail === 'string' ? data.detail : data.detail?.error) || data.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  },
  get:    (path)        => API.request('GET',    path),
  post:   (path, body)  => API.request('POST',   path, body),
  put:    (path, body)  => API.request('PUT',    path, body),
  delete: (path, body)  => API.request('DELETE', path, body),
};
