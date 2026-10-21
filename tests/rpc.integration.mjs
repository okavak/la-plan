// Contract tests for the five RPC functions behind a plan link.
//
//   node --test tests/rpc.integration.mjs                      against the in-memory fake (default)
//   LA_TARGET=remote node --test tests/rpc.integration.mjs     against the real Supabase project
//                                                              (needs ~/.config/la-plan/env and a Supabase login)
//
// Every test makes its own throwaway plan (itest-<random>) and all of them are deleted afterwards.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startFakeBackend } from '../tools/fake-backend.mjs';
import { createAdmin, loadEnv, supabaseRunner } from '../tools/admin.mjs';
import { createApi } from '../src/api.js';

const target = {};
const created = [];
let api;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRONG_KEY = 'x'.repeat(22);
const rejectsWith = (promise, code, status) => assert.rejects(promise, (e) => e.code === code && (status == null || e.status === status));

before(async () => {
  if ((process.env.LA_TARGET || 'fake') === 'remote') {
    const env = loadEnv();
    const admin = createAdmin({ runSql: supabaseRunner(env.LA_PROJECT_REF) });
    Object.assign(target, {
      url: env.LA_SUPABASE_URL,
      anonKey: env.LA_SUPABASE_ANON_KEY,
      newPlan: async (slug, title, secret) => admin.newPlan(slug, title, { subtitle: `${title} subtitle`, secret }),
      deletePlan: async (slug) => admin.deletePlan(slug),
      close: async () => {},
    });
  } else {
    const fake = await startFakeBackend();
    Object.assign(target, {
      url: fake.url,
      anonKey: 'dev',
      newPlan: (slug, title, secret) => fake.newPlan(slug, title, `${title} subtitle`, secret),
      deletePlan: (slug) => fake.deletePlan(slug),
      close: () => fake.close(),
    });
  }
  api = createApi({ url: target.url, anonKey: target.anonKey });
});

after(async () => {
  for (const slug of created) await target.deletePlan(slug);
  await target.close();
});

async function freshPlan(title = 'Plan') {
  const slug = `itest-${randomBytes(4).toString('hex')}`;
  const secret = randomBytes(16).toString('base64url');
  created.push(slug);
  await target.newPlan(slug, title, secret);
  return { slug, secret };
}

const raw = (fn, body) => fetch(`${target.url}/rest/v1/rpc/${fn}`, {
  method: 'POST',
  headers: { apikey: target.anonKey, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('plan_get returns null for an unknown key', async () => {
  assert.equal(await api.planGet(WRONG_KEY), null);
  assert.equal(await api.planGet(''), null);
});

test('plan_get returns the meta of its own plan and nothing from the other plan', async () => {
  const a = await freshPlan('Plan A');
  const b = await freshPlan('Plan B');
  await api.answerSet(b.secret, 'disney', 'dl1', 'Bee');
  await api.commentAdd(b.secret, 'general', 'Bee', 'only for B');
  const stateA = await api.planGet(a.secret);
  assert.equal(stateA.meta.title, 'Plan A');
  assert.equal(stateA.meta.subtitle, 'Plan A subtitle');
  assert.deepEqual(stateA.answers, {});
  assert.deepEqual(stateA.comments, []);
  assert.equal(stateA.plan, null);
  assert.equal(typeof stateA.now, 'string');
  const stateB = await api.planGet(b.secret);
  assert.equal(stateB.meta.title, 'Plan B');
  assert.equal(stateB.answers.disney.v, 'dl1');
  assert.equal(stateB.comments.length, 1);
});

test('answer_set upserts and plan_get returns v, by, at', async () => {
  const { secret } = await freshPlan();
  const at = await api.answerSet(secret, 'disney', 'two', 'Ali');
  assert.ok(Number.isFinite(Date.parse(at)));
  await api.answerSet(secret, 'disney', 'dl1', '  Eş  ');
  await api.answerSet(secret, 'daytrip', ['catalina', 'snow'], 'Ali');
  await api.answerSet(secret, 'allergy', 'fındık <b>', undefined);
  const { answers } = await api.planGet(secret);
  assert.deepEqual(Object.keys(answers).sort(), ['allergy', 'daytrip', 'disney']);
  assert.equal(answers.disney.v, 'dl1');
  assert.equal(answers.disney.by, 'Eş');
  assert.ok(Number.isFinite(Date.parse(answers.disney.at)));
  assert.deepEqual(answers.daytrip.v, ['catalina', 'snow']);
  assert.equal(answers.allergy.v, 'fındık <b>');
  assert.equal(answers.allergy.by, null);
});

test("answer_set with '', [] and null clears the answer", async () => {
  const { secret } = await freshPlan();
  for (const empty of ['', [], null]) {
    await api.answerSet(secret, 'q1', 'x', 'A');
    assert.equal((await api.planGet(secret)).answers.q1.v, 'x');
    await api.answerSet(secret, 'q1', empty, 'A');
    assert.equal((await api.planGet(secret)).answers.q1, undefined, `cleared by ${JSON.stringify(empty)}`);
  }
});

test('answer_set rejects a bad qid, a long name and an oversized value', async () => {
  const { secret } = await freshPlan();
  for (const bad of ['Bad Id', '', '-x', 'a/b', 'x'.repeat(65)]) await rejectsWith(api.answerSet(secret, bad, 'x', 'A'), 'invalid', 400);
  await rejectsWith(api.answerSet(secret, 'q1', 'x', 'n'.repeat(41)), 'invalid', 400);
  await api.answerSet(secret, 'q1', 'x', 'n'.repeat(40));
  // The JSON text of a string is its length plus two quotes: 4094 chars is exactly 4096 bytes.
  await api.answerSet(secret, 'q2', 'x'.repeat(4094), 'A');
  await rejectsWith(api.answerSet(secret, 'q3', 'x'.repeat(4095), 'A'), 'too_large', 413);
});

test('a wrong key is rejected on every write', async () => {
  await rejectsWith(api.answerSet(WRONG_KEY, 'q1', 'a', 'A'), 'invalid_key', 401);
  await rejectsWith(api.commentAdd(WRONG_KEY, 'general', 'A', 'b'), 'invalid_key', 401);
  await rejectsWith(api.commentDelete(WRONG_KEY, '00000000-0000-4000-8000-000000000000'), 'invalid_key', 401);
});

test('comment_add then comment_delete round trip', async () => {
  const { secret } = await freshPlan();
  const c = await api.commentAdd(secret, 'q:disney', '  Ali ', '  merhaba  ');
  assert.equal(c.author, 'Ali');
  assert.equal(c.body, 'merhaba');
  assert.equal(c.scope, 'q:disney');
  assert.match(c.id, UUID);
  assert.ok(Number.isFinite(Date.parse(c.at)));
  await api.commentAdd(secret, 'general', 'Eş', 'ikinci');
  const { comments } = await api.planGet(secret);
  assert.deepEqual(comments.map((x) => x.body), ['merhaba', 'ikinci'], 'oldest first');
  assert.equal(await api.commentDelete(secret, c.id), true);
  assert.equal(await api.commentDelete(secret, c.id), false);
  assert.deepEqual((await api.planGet(secret)).comments.map((x) => x.body), ['ikinci']);
});

test('a comment can only be deleted with its own plan key', async () => {
  const a = await freshPlan();
  const b = await freshPlan();
  const c = await api.commentAdd(a.secret, 'general', 'Ali', 'mine');
  assert.equal(await api.commentDelete(b.secret, c.id), false);
  assert.equal((await api.planGet(a.secret)).comments.length, 1);
});

test('comment_add rejects a bad scope, a bad author and a bad body with 400', async () => {
  const { secret } = await freshPlan();
  for (const scope of ['', 'q:', 'Q:disney', 'day:123', 'other', 'q:a b']) await rejectsWith(api.commentAdd(secret, scope, 'A', 'b'), 'invalid', 400);
  for (const author of ['', '   ', 'a'.repeat(41)]) await rejectsWith(api.commentAdd(secret, 'general', author, 'b'), 'invalid', 400);
  for (const body of ['', '   ', 'b'.repeat(2001)]) await rejectsWith(api.commentAdd(secret, 'general', 'A', body), 'invalid', 400);
  const ok = await api.commentAdd(secret, 'day:3', 'a'.repeat(40), 'b'.repeat(2000));
  assert.equal(ok.body.length, 2000);
});

test('anon cannot read or write the tables directly', async () => {
  const { secret } = await freshPlan();
  await api.answerSet(secret, 'q1', 'x', 'A');
  for (const table of ['plans', 'answers', 'comments', 'plan_docs']) {
    const read = await fetch(`${target.url}/rest/v1/${table}?select=*`, { headers: { apikey: target.anonKey } });
    const rows = read.ok ? await read.json() : [];
    assert.ok(!read.ok || rows.length === 0, `${table} must not expose rows (status ${read.status})`);
    const write = await fetch(`${target.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: { apikey: target.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'evil', secret_hash: 'x', title: 'x' }),
    });
    assert.ok(write.status >= 400, `${table} must not accept writes (status ${write.status})`);
  }
});

test('internal helper functions are not exposed', async () => {
  const { secret } = await freshPlan();
  const r = await raw('_plan_id', { p_secret: secret });
  assert.ok([401, 403, 404].includes(r.status), `status ${r.status}`);
});

test('plan_ping returns ok', async () => {
  assert.equal(await api.ping(), 'ok');
});

test('the 301st distinct answer is rejected with 429, updates still work at the cap', async () => {
  const { secret } = await freshPlan();
  const ids = Array.from({ length: 300 }, (_, i) => `cap${i}`);
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map((id) => api.answerSet(secret, id, 'x', 'A')));
  }
  await rejectsWith(api.answerSet(secret, 'cap300', 'x', 'A'), 'limit', 429);
  await api.answerSet(secret, 'cap0', 'changed', 'A');
  await api.answerSet(secret, 'cap1', '', 'A');
  await api.answerSet(secret, 'cap300', 'x', 'A');
  assert.equal((await api.planGet(secret)).answers.cap300.v, 'x');
});
