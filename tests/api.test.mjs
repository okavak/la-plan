import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi, errorText } from '../src/api.js';

const URL_BASE = 'https://abc.supabase.co';
const ANON = 'sb_publishable_test';

/** Recording fake fetch: `reply` is {status?, body?} or an Error to throw. */
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const r = typeof reply === 'function' ? reply(calls.length) : reply;
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

function setup(reply) {
  const fetchImpl = fakeFetch(reply);
  return { fetchImpl, api: createApi({ url: URL_BASE, anonKey: ANON, fetchImpl }) };
}

test('planGet posts p_secret to /rest/v1/rpc/plan_get with apikey', async () => {
  const state = { meta: { title: 'T' }, answers: {}, comments: [], plan: null, now: '2026-10-21T10:00:00Z' };
  const { api, fetchImpl } = setup({ body: state });
  assert.deepEqual(await api.planGet('SECRET'), state);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, `${URL_BASE}/rest/v1/rpc/plan_get`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.apikey, ANON);
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(call.body, { p_secret: 'SECRET' });
});

test('a trailing slash on the base url does not double up', async () => {
  const fetchImpl = fakeFetch({ body: 'ok' });
  const api = createApi({ url: `${URL_BASE}/`, anonKey: ANON, fetchImpl });
  await api.ping();
  assert.equal(fetchImpl.calls[0].url, `${URL_BASE}/rest/v1/rpc/plan_ping`);
});

test('planGet resolves null for a null body', async () => {
  const { api } = setup({ body: null });
  assert.equal(await api.planGet('UNKNOWN'), null);
});

test('answerSet sends p_qid, p_v, p_by and returns the timestamp', async () => {
  const { api, fetchImpl } = setup({ body: '2026-10-21T10:00:01Z' });
  assert.equal(await api.answerSet('S', 'disney', ['a', 'b'], 'Eşim'), '2026-10-21T10:00:01Z');
  assert.deepEqual(fetchImpl.calls[0].body, { p_secret: 'S', p_qid: 'disney', p_v: ['a', 'b'], p_by: 'Eşim' });
  assert.equal(fetchImpl.calls[0].url, `${URL_BASE}/rest/v1/rpc/answer_set`);
});

test('answerSet sends an undefined (cleared) value as null', async () => {
  const { api, fetchImpl } = setup({ body: '2026-10-21T10:00:01Z' });
  await api.answerSet('S', 'disney', undefined, 'A');
  assert.equal(fetchImpl.calls[0].body.p_v, null);
});

test('commentAdd and commentDelete send their p_ params', async () => {
  const comment = { id: 'u1', scope: 'general', author: 'A', body: 'hi', at: '2026-10-21T10:00:00Z' };
  const add = setup({ body: comment });
  assert.deepEqual(await add.api.commentAdd('S', 'general', 'A', 'hi'), comment);
  assert.deepEqual(add.fetchImpl.calls[0].body, { p_secret: 'S', p_scope: 'general', p_author: 'A', p_body: 'hi' });
  assert.equal(add.fetchImpl.calls[0].url, `${URL_BASE}/rest/v1/rpc/comment_add`);

  const del = setup({ body: true });
  assert.equal(await del.api.commentDelete('S', 'u1'), true);
  assert.deepEqual(del.fetchImpl.calls[0].body, { p_secret: 'S', p_id: 'u1' });
  assert.equal(del.fetchImpl.calls[0].url, `${URL_BASE}/rest/v1/rpc/comment_delete`);
});

test('ping posts an empty object and resolves ok', async () => {
  const { api, fetchImpl } = setup({ body: 'ok' });
  assert.equal(await api.ping(), 'ok');
  assert.deepEqual(fetchImpl.calls[0].body, {});
});

test('status 401, 400, 413, 429 map to the ApiError codes', async () => {
  const expected = { 401: 'invalid_key', 400: 'invalid', 413: 'too_large', 429: 'limit' };
  for (const [status, code] of Object.entries(expected)) {
    const { api } = setup({ status: Number(status), body: { message: `m${status}` } });
    await assert.rejects(api.answerSet('S', 'q', 'a', 'A'), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, code);
      assert.equal(err.status, Number(status));
      assert.equal(err.message, `m${status}`);
      return true;
    });
  }
});

test('a thrown fetch maps to network', async () => {
  const { api } = setup(new TypeError('Failed to fetch'));
  await assert.rejects(api.planGet('S'), (err) => err instanceof ApiError && err.code === 'network' && err.status === 0);
});

test('errorText gives a Turkish sentence per error code', () => {
  const text = (code) => errorText(new ApiError('raw server message', { code }));
  assert.equal(text('invalid_key'), 'Bağlantı geçersiz ya da yenilenmiş.');
  assert.equal(text('invalid'), 'Gönderilen bilgi geçersiz.');
  assert.equal(text('too_large'), 'Metin çok uzun.');
  assert.equal(text('limit'), 'Bu planın sınırına ulaşıldı.');
  assert.equal(text('network'), 'Bağlantı yok.');
  assert.equal(text('server'), 'Sunucu şu an yanıt vermiyor.');
  assert.equal(errorText(new Error('boom')), 'Beklenmeyen bir hata oluştu.');
  assert.ok(!text('invalid').includes('raw server message'), 'raw server text is never shown');
});

test('a 503 and an unexpected 404 map to server', async () => {
  for (const status of [503, 404]) {
    const { api } = setup({ status, body: { message: 'x' } });
    await assert.rejects(api.planGet('S'), (err) => err instanceof ApiError && err.code === 'server' && err.status === status);
  }
});
