#!/usr/bin/env node
// In-memory stand-in for the five Supabase RPCs, so the page and the end-to-end tests can run offline.
// It follows the backend contract in docs/superpowers/plans/2026-10-21-la-plan.md; the same integration
// tests run against it and against the real project.
//
//   node tools/fake-backend.mjs [port]            (default 8787)
//   POST /__admin/new-plan     {slug, title, subtitle?, secret?} -> {secret}
//   POST /__admin/delete-plan  {slug}
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const QID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SCOPE = /^(general|q:[a-z0-9][a-z0-9_-]{0,63}|day:[0-9]{1,2})$/;
const MAX_ANSWERS = 300;
const MAX_COMMENTS = 2000;

const sha = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function startFakeBackend({ port = 0 } = {}) {
  const plans = new Map(); // secret hash -> plan

  function planFor(secret) {
    const p = plans.get(sha(secret));
    if (!p) throw new HttpError(401, 'invalid_key');
    return p;
  }

  const rpc = {
    plan_get({ p_secret }) {
      const p = plans.get(sha(p_secret));
      if (!p) return null;
      return {
        meta: { title: p.title, subtitle: p.subtitle, ...p.meta },
        answers: Object.fromEntries(p.answers),
        comments: p.comments.map((c) => ({ ...c })),
        plan: p.doc,
        now: new Date().toISOString(),
      };
    },
    answer_set({ p_secret, p_qid, p_v, p_by }) {
      const p = planFor(p_secret);
      if (typeof p_qid !== 'string' || !QID.test(p_qid)) throw new HttpError(400, 'invalid_argument');
      if (p_by != null && String(p_by).length > 40) throw new HttpError(400, 'invalid_argument');
      if (Buffer.byteLength(JSON.stringify(p_v ?? null), 'utf8') > 4096) throw new HttpError(413, 'too_large');
      const at = new Date().toISOString();
      if (isEmpty(p_v)) {
        p.answers.delete(p_qid);
        return at;
      }
      if (!p.answers.has(p_qid) && p.answers.size >= MAX_ANSWERS) throw new HttpError(429, 'limit');
      p.answers.set(p_qid, { v: p_v, by: p_by == null ? null : (String(p_by).trim() || null), at });
      return at;
    },
    comment_add({ p_secret, p_scope, p_author, p_body }) {
      const p = planFor(p_secret);
      const author = String(p_author ?? '').trim();
      const body = String(p_body ?? '').trim();
      if (typeof p_scope !== 'string' || !SCOPE.test(p_scope)) throw new HttpError(400, 'invalid_argument');
      if (author.length < 1 || author.length > 40) throw new HttpError(400, 'invalid_argument');
      if (body.length < 1 || body.length > 2000) throw new HttpError(400, 'invalid_argument');
      if (p.comments.length >= MAX_COMMENTS) throw new HttpError(429, 'limit');
      const c = { id: randomUUID(), scope: p_scope, author, body, at: new Date().toISOString() };
      p.comments.push(c);
      return { ...c };
    },
    comment_delete({ p_secret, p_id }) {
      const p = planFor(p_secret);
      const i = p.comments.findIndex((c) => c.id === p_id);
      if (i < 0) return false;
      p.comments.splice(i, 1);
      return true;
    },
    plan_ping() {
      return 'ok';
    },
  };

  const admin = {
    'new-plan'({ slug, title, subtitle = null, secret }) {
      const key = secret || randomBytes(16).toString('base64url');
      plans.set(sha(key), { slug, title, subtitle, meta: {}, answers: new Map(), comments: [], doc: null });
      return { secret: key };
    },
    'delete-plan'({ slug }) {
      for (const [h, p] of plans) if (p.slug === slug) plans.delete(h);
      return { ok: true };
    },
  };

  const server = createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'apikey, content-type, authorization, x-client-info',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    };
    const send = (status, body) => {
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'bad json'); }
        const adminMatch = /^\/__admin\/([a-z-]+)$/.exec(url.pathname);
        if (adminMatch && admin[adminMatch[1]]) { send(200, admin[adminMatch[1]](body)); return; }
        const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
        if (req.method !== 'POST' || !m || !rpc[m[1]]) throw new HttpError(404, 'not found');
        if (!req.headers.apikey) throw new HttpError(401, 'No API key found in request');
        send(200, rpc[m[1]](body));
      } catch (e) {
        send(e instanceof HttpError ? e.status : 500, { message: e.message });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        async newPlan(slug, title, subtitle, secret) {
          return admin['new-plan']({ slug, title, subtitle, secret }).secret;
        },
        async deletePlan(slug) {
          admin['delete-plan']({ slug });
        },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startFakeBackend({ port: Number(process.argv[2]) || 8787 });
  console.log(`fake backend listening on ${url}`);
}
