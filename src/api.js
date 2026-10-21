// Thin client for the five Supabase RPC functions behind a plan link.
// The public anon/publishable key goes in the `apikey` header only.

export class ApiError extends Error {
  /** code: 'invalid_key' | 'invalid' | 'too_large' | 'limit' | 'network' | 'server' */
  constructor(message, { status = 0, code = 'server' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// Our functions raise exactly these messages. Anything else (a paused project, a rate-limited gateway,
// a bad API key) is the platform talking and counts as a transient server error, so unsent writes are
// kept and retried instead of being dropped.
const CODE_BY_MESSAGE = { invalid_key: 'invalid_key', invalid_argument: 'invalid', too_large: 'too_large', limit: 'limit' };

function codeFor(status, message) {
  if (CODE_BY_MESSAGE[message]) return CODE_BY_MESSAGE[message];
  if (status === 400) return 'invalid';
  if (status === 413) return 'too_large';
  return 'server';
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

const ERROR_TEXT = {
  invalid_key: 'Bağlantı geçersiz ya da yenilenmiş.',
  invalid: 'Gönderilen bilgi geçersiz.',
  too_large: 'Metin çok uzun.',
  limit: 'Bu planın sınırına ulaşıldı.',
  network: 'Bağlantı yok.',
  server: 'Sunucu şu an yanıt vermiyor.',
};

/** Turkish, user-facing text for an error; raw server messages are never shown. */
export function errorText(err) {
  return (err instanceof ApiError && ERROR_TEXT[err.code]) || 'Beklenmeyen bir hata oluştu.';
}

/** `timeoutMs` bounds the whole exchange: a request that stalls (a phone changing networks) must fail, not hang. */
export function createApi({ url, anonKey, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 15_000 }) {
  const base = `${url.replace(/\/+$/, '')}/rest/v1/rpc/`;
  const networkError = () => new ApiError('network error', { status: 0, code: 'network' });

  async function rpc(fn, params) {
    let res;
    let text;
    const signal = timeoutSignal(timeoutMs);
    try {
      res = await fetchImpl(base + fn, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal,
      });
      text = await res.text();
    } catch {
      throw networkError();
    }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      throw new ApiError(body?.message || res.statusText || `HTTP ${res.status}`, {
        status: res.status,
        code: codeFor(res.status, body?.message),
      });
    }
    return body;
  }

  return {
    planGet: (secret) => rpc('plan_get', { p_secret: secret }),
    answerSet: (secret, qid, v, by) => rpc('answer_set', { p_secret: secret, p_qid: qid, p_v: v ?? null, p_by: by }),
    commentAdd: (secret, scope, author, body) => rpc('comment_add', { p_secret: secret, p_scope: scope, p_author: author, p_body: body }),
    commentDelete: (secret, id) => rpc('comment_delete', { p_secret: secret, p_id: id }),
    ping: () => rpc('plan_ping', {}),
  };
}
