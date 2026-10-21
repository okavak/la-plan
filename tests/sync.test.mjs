import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync } from '../src/sync.js';
import { ApiError } from '../src/api.js';
import { memStorage, manualTimers, deferred, settle } from './helpers.mjs';

const SECRET = 'AbCdEfGhIjKlMnOpQrStUv';
const emptyState = () => ({ meta: { title: 'T' }, answers: {}, comments: [], plan: null, now: '2026-10-21T10:00:00Z' });
const netError = () => new ApiError('net', { code: 'network' });

function makeApi(over = {}) {
  const calls = { planGet: [], answerSet: [], commentAdd: [], commentDelete: [] };
  const api = {
    planGet: async (s) => { calls.planGet.push(s); return over.planGet ? over.planGet(s) : emptyState(); },
    answerSet: async (...a) => { calls.answerSet.push(a); return over.answerSet ? over.answerSet(...a) : '2026-10-21T10:00:05Z'; },
    commentAdd: async (...a) => {
      calls.commentAdd.push(a);
      return over.commentAdd ? over.commentAdd(...a) : { id: 'c1', scope: a[1], author: a[2], body: a[3], at: '2026-10-21T10:00:06Z' };
    },
    commentDelete: async (...a) => { calls.commentDelete.push(a); return over.commentDelete ? over.commentDelete(...a) : true; },
    ping: async () => 'ok',
  };
  return { api, calls };
}

function setup(over = {}, opts = {}) {
  const { api, calls } = makeApi(over);
  const storage = opts.storage ?? memStorage();
  const timers = manualTimers();
  let t = opts.t ?? 1000;
  const clock = { now: () => t, set: (v) => { t = v; } };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const sync = createSync({ api, secret, storage, now: clock.now, pollMs: 5000, timers });
  return { sync, calls, storage, timers, clock };
}

test('a poll brings in another person\'s answer', async () => {
  const { sync } = setup({
    planGet: () => ({ ...emptyState(), answers: { disney: { v: 'two', by: 'Eşim', at: '2026-10-21T09:59:00Z' } } }),
  });
  sync.start();
  await settle();
  const s = sync.getState();
  assert.equal(s.status, 'live');
  assert.equal(s.answers.disney, 'two');
  assert.deepEqual(s.info.disney, { by: 'Eşim', at: '2026-10-21T09:59:00Z' });
  assert.equal(s.meta.title, 'T');
  assert.ok(s.lastSyncAt != null);
});

test('start schedules the next poll after the poll interval', async () => {
  const { sync, timers } = setup();
  sync.start();
  await settle();
  assert.deepEqual(timers.list().map((t) => t.ms), [5000]);
  sync.stop();
  assert.deepEqual(timers.list(), []);
});

test('start paints from the cache before the first poll answers', async () => {
  const storage = memStorage();
  const first = setup({
    planGet: () => ({ ...emptyState(), answers: { disney: { v: 'two', by: 'Eşim', at: '2026-10-21T09:59:00Z' } } }),
  }, { storage });
  first.sync.start();
  await settle();
  first.sync.stop();

  const gate = deferred();
  const second = setup({ planGet: () => gate.promise }, { storage });
  second.sync.start();
  assert.equal(second.sync.getState().status, 'connecting');
  assert.equal(second.sync.getState().answers.disney, 'two');
  gate.resolve(emptyState());
  await settle();
});

test('setAnswer is visible immediately and queued', async () => {
  const gate = deferred();
  const { sync, calls } = setup({ answerSet: () => gate.promise });
  sync.setAnswer('disney', 'two', 'Ali');
  assert.equal(sync.getState().answers.disney, 'two');
  assert.equal(sync.getState().pendingCount, 1);
  await settle();
  assert.deepEqual(calls.answerSet, [[SECRET, 'disney', 'two', 'Ali']]);
});

test('an acked write clears pending and records info', async () => {
  const { sync, storage } = setup({ answerSet: () => '2026-10-21T10:00:05Z' });
  sync.setAnswer('disney', 'two', 'Ali');
  await settle();
  const s = sync.getState();
  assert.equal(s.pendingCount, 0);
  assert.deepEqual(s.info.disney, { by: 'Ali', at: '2026-10-21T10:00:05Z' });
  const pendingKey = Object.keys(storage.dump()).find((k) => k.endsWith(':pending'));
  assert.deepEqual(JSON.parse(storage.getItem(pendingKey)), {});
});

test('stale poll after an acked write does not revert it', async () => {
  const poll = deferred();
  let n = 0;
  const { sync, clock } = setup({ planGet: () => (++n === 1 ? poll.promise : emptyState()) });
  clock.set(100);
  const refreshing = sync.refresh();
  clock.set(200);
  sync.setAnswer('disney', 'new', 'Ali');
  await settle();
  poll.resolve({ ...emptyState(), answers: { disney: { v: 'old', by: 'X', at: '2026-10-21T09:00:00Z' } } });
  await refreshing;
  assert.equal(sync.getState().answers.disney, 'new');
  assert.equal(sync.getState().info.disney.by, 'Ali');
});

test('a poll that started after the ack takes the server value again', async () => {
  let server = {};
  const { sync, clock } = setup({ planGet: () => ({ ...emptyState(), answers: server }) });
  clock.set(100);
  sync.setAnswer('disney', 'mine', 'Ali');
  await settle();
  server = { disney: { v: 'theirs', by: 'Eşim', at: '2026-10-21T10:01:00Z' } };
  clock.set(300);
  await sync.refresh();
  assert.equal(sync.getState().answers.disney, 'theirs');
  assert.equal(sync.getState().info.disney.by, 'Eşim');
});

test('a failed write sets offline and retries with 2 s then 4 s backoff', async () => {
  let failures = 2;
  const { sync, timers, calls } = setup({
    answerSet: () => { if (failures-- > 0) throw netError(); return '2026-10-21T10:00:05Z'; },
  });
  sync.setAnswer('disney', 'two', 'Ali');
  await settle();
  assert.equal(sync.getState().status, 'offline');
  assert.deepEqual(timers.list().map((t) => t.ms), [2000]);
  await timers.fire();
  await settle();
  assert.deepEqual(timers.list().map((t) => t.ms), [4000]);
  await timers.fire();
  await settle();
  assert.equal(sync.getState().status, 'live');
  assert.equal(sync.getState().pendingCount, 0);
  assert.equal(calls.answerSet.length, 3);
});

test('reload replays persisted pending writes', async () => {
  const storage = memStorage();
  const first = setup({ answerSet: () => { throw netError(); } }, { storage });
  first.sync.setAnswer('disney', 'two', 'Ali');
  await settle();
  assert.equal(first.sync.getState().pendingCount, 1);
  first.sync.stop();

  const second = setup({}, { storage });
  second.sync.start();
  await settle();
  assert.deepEqual(second.calls.answerSet, [[SECRET, 'disney', 'two', 'Ali']]);
  assert.equal(second.sync.getState().pendingCount, 0);
  assert.equal(second.sync.getState().answers.disney, 'two');
});

test('two quick toggles of one qid send the newest value last', async () => {
  const gates = [deferred(), deferred()];
  let i = 0;
  const { sync, calls } = setup({ answerSet: () => gates[i++].promise });
  sync.setAnswer('daytrip', ['a'], 'Ali');
  sync.setAnswer('daytrip', ['a', 'b'], 'Ali');
  await settle();
  assert.equal(calls.answerSet.length, 1, 'only one write in flight per question');
  assert.deepEqual(calls.answerSet[0][2], ['a']);
  gates[0].resolve('2026-10-21T10:00:01Z');
  await settle();
  assert.equal(calls.answerSet.length, 2);
  assert.deepEqual(calls.answerSet[1][2], ['a', 'b']);
  assert.equal(sync.getState().pendingCount, 1, 'newest value stays pending until its own ack');
  gates[1].resolve('2026-10-21T10:00:02Z');
  await settle();
  assert.equal(sync.getState().pendingCount, 0);
  assert.deepEqual(sync.getState().answers.daytrip, ['a', 'b']);
});

test('clearing an answer sends an empty value and removes it locally', async () => {
  const { sync, calls } = setup();
  sync.setAnswer('disney', 'two', 'Ali');
  await settle();
  sync.setAnswer('disney', undefined, 'Ali');
  await settle();
  assert.equal(sync.getState().answers.disney, undefined);
  assert.equal(calls.answerSet[1][2], '');
});

test('a rejected write is dropped, reported, and the server value returns on the next poll', async () => {
  const { sync, timers } = setup({
    answerSet: () => { throw new ApiError('too long', { status: 413, code: 'too_large' }); },
    planGet: () => emptyState(),
  });
  sync.setAnswer('note', 'x'.repeat(10), 'Ali');
  await settle();
  const s = sync.getState();
  assert.equal(s.pendingCount, 0);
  assert.equal(s.error, 'Metin çok uzun.');
  assert.deepEqual(timers.list(), [], 'no retry for a permanent error');
  await sync.refresh();
  assert.equal(sync.getState().answers.note, undefined);
});

test('null plan_get sets status invalid and stops polling', async () => {
  const { sync, calls, timers } = setup({ planGet: () => null });
  sync.start();
  await settle();
  assert.equal(sync.getState().status, 'invalid');
  assert.deepEqual(timers.list(), []);
  await sync.refresh();
  assert.equal(calls.planGet.length, 1, 'no further requests once the key is known to be invalid');
});

test('an offline poll keeps the last state and sets status offline', async () => {
  let fail = false;
  const { sync } = setup({
    planGet: () => {
      if (fail) throw netError();
      return { ...emptyState(), answers: { disney: { v: 'two', by: 'Eşim', at: '2026-10-21T09:59:00Z' } } };
    },
  });
  await sync.refresh();
  fail = true;
  await sync.refresh();
  assert.equal(sync.getState().status, 'offline');
  assert.equal(sync.getState().answers.disney, 'two');
});

test('secret null stays local and never calls the api', async () => {
  const api = new Proxy({}, { get() { throw new Error('api must not be used in local mode'); } });
  const storage = memStorage();
  const sync = createSync({ api, secret: null, storage, timers: manualTimers() });
  sync.start();
  sync.setAnswer('disney', 'two', 'Ali');
  await settle();
  assert.equal(sync.getState().status, 'local');
  assert.equal(sync.getState().answers.disney, 'two');
  assert.equal(sync.getState().pendingCount, 0);
  const again = createSync({ api, secret: null, storage, timers: manualTimers() });
  again.start();
  assert.equal(again.getState().answers.disney, 'two');
});

test('addComment appends the returned comment and removeComment drops it', async () => {
  const { sync, calls } = setup();
  await sync.addComment('general', 'Ali', 'merhaba');
  assert.deepEqual(calls.commentAdd, [[SECRET, 'general', 'Ali', 'merhaba']]);
  assert.deepEqual(sync.getState().comments.map((c) => c.id), ['c1']);
  await sync.removeComment('c1');
  assert.deepEqual(calls.commentDelete, [[SECRET, 'c1']]);
  assert.deepEqual(sync.getState().comments, []);
});

test('a failed addComment rejects and leaves the comments unchanged', async () => {
  const { sync } = setup({ commentAdd: () => { throw new ApiError('too long', { status: 400, code: 'invalid' }); } });
  await assert.rejects(sync.addComment('general', 'Ali', 'x'), (e) => e.code === 'invalid');
  assert.deepEqual(sync.getState().comments, []);
});

test('pendingIds lists the questions with unsent values', async () => {
  const gate = deferred();
  const { sync } = setup({ answerSet: () => gate.promise });
  assert.deepEqual(sync.getState().pendingIds, []);
  sync.setAnswer('disney', 'two', 'Ali');
  sync.setAnswer('note', 'merhaba', 'Ali');
  assert.deepEqual([...sync.getState().pendingIds].sort(), ['disney', 'note']);
  gate.resolve('2026-10-21T10:00:05Z');
  await settle();
  assert.deepEqual(sync.getState().pendingIds, []);
});

test('a rejected write is reported per question until the next attempt', async () => {
  let reject = true;
  const { sync } = setup({
    answerSet: () => {
      if (reject) throw new ApiError('too long', { status: 413, code: 'too_large' });
      return '2026-10-21T10:00:05Z';
    },
  });
  assert.deepEqual(sync.getState().rejected, {});
  sync.setAnswer('note', 'x'.repeat(10), 'Ali');
  await settle();
  assert.deepEqual(sync.getState().rejected, { note: 'Metin çok uzun.' });
  reject = false;
  sync.setAnswer('note', 'kısa', 'Ali');
  assert.deepEqual(sync.getState().rejected, {}, 'cleared as soon as a new value is set');
  await settle();
  assert.deepEqual(sync.getState().rejected, {});
  assert.equal(sync.getState().info.note.by, 'Ali');
});

test('kick retries a failed write at once, cancels the scheduled retry and polls', async () => {
  let fail = true;
  const { sync, timers, calls } = setup({
    answerSet: () => { if (fail) throw netError(); return '2026-10-21T10:00:05Z'; },
  });
  sync.setAnswer('disney', 'two', 'Ali');
  await settle();
  assert.deepEqual(timers.list().map((t) => t.ms), [2000]);
  fail = false;
  sync.kick();
  await settle();
  assert.equal(sync.getState().pendingCount, 0);
  assert.equal(sync.getState().status, 'live');
  assert.deepEqual(timers.list(), [], 'the old retry timer is gone');
  assert.equal(calls.answerSet.length, 2);
  assert.equal(calls.planGet.length, 1, 'kick also refreshes');
});

test('kick does nothing in local mode or on an invalid link', async () => {
  const api = new Proxy({}, { get() { throw new Error('api must not be used'); } });
  const local = createSync({ api, secret: null, storage: memStorage(), timers: manualTimers() });
  local.kick();
  const bad = setup({ planGet: () => null });
  await bad.sync.refresh();
  bad.sync.kick();
  await settle();
  assert.equal(bad.calls.planGet.length, 1);
});

test('subscribers are notified and can unsubscribe', async () => {
  const { sync } = setup();
  const seen = [];
  const off = sync.subscribe((s) => seen.push(s.pendingCount));
  sync.setAnswer('disney', 'two', 'Ali');
  assert.ok(seen.length >= 1);
  off();
  const before = seen.length;
  sync.setAnswer('disney', 'dl1', 'Ali');
  assert.equal(seen.length, before);
});
