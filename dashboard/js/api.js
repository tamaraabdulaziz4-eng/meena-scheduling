// ── API helper ────────────────────────────────────────────────────────────────
class APIError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.data = data;
  }
}

// ── Lightweight request timing (perf baseline) ────────────────────────────────
// Every API call records {path, ms, ok, bytes, at} into a small ring buffer on
// window.__perf so we can measure real latency/payload from the browser console
// (e.g. `__perf.summary()` for a per-endpoint p50/p95). Zero deps, always on, and
// cheap — this is the baseline the worklist/app perf work is judged against.
window.__perf = window.__perf || (function () {
  const buf = [];
  const MAX = 300;
  return {
    buf,
    record(e) { buf.push(e); if (buf.length > MAX) buf.shift(); },
    // Per-path aggregates (count, p50, p95, max ms, avg KB). Optional filter substring.
    summary(filter) {
      const by = {};
      for (const e of buf) {
        if (filter && !e.path.includes(filter)) continue;
        (by[e.path] = by[e.path] || []).push(e);
      }
      const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
      const out = {};
      for (const [path, es] of Object.entries(by)) {
        const ms = es.map((e) => e.ms);
        const kb = es.filter((e) => e.bytes != null).map((e) => e.bytes / 1024);
        out[path] = { n: es.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.round(Math.max(...ms)),
                      avgKB: kb.length ? +(kb.reduce((a, b) => a + b, 0) / kb.length).toFixed(1) : null,
                      fails: es.filter((e) => !e.ok).length };
      }
      return out;
    },
    clear() { buf.length = 0; },
  };
})();

const API = {
  // Requests that legitimately take a while (the solver runs up to ~60s) get a
  // longer ceiling; everything else fails fast so a cold/hung backend shows a
  // clear error instead of an endless spinner.
  _timeoutFor(path) {
    if (/\/(generate|autofill-cross-cover)/.test(path)) return 180000;  // 3 min
    // Radiology endpoints proxy to the HIS/DePACS connector, which fans out over
    // many bill/study reads on an uncached branch/date selection. The backend
    // itself allows up to ~240s, so the client must not abort at 45s and show a
    // false "took too long" while the server is still computing successfully.
    // worklist included: its server-side ceiling is 130s (survives the ~90-100s
    // HIS token refresh) — a 45s client abort would kill a load the server was
    // about to finish and show a false retry card.
    if (/\/radiology\/(stats|lookup|worklist|throughput|results\/(match|file))/.test(path)) return 240000;  // 4 min
    return 45000;                                                        // 45 s
  },
  _cond: new Map(),   // path -> { etag, data } : in-memory conditional-GET store (no disk cache)
  async request(method, path, body) {
    // no-store: never read API data from the browser cache — a GET right after a
    // save must hit the server, or the rota looks like it reverted.
    const opts = { method, credentials: 'include', cache: 'no-store', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    // Conditional GET: if we still hold the last body for this exact path, ask the server to
    // confirm it's unchanged. On a 304 the server sends ~0 bytes and we reuse the in-memory
    // copy — a real saving on the boards that poll every 10-30s. Kept in JS memory only
    // (no-store stays), so no patient data lands in the workstation's disk cache.
    const _isGet = method === 'GET';
    if (_isGet) { const c = API._cond.get(path); if (c) opts.headers['If-None-Match'] = c.etag; }
    // Abort the request if the server takes too long, so a slow/stuck backend
    // surfaces as a retry-able error rather than hanging the UI forever.
    const ctrl = new AbortController();
    opts.signal = ctrl.signal;
    const timer = setTimeout(() => ctrl.abort(), API._timeoutFor(path));
    const t0 = performance.now();
    // Record latency/size for every call (success or failure) into the perf ring buffer.
    const mark = (ok, bytes) => {
      try {
        const ms = Math.round(performance.now() - t0);
        window.__perf.record({ path, ms, ok, bytes, at: Date.now() });
        if (ms > 800) console.debug(`[api] ${method} ${path} ${ms}ms${bytes != null ? ' ' + Math.round(bytes / 1024) + 'KB' : ''}${ok ? '' : ' FAIL'}`);
      } catch (_) {}
    };
    let res;
    try {
      res = await fetch('/api' + path, opts);
    } catch (e) {
      clearTimeout(timer);
      mark(false, null);
      if (e.name === 'AbortError') {
        throw new APIError('The server took too long to respond. Please try again.', 0, {});
      }
      throw new APIError('Network error — check your connection and try again.', 0, {});
    }
    clearTimeout(timer);
    // 304 Not Modified → the content is identical to our last poll; reuse the stored body
    // (no re-download, no re-parse). Only reachable when we sent If-None-Match, so the entry
    // exists; if it somehow doesn't, fall through and treat it as a normal (error) response.
    if (res.status === 304 && _isGet) {
      const c = API._cond.get(path);
      if (c) { mark(true, 0); return c.data; }
    }
    const clen = res.headers.get('content-length');
    mark(res.ok, clen != null ? Number(clen) : null);
    const data = await res.json().catch(() => ({}));
    if (_isGet && res.ok) {
      const et = res.headers.get('etag');
      if (et) API._cond.set(path, { etag: et, data });
      else if (API._cond.has(path)) API._cond.delete(path);   // endpoint stopped sending ETags
    }
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
