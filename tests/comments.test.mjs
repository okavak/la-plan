import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAME_KEY, formatWhen, renderThread, ensureName, postComment, submitFromTextarea } from '../src/comments.js';
import { ApiError } from '../src/api.js';
import { memStorage } from './helpers.mjs';

const NOW = Date.parse('2026-10-21T10:00:00Z');
const comment = (over = {}) => ({ id: 'u1', scope: 'general', author: 'Ali', body: 'merhaba', at: '2026-10-21T09:55:00Z', ...over });

test('renderThread escapes author and body', () => {
  const html = renderThread([comment({ author: '<b>Ali</b>', body: '<script>alert(1)</script> "q" & ünlü' })], 'Veli', NOW);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>Ali</b>'));
  assert.ok(html.includes('&lt;b&gt;Ali&lt;/b&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot; &amp; ünlü'));
});

test('renderThread shows delete only for own comments', () => {
  const list = [comment({ id: 'a', author: 'Ali' }), comment({ id: 'b', author: 'Veli' })];
  const html = renderThread(list, 'Ali', NOW);
  assert.ok(html.includes('data-del="a"'));
  assert.ok(!html.includes('data-del="b"'));
  assert.ok(!renderThread(list, '', NOW).includes('data-del='));
});

test('renderThread renders nothing for an empty list and shows when each comment was written', () => {
  assert.equal(renderThread([], 'Ali', NOW), '');
  assert.ok(renderThread([comment()], 'Ali', NOW).includes('5 dk önce'));
});

test('formatWhen buckets', () => {
  assert.equal(formatWhen('2026-10-21T09:59:40Z', NOW), 'şimdi');
  assert.equal(formatWhen('2026-10-21T10:00:30Z', NOW), 'şimdi', 'a server clock slightly ahead is still now');
  assert.equal(formatWhen('2026-10-21T09:55:00Z', NOW), '5 dk önce');
  assert.equal(formatWhen('2026-10-21T07:00:00Z', NOW), '3 sa önce');
  assert.equal(formatWhen('2026-10-20T08:00:00Z', NOW), 'dün');
  assert.match(formatWhen('2026-10-12T09:30:00Z', NOW), /^12 Eki \d{2}:\d{2}$/);
  assert.equal(formatWhen('', NOW), '');
  assert.equal(formatWhen('not a date', NOW), '');
});

test('ensureName returns the stored name without asking', async () => {
  const storage = memStorage({ [NAME_KEY]: 'Ali' });
  const name = await ensureName(storage, async () => { throw new Error('must not ask'); });
  assert.equal(name, 'Ali');
});

test('ensureName stores a trimmed name, caps it at 40 characters and rejects an empty one', async () => {
  const storage = memStorage();
  assert.equal(await ensureName(storage, async () => '  Ayşe  '), 'Ayşe');
  assert.equal(storage.getItem(NAME_KEY), 'Ayşe');

  const long = memStorage();
  assert.equal((await ensureName(long, async () => 'x'.repeat(60))).length, 40);

  for (const answer of ['   ', '', null]) {
    const fresh = memStorage();
    assert.equal(await ensureName(fresh, async () => answer), null);
    assert.equal(fresh.getItem(NAME_KEY), null, 'an empty name is never stored');
  }
});

test('postComment sends the trimmed body and reports ok', async () => {
  const sent = [];
  const sync = { addComment: async (...a) => { sent.push(a); } };
  assert.deepEqual(await postComment({ sync, scope: 'q:disney', author: 'Ali', body: '  merhaba  ' }), { ok: true });
  assert.deepEqual(sent, [['q:disney', 'Ali', 'merhaba']]);
});

test('postComment refuses an empty body without calling the server', async () => {
  const sync = { addComment: async () => { throw new Error('must not send'); } };
  const r = await postComment({ sync, scope: 'general', author: 'Ali', body: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Boş/);
});

test('postComment turns server errors into Turkish text and tells the user the draft is safe', async () => {
  const failing = (code) => ({ addComment: async () => { throw new ApiError('raw', { code }); } });
  const long = await postComment({ sync: failing('invalid'), scope: 'general', author: 'Ali', body: 'x' });
  assert.deepEqual(long, { ok: false, error: 'Gönderilen bilgi geçersiz.' });
  const offline = await postComment({ sync: failing('network'), scope: 'general', author: 'Ali', body: 'x' });
  assert.equal(offline.ok, false);
  assert.equal(offline.error, 'Bağlantı yok. Metniniz duruyor, tekrar deneyin.');
});

test('rejected comment keeps the draft', async () => {
  const failing = { addComment: async () => { throw new ApiError('raw', { code: 'network' }); } };
  const textarea = { value: 'uzun bir yorum taslağı' };
  const r = await submitFromTextarea({ textarea, sync: failing, scope: 'general', author: 'Ali' });
  assert.equal(r.ok, false);
  assert.equal(textarea.value, 'uzun bir yorum taslağı');
});

test('an accepted comment clears the draft', async () => {
  const sync = { addComment: async () => {} };
  const textarea = { value: ' merhaba ' };
  const r = await submitFromTextarea({ textarea, sync, scope: 'general', author: 'Ali' });
  assert.deepEqual(r, { ok: true });
  assert.equal(textarea.value, '');
});
