// Names, comment threads and "who changed this" lines.
// The first half is pure and unit-tested; the second half is DOM wiring.

import { esc } from './render.js';
import { errorText } from './api.js';
import { groupComments } from './store.js';

export const NAME_KEY = 'la-plan:v1:name';
const NAME_MAX = 40;

// ---------- pure ----------

/** 'şimdi', 'N dk önce', 'N sa önce', 'dün', or '12 Eki 14:05'. Unparseable input gives ''. */
export function formatWhen(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = nowMs - t;
  if (diff < 60_000) return 'şimdi';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours} sa önce`;
  if (hours < 48) return 'dün';
  return new Date(t).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Comment list HTML; the delete button only appears on the viewer's own comments. */
export function renderThread(comments, me, nowMs = Date.now()) {
  return comments.map((c) => {
    const del = me && c.author === me ? `<button type="button" class="cmt-del" data-del="${esc(c.id)}">Sil</button>` : '';
    return `<div class="cmt" data-id="${esc(c.id)}"><div class="cmt-head"><b>${esc(c.author)}</b><span>${esc(formatWhen(c.at, nowMs))}</span>${del}</div><div class="cmt-body">${esc(c.body)}</div></div>`;
  }).join('');
}

/** The stored name, else whatever `ask()` returns (trimmed, at most 40 chars); null when nothing usable. */
export async function ensureName(storage, ask) {
  let stored = null;
  try { stored = storage.getItem(NAME_KEY); } catch { /* storage blocked */ }
  if (stored && stored.trim()) return stored.trim().slice(0, NAME_MAX);
  const name = String((await ask()) ?? '').trim().slice(0, NAME_MAX);
  if (!name) return null;
  try { storage.setItem(NAME_KEY, name); } catch { /* storage blocked: asked again next time */ }
  return name;
}

export async function postComment({ sync, scope, author, body }) {
  const text = String(body ?? '').trim();
  if (!text) return { ok: false, error: 'Boş yorum gönderilmez.' };
  try {
    await sync.addComment(scope, author, text);
    return { ok: true };
  } catch (e) {
    const base = errorText(e);
    return { ok: false, error: e?.code === 'network' ? `${base} Metniniz duruyor, tekrar deneyin.` : base };
  }
}

/** Posts the textarea's text; the draft is cleared only when the server accepted it. */
export async function submitFromTextarea({ textarea, sync, scope, author }) {
  const r = await postComment({ sync, scope, author, body: textarea.value });
  if (r.ok) textarea.value = '';
  return r;
}

// ---------- DOM wiring ----------

let openNameDialog = null;

/**
 * Modal asking for a name; resolves with the typed text, or null when dismissed.
 * One dialog at a time: opening it moves focus, which can make other code ask again before the
 * first call has returned, so the pending promise is stored before anything touches the DOM.
 */
export function askNameDialog(initial = '') {
  if (openNameDialog) return openNameDialog;
  let resolveName;
  openNameDialog = new Promise((resolve) => { resolveName = resolve; });

  const dlg = document.createElement('dialog');
  dlg.className = 'name';
  dlg.innerHTML = '<form><h3>Adınız nedir?</h3><p class="muted">Yorumlarda ve değişikliklerde bu isim görünür.</p>'
    + `<input name="n" maxlength="${NAME_MAX}" autocomplete="given-name" aria-label="Adınız" required>`
    + '<div class="row"><button type="submit" class="cmt-send">Devam</button></div></form>';
  const input = dlg.querySelector('input');
  input.value = initial;
  let settled = false;
  const done = (value) => {
    if (settled) return;
    settled = true;
    openNameDialog = null;
    dlg.close();
    dlg.remove();
    resolveName(value);
  };
  dlg.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); done(input.value); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) done(null); });
  const pending = openNameDialog;
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
  return pending;
}

/** "Son değiştiren: Ali · 5 dk önce" under each answered question (shared plans only). */
export function paintMeta(root, state, nowMs = Date.now()) {
  for (const el of root.querySelectorAll('.qmeta[data-qmeta]')) {
    const i = state.status === 'local' ? null : state.info[el.dataset.qmeta];
    el.textContent = i ? `Son değiştiren: ${i.by || 'biri'} · ${formatWhen(i.at, nowMs)}` : '';
  }
}

/**
 * Comment buttons under every question plus the general notes box.
 * Returns { render(state) } to call on every state change.
 */
export function mountThreads({ root, notes, sync, storage, askName }) {
  const threads = new Map(); // scope -> { box, list, textarea, err, send }

  const me = () => {
    try { return (storage.getItem(NAME_KEY) || '').trim(); } catch { return ''; }
  };

  function build(scope, box) {
    box.innerHTML = '<div class="cmt-list"></div><form class="cmt-form">'
      + '<textarea maxlength="2000" rows="2" placeholder="Yorumunuzu yazın…" aria-label="Yorum"></textarea>'
      + '<p class="cmt-err" role="alert" hidden></p>'
      + '<div class="row"><span class="muted">Ctrl+Enter ile gönderin</span><button type="submit" class="cmt-send">Gönder</button></div></form>';
    const t = {
      box,
      list: box.querySelector('.cmt-list'),
      textarea: box.querySelector('textarea'),
      err: box.querySelector('.cmt-err'),
      send: box.querySelector('.cmt-send'),
    };
    const form = box.querySelector('form');
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(scope, t); });
    t.textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
    });
    threads.set(scope, t);
    return t;
  }

  async function submit(scope, t) {
    const author = await ensureName(storage, askName);
    if (!author) return; // dialog dismissed: the draft stays
    t.send.disabled = true;
    const r = await submitFromTextarea({ textarea: t.textarea, sync, scope, author });
    t.send.disabled = false;
    t.err.hidden = r.ok;
    t.err.textContent = r.ok ? '' : r.error;
  }

  function toggle(btn) {
    const scope = btn.dataset.comments;
    const qfoot = btn.closest('.qfoot');
    let box = qfoot.nextElementSibling;
    if (!box || !box.matches('.thread')) {
      box = document.createElement('div');
      box.className = 'thread';
      box.hidden = true;
      qfoot.after(box);
      build(scope, box);
    }
    box.hidden = !box.hidden;
    btn.setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) {
      render(sync.getState());
      threads.get(scope).textarea.focus();
    }
  }

  async function remove(del) {
    const t = [...threads.values()].find((x) => x.box.contains(del));
    try {
      await sync.removeComment(del.dataset.del);
    } catch (e) {
      if (t) { t.err.hidden = false; t.err.textContent = errorText(e); }
    }
  }

  function onClick(e) {
    const btn = e.target.closest('.cbtn');
    if (btn) { toggle(btn); return; }
    const del = e.target.closest('.cmt-del');
    if (del) remove(del);
  }
  root.addEventListener('click', onClick);
  notes.addEventListener('click', onClick);

  const notesBox = notes.querySelector('.thread[data-thread="general"]');
  if (notesBox) build('general', notesBox);

  function render(state) {
    const byScope = groupComments(state.comments);
    for (const cnt of root.querySelectorAll('.cnt[data-count]')) {
      const n = (byScope.get(cnt.dataset.count) || []).length;
      cnt.textContent = n ? String(n) : '';
    }
    const who = me();
    const now = Date.now();
    for (const [scope, t] of threads) t.list.innerHTML = renderThread(byScope.get(scope) || [], who, now);
  }

  return { render };
}
