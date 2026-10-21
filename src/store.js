// Pure state logic for the shared plan page: no DOM, no network.

export const FULL_DAYS = 7;
export const LAST_KEY = 'la-plan:v1:lastKey';

const KEY_BODY = /^[A-Za-z0-9_-]{22,64}$/;
const HASH_KEY = /^#?k=([A-Za-z0-9_-]{22,64})$/;

/** '#k=<secret>' -> secret, or null when the hash is not a plan link. */
export function parseKey(hash) {
  const m = HASH_KEY.exec(String(hash ?? ''));
  return m ? m[1] : null;
}

/** A valid hash key wins; otherwise the key remembered on this device; otherwise none. */
export function resolveKey(hash, storage) {
  const fromHash = parseKey(hash);
  if (fromHash) return { key: fromHash, source: 'hash' };
  let stored = null;
  try { stored = storage.getItem(LAST_KEY); } catch { /* storage blocked */ }
  if (stored && KEY_BODY.test(stored)) return { key: stored, source: 'storage' };
  return { key: null, source: null };
}

/** Called only after the server accepted the key, so a bad link never replaces a good one. */
export function rememberKey(storage, key) {
  try { storage.setItem(LAST_KEY, key); } catch { /* storage blocked: the link itself still works */ }
}

export function isEmptyValue(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** New value after tapping an option; undefined means the answer is cleared. */
export function toggleValue(type, current, optionId) {
  if (type === 'radio') return current === optionId ? undefined : optionId;
  const list = Array.isArray(current) ? current.slice() : [];
  const i = list.indexOf(optionId);
  if (i >= 0) list.splice(i, 1); else list.push(optionId);
  return list.length ? list : undefined;
}

/**
 * Merge a poll result into the local answers.
 * Per question: a pending local write wins; else a write acked at or after the poll started
 * wins over the (possibly stale) server value; else the server value, absent meaning removed.
 */
export function reconcile({ server, local, pending, ackedAt, startedAt }) {
  const out = {};
  const keys = new Set([...Object.keys(server), ...Object.keys(local), ...Object.keys(pending)]);
  for (const qid of keys) {
    let v;
    if (qid in pending) v = pending[qid];
    else if ((ackedAt[qid] ?? -Infinity) >= startedAt) v = local[qid];
    else v = server[qid];
    if (!isEmptyValue(v)) out[qid] = v;
  }
  return out;
}

function isAnswered(q, answers) {
  const v = answers[q.id];
  if (q.type === 'check') return Array.isArray(v) && v.length > 0;
  return v != null && String(v).trim() !== '';
}

function selectedIds(q, v) {
  if (q.type === 'check') return Array.isArray(v) ? v : [];
  return v ? [v] : [];
}

/** Progress, workload and the answer list, as shown in the bar and the summary section. */
export function computeSummary(sections, answers) {
  let done = 0, total = 0, days = 0, eves = 0, usd = 0;
  const sectionDone = {};
  const items = [];
  for (const s of sections) {
    sectionDone[s.id] = s.questions.every((q) => isAnswered(q, answers));
    for (const q of s.questions) {
      total++;
      if (isAnswered(q, answers)) done++;
      const v = answers[q.id];
      let text = '';
      if (q.type === 'radio' || q.type === 'check') {
        const byId = new Map(q.options.map((o) => [o.id, o]));
        for (const id of selectedIds(q, v)) {
          const o = byId.get(id);
          if (!o) continue;
          if (typeof o.w === 'number') days += o.w;
          if (o.eve) eves++;
          if (typeof o.usd === 'number') usd += o.usd;
        }
        text = selectedIds(q, v).map((id) => byId.get(id)?.title ?? '').filter(Boolean).join(' · ');
      } else {
        text = v ? String(v) + (q.type === 'number' ? ' cm' : '') : '';
      }
      if (q.text && answers[q.text.id]) text += (text ? ' · ' : '') + answers[q.text.id];
      items.push({ qid: q.id, title: q.title, text });
    }
  }
  return { done, total, days, eves, usd, over: days > FULL_DAYS, sectionDone, items };
}

/** scope -> comments, oldest first (stable for equal timestamps). */
export function groupComments(comments) {
  const sorted = [...comments].sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) || 0);
  const map = new Map();
  for (const c of sorted) {
    if (!map.has(c.scope)) map.set(c.scope, []);
    map.get(c.scope).push(c);
  }
  return map;
}
