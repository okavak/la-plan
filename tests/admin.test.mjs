import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashSecret, newSecret, lit, planUrl, parseEnv, supabaseQueryArgs, buildKeepaliveSql,
  buildNewPlanSql, buildRotateSql, buildDeleteSql, buildSetDocSql,
} from '../tools/admin.mjs';

test('hashSecret is the hex sha256 of the utf8 secret', () => {
  assert.equal(hashSecret('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('newSecret returns 22 url-safe characters and never repeats', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const s = newSecret();
    assert.match(s, /^[A-Za-z0-9_-]{22}$/);
    seen.add(s);
  }
  assert.equal(seen.size, 50);
});

test('lit doubles single quotes and keeps everything else', () => {
  assert.equal(lit("Ali's plan"), "'Ali''s plan'");
  assert.equal(lit("x'; drop table plans; --"), "'x''; drop table plans; --'");
  assert.equal(lit('Şehir · A–B günü'), "'Şehir · A–B günü'");
  assert.equal(lit(null), 'null');
});

test('planUrl puts the secret in the fragment', () => {
  assert.equal(planUrl('SECRET'), 'https://okavak.github.io/la-plan/#k=SECRET');
});

test('buildNewPlanSql stores only the hash and escapes title and subtitle', () => {
  const sql = buildNewPlanSql('plan-a', "Ali's plan", "Şehir · A–B günü", 'SECRET-VALUE-0123456789');
  assert.ok(sql.includes(hashSecret('SECRET-VALUE-0123456789')));
  assert.ok(!sql.includes('SECRET-VALUE-0123456789'), 'the raw secret must never reach the database');
  assert.ok(sql.includes("'Ali''s plan'"));
  assert.match(sql, /insert into public\.plans/);
  assert.ok(buildNewPlanSql('plan-a', 'T', null, 'S').includes('null'));
});

test('slugs are validated before any SQL is built', () => {
  for (const bad of ['', 'Plan-A', "a'b", 'a b', '-x', 'x'.repeat(65)]) {
    assert.throws(() => buildNewPlanSql(bad, 'T', null, 'S'), /slug/, bad);
    assert.throws(() => buildDeleteSql(bad), /slug/, bad);
    assert.throws(() => buildRotateSql(bad, 'S'), /slug/, bad);
  }
});

test('buildRotateSql and buildDeleteSql target one slug', () => {
  const rotate = buildRotateSql('plan-a', 'NEWSECRET');
  assert.ok(rotate.includes(hashSecret('NEWSECRET')));
  assert.match(rotate, /update public\.plans set secret_hash = '[0-9a-f]{64}' where slug = 'plan-a'/);
  assert.equal(buildDeleteSql('plan-a'), "delete from public.plans where slug = 'plan-a'");
});

test('buildSetDocSql embeds the json as an escaped literal', () => {
  const sql = buildSetDocSql('plan-a', { title: "Gün 1: O'Hare" });
  assert.ok(sql.includes("O''Hare"));
  assert.match(sql, /::jsonb/);
  assert.match(sql, /on conflict \(plan_id\) do update/);
});

test('buildKeepaliveSql schedules a weekly self-call of plan_ping and replaces an older job', () => {
  const sql = buildKeepaliveSql({ ref: 'abcdefghijklmnopqrst', anonKey: 'sb_publishable_AbC-123_x' });
  assert.match(sql, /create extension if not exists pg_cron/);
  assert.match(sql, /create extension if not exists pg_net/);
  assert.match(sql, /cron\.unschedule\('la-plan-keepalive'\)/);
  assert.match(sql, /cron\.schedule\('la-plan-keepalive', '0 6 \* \* 1'/);
  assert.ok(sql.includes('https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/plan_ping'));
  assert.ok(sql.includes("'apikey', 'sb_publishable_AbC-123_x'"));
  assert.match(buildKeepaliveSql({ ref: 'abcdefghijklmnopqrst', anonKey: 'k', schedule: '* * * * *' }), /cron\.schedule\('la-plan-keepalive', '\* \* \* \* \*'/);
});

test('buildKeepaliveSql refuses input that could break out of the SQL', () => {
  for (const ref of ['', 'short', 'abcdefghijklmnopqrst; drop table plans', "abcdefghijklmnopqrs'"]) {
    assert.throws(() => buildKeepaliveSql({ ref, anonKey: 'k' }), /ref/, ref);
  }
  for (const anonKey of ['', "k'; drop table plans; --", 'a b', '$job$']) {
    assert.throws(() => buildKeepaliveSql({ ref: 'abcdefghijklmnopqrst', anonKey }), /key/, anonKey);
  }
  for (const schedule of ["0 6 * * 1'; drop", '', 'weekly']) {
    assert.throws(() => buildKeepaliveSql({ ref: 'abcdefghijklmnopqrst', anonKey: 'k', schedule }), /schedule/, schedule);
  }
});

test('supabaseQueryArgs targets the project through --linked, as the CLI requires', () => {
  assert.deepEqual(supabaseQueryArgs('abc123', 'select 1'), ['db', 'query', '--linked', '--project-ref', 'abc123', 'select 1']);
  assert.deepEqual(supabaseQueryArgs('abc123', "select 'x'"), ['db', 'query', '--linked', '--project-ref', 'abc123', "select 'x'"], 'the SQL is one argument, never split or quoted');
});

test('parseEnv reads KEY=VALUE lines and skips comments and blanks', () => {
  const env = parseEnv('# comment\n\nLA_PROJECT_REF=abc123\nLA_SUPABASE_URL = https://abc123.supabase.co \nBAD LINE\n');
  assert.deepEqual(env, { LA_PROJECT_REF: 'abc123', LA_SUPABASE_URL: 'https://abc123.supabase.co' });
});
