// Tests the migration on an embedded Postgres (PGlite) with Supabase's roles and default
// privileges imitated, so the security-critical SQL is checked before it touches a real project.
// The HTTP layer (PostgREST status mapping) is covered by tests/rpc.integration.mjs.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { hashSecret } from '../tools/admin.mjs';

const MIGRATION = new URL('../supabase/migrations/20261021000000_plans.sql', import.meta.url);
const RPCS = ['plan_get(text)', 'answer_set(text, text, jsonb, text)', 'comment_add(text, text, text, text)', 'comment_delete(text, uuid)', 'plan_ping()'];
const TABLES = ['plans', 'answers', 'comments', 'plan_docs'];

let db;
let counter = 0;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

/** Runs a query the way the browser does: as the anon role. */
async function anon(sql, params) {
  await db.exec('set role anon');
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role');
  }
}

async function failure(promise) {
  try { await promise; } catch (e) { return { code: e.code, message: e.message }; }
  return null;
}

async function newPlan(title = 'Plan') {
  const secret = `secret-${++counter}-0123456789abcdef`;
  await db.query('insert into plans (slug, secret_hash, title, subtitle) values ($1, $2, $3, $4)', [`p${counter}`, hashSecret(secret), title, `${title} sub`]);
  return secret;
}

const call = async (fn, ...args) => (await anon(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const answerSet = (secret, qid, v, by = null) => anon('select answer_set($1, $2, $3::jsonb, $4) as r', [secret, qid, v === undefined ? null : JSON.stringify(v), by]);

test('row level security is on for all four tables', async () => {
  const { rows } = await db.query("select relname, relrowsecurity from pg_class where relname = any($1) and relkind = 'r'", [TABLES]);
  assert.equal(rows.length, 4);
  for (const r of rows) assert.equal(r.relrowsecurity, true, r.relname);
});

test('anon has no privileges on the tables', async () => {
  for (const t of TABLES) {
    assert.equal((await failure(anon(`select * from ${t}`)))?.code, '42501', `select ${t}`);
    assert.equal((await failure(anon(`delete from ${t}`)))?.code, '42501', `delete ${t}`);
  }
  assert.equal((await failure(anon("insert into plans (slug, secret_hash, title) values ('evil', 'x', 'x')")))?.code, '42501');
});

test('anon can execute exactly the five RPC functions, not the helper', async () => {
  for (const fn of RPCS) {
    const { rows } = await db.query("select has_function_privilege('anon', $1, 'execute') as ok", [`public.${fn}`]);
    assert.equal(rows[0].ok, true, fn);
  }
  assert.equal((await failure(anon("select _plan_id('x')")))?.code, '42501');
  const { rows } = await db.query("select has_function_privilege('anon', 'public._plan_id(text)', 'execute') as ok");
  assert.equal(rows[0].ok, false);
});

test('plan_get returns null for an unknown key and the whole state for a known one', async () => {
  assert.equal(await call('plan_get', 'nope'), null);
  assert.equal(await call('plan_get', ''), null);
  const secret = await newPlan('Plan A');
  const s = await call('plan_get', secret);
  assert.equal(s.meta.title, 'Plan A');
  assert.equal(s.meta.subtitle, 'Plan A sub');
  assert.deepEqual(s.answers, {});
  assert.deepEqual(s.comments, []);
  assert.equal(s.plan, null);
  assert.ok(Number.isFinite(Date.parse(s.now)));
});

test('plan_get merges plans.meta into meta and returns the plan document', async () => {
  const secret = await newPlan();
  await db.query("update plans set meta = '{\"lede\": \"Merhaba\"}'::jsonb where secret_hash = $1", [hashSecret(secret)]);
  await db.query("insert into plan_docs (plan_id, doc) select id, '{\"days\": [1, 2]}'::jsonb from plans where secret_hash = $1", [hashSecret(secret)]);
  const s = await call('plan_get', secret);
  assert.equal(s.meta.lede, 'Merhaba');
  assert.equal(s.meta.title, 'Plan');
  assert.deepEqual(s.plan, { days: [1, 2] });
});

test('answer_set upserts, trims the name and returns a timestamp', async () => {
  const secret = await newPlan();
  const at = (await answerSet(secret, 'disney', 'two', 'Ali')).rows[0].r;
  assert.ok(Number.isFinite(Date.parse(at)));
  await answerSet(secret, 'disney', 'dl1', '  Eş  ');
  await answerSet(secret, 'daytrip', ['catalina', 'snow'], 'Ali');
  await answerSet(secret, 'allergy', 'fındık <b>', null);
  const { answers } = await call('plan_get', secret);
  assert.deepEqual(Object.keys(answers).sort(), ['allergy', 'daytrip', 'disney']);
  assert.equal(answers.disney.v, 'dl1');
  assert.equal(answers.disney.by, 'Eş');
  assert.deepEqual(answers.daytrip.v, ['catalina', 'snow']);
  assert.equal(answers.allergy.by, null);
});

test("answer_set with '', [], json null and sql null clears the answer", async () => {
  const secret = await newPlan();
  for (const empty of ['', [], null, undefined]) {
    await answerSet(secret, 'q1', 'x', 'A');
    assert.equal((await call('plan_get', secret)).answers.q1.v, 'x');
    await answerSet(secret, 'q1', empty, 'A');
    assert.equal((await call('plan_get', secret)).answers.q1, undefined, `cleared by ${JSON.stringify(empty)}`);
  }
});

test('answer_set errors carry the contract SQLSTATEs', async () => {
  const secret = await newPlan();
  assert.equal((await failure(answerSet('wrong', 'q1', 'x', 'A')))?.code, 'PT401');
  for (const bad of ['Bad Id', '', '-x', 'a/b', 'x'.repeat(65)]) assert.equal((await failure(answerSet(secret, bad, 'x', 'A')))?.code, 'PT400', bad);
  assert.equal((await failure(answerSet(secret, 'q1', 'x', 'n'.repeat(41))))?.code, 'PT400');
  await answerSet(secret, 'q1', 'x', 'n'.repeat(40));
  await answerSet(secret, 'q2', 'x'.repeat(4094), 'A'); // JSON text is exactly 4096 bytes
  assert.equal((await failure(answerSet(secret, 'q3', 'x'.repeat(4095), 'A')))?.code, 'PT413');
});

test('a plan holds at most 300 answers; updates and clears still work at the cap', async () => {
  const secret = await newPlan();
  await db.query("insert into answers (plan_id, qid, v) select p.id, 'cap' || g, '\"x\"'::jsonb from plans p, generate_series(0, 299) g where p.secret_hash = $1", [hashSecret(secret)]);
  assert.equal((await failure(answerSet(secret, 'cap300', 'x', 'A')))?.code, 'PT429');
  await answerSet(secret, 'cap0', 'changed', 'A');
  await answerSet(secret, 'cap1', '', 'A');
  await answerSet(secret, 'cap300', 'x', 'A');
  assert.equal((await call('plan_get', secret)).answers.cap300.v, 'x');
});

test('comment_add trims, validates and caps; comment_delete only touches its own plan', async () => {
  const a = await newPlan();
  const b = await newPlan();
  const c = await call('comment_add', a, 'q:disney', '  Ali ', '  merhaba  ');
  assert.equal(c.author, 'Ali');
  assert.equal(c.body, 'merhaba');
  assert.match(c.id, /^[0-9a-f-]{36}$/);
  await call('comment_add', a, 'general', 'Eş', 'ikinci');
  assert.deepEqual((await call('plan_get', a)).comments.map((x) => x.body), ['merhaba', 'ikinci']);

  for (const scope of ['', 'q:', 'Q:disney', 'day:123', 'other', 'q:a b']) assert.equal((await failure(call('comment_add', a, scope, 'A', 'b')))?.code, 'PT400', scope);
  for (const author of ['', '   ', 'a'.repeat(41)]) assert.equal((await failure(call('comment_add', a, 'general', author, 'b')))?.code, 'PT400');
  for (const body of ['', '   ', 'b'.repeat(2001)]) assert.equal((await failure(call('comment_add', a, 'general', 'A', body)))?.code, 'PT400');
  assert.equal((await failure(call('comment_add', 'wrong', 'general', 'A', 'b')))?.code, 'PT401');

  assert.equal(await call('comment_delete', b, c.id), false);
  assert.equal((await failure(call('comment_delete', 'wrong', c.id)))?.code, 'PT401');
  assert.equal(await call('comment_delete', a, c.id), true);
  assert.equal(await call('comment_delete', a, c.id), false);

  await db.query("insert into comments (plan_id, scope, author, body) select p.id, 'general', 'A', 'x' from plans p, generate_series(1, 2000) where p.secret_hash = $1", [hashSecret(b)]);
  assert.equal((await failure(call('comment_add', b, 'general', 'A', 'one too many')))?.code, 'PT429');
});

test('one plan never sees the other plan\'s answers or comments', async () => {
  const a = await newPlan('A');
  const b = await newPlan('B');
  await answerSet(b, 'disney', 'dl1', 'Bee');
  await call('comment_add', b, 'general', 'Bee', 'only B');
  const s = await call('plan_get', a);
  assert.deepEqual(s.answers, {});
  assert.deepEqual(s.comments, []);
});

test('plan_ping answers ok', async () => {
  assert.equal(await call('plan_ping'), 'ok');
});

test('plans reject bad slugs and deleting a plan removes everything under it', async () => {
  assert.equal((await failure(db.query("insert into plans (slug, secret_hash, title) values ('Bad Slug', 'h', 't')")))?.code, '23514');
  const secret = await newPlan();
  await answerSet(secret, 'q1', 'x', 'A');
  await call('comment_add', secret, 'general', 'A', 'b');
  await db.query("insert into plan_docs (plan_id, doc) select id, '{}'::jsonb from plans where secret_hash = $1", [hashSecret(secret)]);
  await db.query('delete from plans where secret_hash = $1', [hashSecret(secret)]);
  assert.equal(await call('plan_get', secret), null);
  for (const t of ['answers', 'comments', 'plan_docs']) {
    const { rows } = await db.query(`select count(*)::int as n from ${t} where plan_id not in (select id from plans)`);
    assert.equal(rows[0].n, 0, t);
  }
});
