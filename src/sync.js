// Optimistic shared state: local-first answers, a per-question write queue,
// polling, and persistence of unsent writes. No DOM; `api` and `timers` are injected.

import { reconcile, isEmptyValue } from './store.js';
import { errorText } from './api.js';

const BACKOFF_START = 2000;
const BACKOFF_MAX = 30000;

function hash36(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

/**
 * secret === null means local-only mode: nothing ever touches the network.
 * `canPoll` lets the page pause polling while the tab is hidden.
 */
export function createSync({
  api, secret, storage, now = () => Date.now(), pollMs = 5000,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
  canPoll = () => true,
}) {
  const ns = secret ? `k${hash36(secret)}` : 'local';
  const PENDING_KEY = `la-plan:v1:${ns}:pending`;
  const CACHE_KEY = `la-plan:v1:${ns}:cache`;

  const pending = {}; // qid -> { v, by, seq }; v === '' means a pending clear
  const inflight = new Set();
  const ackedAt = {};
  const subs = new Set();
  let seq = 0;
  let backoff = BACKOFF_START;
  let pollTimer = null;
  let retryTimer = null;
  let running = false;
  let refreshing = null;

  let state = {
    status: secret ? 'connecting' : 'local',
    meta: {}, answers: {}, info: {}, comments: [], plan: null,
    lastSyncAt: null, pendingCount: 0, error: null,
  };

  function notify() {
    for (const fn of [...subs]) {
      try { fn(state); } catch (e) { console.error(e); }
    }
  }
  function update(patch) {
    state = { ...state, ...patch };
    notify();
  }
  const pendingCount = () => Object.keys(pending).length;
  const persistPending = () => writeJson(storage, PENDING_KEY, pending);
  const persistCache = () => writeJson(storage, CACHE_KEY, {
    answers: state.answers, info: state.info, meta: state.meta, comments: state.comments, plan: state.plan,
  });

  function start() {
    if (running) return;
    running = true;
    const cache = readJson(storage, CACHE_KEY, {});
    const answers = { ...(cache.answers ?? {}) };
    if (secret) {
      const saved = readJson(storage, PENDING_KEY, {});
      for (const [qid, p] of Object.entries(saved)) {
        if (p && typeof p === 'object' && 'v' in p) pending[qid] = { v: p.v, by: p.by ?? null, seq: ++seq };
      }
      for (const [qid, p] of Object.entries(pending)) {
        if (isEmptyValue(p.v)) delete answers[qid]; else answers[qid] = p.v;
      }
    }
    update({
      answers, info: cache.info ?? {}, meta: cache.meta ?? {}, comments: cache.comments ?? [],
      plan: cache.plan ?? null, pendingCount: pendingCount(),
    });
    if (!secret) return;
    flush();
    refresh().then(schedulePoll);
  }

  function stop() {
    running = false;
    if (pollTimer != null) timers.clear(pollTimer);
    if (retryTimer != null) timers.clear(retryTimer);
    pollTimer = null;
    retryTimer = null;
  }

  async function pollOnce() {
    pollTimer = null;
    if (canPoll()) await refresh();
    schedulePoll();
  }

  function schedulePoll() {
    if (!running || state.status === 'invalid' || pollTimer != null) return;
    pollTimer = timers.set(pollOnce, pollMs);
  }

  function refresh() {
    if (!secret || state.status === 'invalid') return Promise.resolve();
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function doRefresh() {
    const startedAt = now();
    let res;
    try {
      res = await api.planGet(secret);
    } catch (e) {
      update(e?.code === 'invalid_key' ? { status: 'invalid', error: null } : { status: 'offline' });
      return;
    }
    if (res === null) {
      update({ status: 'invalid', error: null });
      return;
    }
    const serverAnswers = {};
    const serverInfo = {};
    for (const [qid, a] of Object.entries(res.answers ?? {})) {
      serverAnswers[qid] = a.v;
      serverInfo[qid] = { by: a.by ?? null, at: a.at };
    }
    const pendingValues = Object.fromEntries(Object.entries(pending).map(([k, p]) => [k, p.v]));
    const answers = reconcile({ server: serverAnswers, local: state.answers, pending: pendingValues, ackedAt, startedAt });
    const info = {};
    for (const qid of Object.keys(answers)) {
      const keepLocal = qid in pending || (ackedAt[qid] ?? -Infinity) >= startedAt;
      const i = keepLocal ? (state.info[qid] ?? serverInfo[qid]) : serverInfo[qid];
      if (i) info[qid] = i;
    }
    update({
      status: 'live', meta: res.meta ?? {}, answers, info, comments: res.comments ?? [],
      plan: res.plan ?? null, lastSyncAt: now(), error: null,
    });
    persistCache();
  }

  function setAnswer(qid, value, by) {
    const v = isEmptyValue(value) ? '' : value;
    const answers = { ...state.answers };
    const info = { ...state.info };
    if (v === '') {
      delete answers[qid];
      delete info[qid];
    } else {
      answers[qid] = v;
      info[qid] = { by: by ?? null, at: new Date(now()).toISOString() };
    }
    if (!secret) {
      update({ answers, info, error: null });
      persistCache();
      return;
    }
    pending[qid] = { v, by: by ?? null, seq: ++seq };
    update({ answers, info, pendingCount: pendingCount(), error: null });
    persistPending();
    persistCache();
    send(qid);
  }

  function flush() {
    for (const qid of Object.keys(pending)) send(qid);
  }

  async function send(qid) {
    const p = pending[qid];
    if (!p || inflight.has(qid)) return;
    inflight.add(qid);
    let offline = false;
    try {
      const at = await api.answerSet(secret, qid, p.v, p.by);
      ackedAt[qid] = now();
      const current = pending[qid] && pending[qid].seq === p.seq;
      if (current) delete pending[qid];
      backoff = BACKOFF_START;
      const info = { ...state.info };
      if (current && !isEmptyValue(p.v)) info[qid] = { by: p.by, at };
      persistPending();
      update({ info, pendingCount: pendingCount(), status: state.status === 'offline' ? 'live' : state.status });
      persistCache();
    } catch (e) {
      if (e?.code === 'network' || e?.code === 'server') {
        offline = true;
        update({ status: 'offline' });
        scheduleRetry();
      } else {
        if (pending[qid] && pending[qid].seq === p.seq) delete pending[qid];
        persistPending();
        update({ error: errorText(e), pendingCount: pendingCount() });
      }
    } finally {
      inflight.delete(qid);
    }
    // a newer value for this question arrived while the write was in flight
    if (!offline && pending[qid]) send(qid);
  }

  function scheduleRetry() {
    if (retryTimer != null) return;
    retryTimer = timers.set(() => {
      retryTimer = null;
      flush();
    }, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }

  async function addComment(scope, author, body) {
    if (!secret) throw new Error('Yorumlar için paylaşımlı bir plan linki gerekir');
    const c = await api.commentAdd(secret, scope, author, body);
    update({ comments: [...state.comments.filter((x) => x.id !== c.id), c] });
    persistCache();
  }

  async function removeComment(id) {
    if (!secret) return;
    await api.commentDelete(secret, id);
    update({ comments: state.comments.filter((c) => c.id !== id) });
    persistCache();
  }

  return {
    start, stop, refresh, setAnswer, addComment, removeComment,
    getState: () => state,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
}
