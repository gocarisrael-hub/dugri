// Thin client for the parts of the Dugri HTTP API the stress harness drives.
//
// DELIBERATELY the real HTTP API, not the Python generator: a failure in the
// route, the 120s timeout, the response handling or the download is exactly the
// class of bug an isolated generator call steps straight over. Every call
// therefore goes over the wire to a real deployment, exactly as the owner's
// browser does it.
//
// No dependencies — Node's global fetch, so the harness runs anywhere Node 18+
// does with nothing installed.

// Node's default fetch has NO timeout. A hung generate would wedge the harness
// forever, so every call carries an explicit abort. The generate cap is set well
// ABOVE the server's own GENERATE_TIMEOUT_MS (120s) on purpose: we want to
// OBSERVE the server's timeout response, not race it with our own.
const DEFAULT_TIMEOUT_MS = 60000;

class Api {
  constructor({ base, key, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.base = String(base).replace(/\/+$/, '');
    this.key = key;
    this.timeoutMs = timeoutMs;
  }

  url(p, params) {
    const u = new URL(this.base + p);
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  // One request, fully instrumented: status, parsed body (or the raw text when
  // it isn't JSON — an HTML 502 page from the edge is a result, not a crash),
  // wall time, and any transport-level error.
  async req(method, p, { params, body, timeoutMs, raw } = {}) {
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || this.timeoutMs);
    try {
      const res = await fetch(this.url(p, params), {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const ms = Date.now() - started;
      if (raw) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { status: res.status, ms, buf, contentType: res.headers.get('content-type') };
      }
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON — keep the text, which is the interesting part */
      }
      return { status: res.status, ms, json, text: json ? null : text.slice(0, 1200) };
    } catch (e) {
      return {
        status: 0,
        ms: Date.now() - started,
        error: String((e && e.message) || e),
        aborted: ctl.signal.aborted,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // --- the buyer-side flow ---------------------------------------------------
  createCollection(fields) {
    return this.req('POST', '/api/collections', { body: fields });
  }

  addWords(id, words) {
    return this.req('POST', `/api/collections/${id}/words`, { body: { words } });
  }

  // --- admin ----------------------------------------------------------------
  patchCollection(id, patch) {
    return this.req('PATCH', `/api/admin/collections/${id}`, {
      params: { key: this.key },
      body: patch,
    });
  }

  deleteCollection(id) {
    return this.req('DELETE', `/api/admin/collections/${id}`, { params: { key: this.key } });
  }

  generate(id, body, timeoutMs) {
    return this.req('POST', `/api/admin/collections/${id}/generate`, {
      params: { key: this.key },
      body,
      // Above the server's 120s cap so we see ITS timeout, not ours.
      timeoutMs: timeoutMs || 300000,
    });
  }

  downloadPdf(id) {
    return this.req('GET', `/api/admin/collections/${id}/pdf`, {
      params: { key: this.key },
      raw: true,
      timeoutMs: 180000,
    });
  }

  downloadBoard(id) {
    return this.req('GET', `/api/admin/collections/${id}/board`, {
      params: { key: this.key },
      raw: true,
      timeoutMs: 180000,
    });
  }

  startPress(id, body) {
    return this.req('POST', `/api/admin/collections/${id}/press`, {
      params: { key: this.key },
      body,
    });
  }

  // ONE route serves both poll and download: 202 while building, 409 on failure,
  // and 200 STREAMS THE PDF. So the poll must be read as raw bytes — reading a
  // multi-MB press PDF as text would corrupt it — and the JSON statuses are
  // decoded from those same bytes.
  async pressGet(id) {
    const r = await this.req('GET', `/api/admin/collections/${id}/press`, {
      params: { key: this.key },
      raw: true,
      timeoutMs: 300000,
    });
    if (r.status === 200) return r;
    if (r.buf) {
      try {
        r.json = JSON.parse(r.buf.toString('utf8'));
      } catch {
        r.text = r.buf.toString('utf8').slice(0, 600);
      }
    }
    return r;
  }

  preview(body) {
    return this.req('POST', '/api/preview', { body, timeoutMs: 120000 });
  }

  templates() {
    return this.req('GET', '/api/admin/templates', { params: { key: this.key } });
  }
}

export { Api, DEFAULT_TIMEOUT_MS };
