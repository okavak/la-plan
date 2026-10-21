#!/usr/bin/env node
// Admin CLI for the shared plans: provisioning, key rotation, plan documents.
//
//   node tools/admin.mjs new-plan <slug> <title> [subtitle]
//   node tools/admin.mjs rotate-key <slug>
//   node tools/admin.mjs delete-plan <slug>
//   node tools/admin.mjs set-plan-doc <slug> <file.json>
//   node tools/admin.mjs sql "<statement>"
//
// Settings come from ~/.config/la-plan/env (KEY=VALUE lines, mode 600):
//   LA_PROJECT_REF, LA_SUPABASE_URL, LA_SUPABASE_ANON_KEY
// SQL runs through `supabase db query --project-ref <ref>` (Management API), so no database
// password is needed. Plan links are printed and appended to .local/urls.txt (git-ignored);
// the raw secret is never stored anywhere else, the database keeps only its sha256 hash.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SITE_URL = 'https://okavak.github.io/la-plan/';
export const ENV_PATH = join(homedir(), '.config', 'la-plan', 'env');
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const hashSecret = (secret) => createHash('sha256').update(String(secret), 'utf8').digest('hex');
export const newSecret = () => randomBytes(16).toString('base64url');
/** SQL string literal (single quotes doubled); null becomes SQL null. */
export const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
export const planUrl = (secret) => `${SITE_URL}#k=${secret}`;

function checkSlug(slug) {
  if (!SLUG.test(String(slug))) throw new Error(`bad slug: ${JSON.stringify(slug)}`);
  return slug;
}

export function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export function loadEnv(path = ENV_PATH) {
  return parseEnv(readFileSync(path, 'utf8'));
}

export function buildNewPlanSql(slug, title, subtitle, secret) {
  checkSlug(slug);
  return `insert into public.plans (slug, secret_hash, title, subtitle) values (${lit(slug)}, ${lit(hashSecret(secret))}, ${lit(title)}, ${lit(subtitle)})`;
}

export function buildRotateSql(slug, secret) {
  checkSlug(slug);
  return `update public.plans set secret_hash = ${lit(hashSecret(secret))} where slug = ${lit(slug)}`;
}

export function buildDeleteSql(slug) {
  checkSlug(slug);
  return `delete from public.plans where slug = ${lit(slug)}`;
}

export function buildSetDocSql(slug, doc) {
  checkSlug(slug);
  return `insert into public.plan_docs (plan_id, doc) select id, ${lit(JSON.stringify(doc))}::jsonb from public.plans where slug = ${lit(slug)} `
    + 'on conflict (plan_id) do update set doc = excluded.doc, updated_at = now()';
}

/** Runs SQL on the linked Supabase project through the CLI's Management API path. */
export function supabaseRunner(ref) {
  return (sql) => execFileSync('supabase', ['db', 'query', '--project-ref', ref, sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function createAdmin({ runSql }) {
  return {
    newPlan(slug, title, { subtitle = null, secret = newSecret() } = {}) {
      runSql(buildNewPlanSql(slug, title, subtitle, secret));
      return { slug, secret, url: planUrl(secret) };
    },
    rotateKey(slug) {
      const secret = newSecret();
      runSql(buildRotateSql(slug, secret));
      return { slug, secret, url: planUrl(secret) };
    },
    deletePlan(slug) {
      runSql(buildDeleteSql(slug));
    },
    setPlanDoc(slug, doc) {
      runSql(buildSetDocSql(slug, doc));
    },
    sql(statement) {
      return runSql(statement);
    },
  };
}

function saveUrl({ slug, url }) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.local');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'urls.txt'), `${slug}\t${url}\n`, { mode: 0o600 });
}

function usage() {
  console.error([
    'usage:',
    '  node tools/admin.mjs new-plan <slug> <title> [subtitle]',
    '  node tools/admin.mjs rotate-key <slug>',
    '  node tools/admin.mjs delete-plan <slug>',
    '  node tools/admin.mjs set-plan-doc <slug> <file.json>',
    '  node tools/admin.mjs sql "<statement>"',
  ].join('\n'));
  process.exit(2);
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd) usage();
  const env = loadEnv();
  if (!env.LA_PROJECT_REF) throw new Error(`LA_PROJECT_REF missing in ${ENV_PATH}`);
  const admin = createAdmin({ runSql: supabaseRunner(env.LA_PROJECT_REF) });
  switch (cmd) {
    case 'new-plan': {
      const [slug, title, subtitle] = args;
      if (!slug || !title) usage();
      const plan = admin.newPlan(slug, title, { subtitle: subtitle ?? null });
      saveUrl(plan);
      console.log(plan.url);
      break;
    }
    case 'rotate-key': {
      if (!args[0]) usage();
      const plan = admin.rotateKey(args[0]);
      saveUrl(plan);
      console.log(plan.url);
      break;
    }
    case 'delete-plan':
      if (!args[0]) usage();
      admin.deletePlan(args[0]);
      console.log(`deleted ${args[0]}`);
      break;
    case 'set-plan-doc':
      if (!args[0] || !args[1]) usage();
      admin.setPlanDoc(args[0], JSON.parse(readFileSync(args[1], 'utf8')));
      console.log(`plan document set for ${args[0]}`);
      break;
    case 'sql':
      if (!args[0]) usage();
      console.log(admin.sql(args[0]));
      break;
    default:
      usage();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
