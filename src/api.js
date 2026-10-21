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

const CODE_BY_STATUS = { 400: 'invalid', 401: 'invalid_key', 413: 'too_large', 429: 'limit' };

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

export function createApi({ url, anonKey, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  const base = `${url.replace(/\/+$/, '')}/rest/v1/rpc/`;

  async function rpc(fn, params) {
    let res;
    try {
      res = await fetchImpl(base + fn, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch {
      throw new ApiError('network error', { status: 0, code: 'network' });
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      throw new ApiError(body?.message || res.statusText || `HTTP ${res.status}`, {
        status: res.status,
        code: CODE_BY_STATUS[res.status] ?? 'server',
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
