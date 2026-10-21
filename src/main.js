// Wiring only: loads the catalog, renders it, and connects clicks to the sync engine.
// All logic worth testing lives in store.js, sync.js and render.js.

import { resolveKey, rememberKey, parseKey, toggleValue, computeSummary, FULL_DAYS } from './store.js';
import { createApi } from './api.js';
import { createSync } from './sync.js';
import { renderSections, renderJump, renderCredits, renderSummaryItems, esc } from './render.js';
import { ensureName, askNameDialog, mountThreads, paintMeta, NAME_KEY } from './comments.js';
import { createDrafts, fieldLabel } from './drafts.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  connecting: 'Bağlanıyor…',
  live: 'Kaydediliyor · herkesle paylaşılıyor',
  offline: 'Bağlantı yok · değişiklikleriniz saklanıyor',
  invalid: 'Bağlantı geçersiz',
  local: 'Bu cihazda kaydediliyor · paylaşımlı değil',
};

const BANNERS = {
  invalid: '<b>Bu bağlantı geçersiz ya da yenilenmiş.</b> Size gönderilen linki yeniden açın; sorun sürerse linki gönderen kişiden yenisini isteyin.',
  local: '<b>Bu sayfa bir plan linki olmadan açıldı.</b> Seçimleriniz yalnızca bu cihazda kalır, başkalarıyla paylaşılmaz.',
};

function currentName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

async function main() {
  const data = await (await fetch('assets/data.json')).json();
  const questions = data.sections.flatMap((s) => s.questions);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const root = $('root');

  root.innerHTML = renderSections(data);
  $('jump').innerHTML = renderJump(data);
  $('credits').innerHTML = renderCredits(data);
  $('p-total').textContent = questions.length;

  const wraps = new Map();
  for (const w of root.querySelectorAll('.opt-wrap')) wraps.set(`${w.dataset.q}|${w.dataset.o}`, w);
  const textEls = [...root.querySelectorAll('[data-text]')];

  const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
  const { key, source } = resolveKey(location.hash, localStorage);
  const secret = configured ? key : null;
  const api = configured ? createApi({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY }) : null;
  const sync = createSync({ api, secret, storage: localStorage, canPoll: () => !document.hidden });

  // Pasting another plan's link into this tab only changes the hash; reload so the tab never
  // keeps editing the previous plan while the address bar shows a different one.
  window.addEventListener('hashchange', () => {
    const next = parseKey(location.hash);
    if (next && next !== secret) {
      location.reload();
      return;
    }
    // In-page links (#ozet, the section chips) replace the hash; put the key back so that copying or
    // bookmarking the address bar still gives the whole plan link.
    if (!next && secret) history.replaceState(null, '', `${location.pathname}${location.search}#k=${secret}`);
  });

  const threads = mountThreads({ root, notes: $('notlar'), sync, storage: localStorage, askName: askNameDialog });
  let remembered = false;
  let asking = null;
  // One dialog at a time, even if several taps arrive before the name is typed.
  const getName = () => (asking ??= ensureName(localStorage, askNameDialog).finally(() => { asking = null; }));

  function paintWho() {
    const name = currentName();
    $('whoami').hidden = !secret || !name;
    $('whoami').textContent = name ? `Siz: ${name} · değiştir` : '';
  }

  $('whoami').addEventListener('click', async () => {
    const name = String((await askNameDialog(currentName())) ?? '').trim().slice(0, 40);
    if (!name) return;
    try { localStorage.setItem(NAME_KEY, name); } catch { /* storage blocked */ }
    paintWho();
    threads.render(sync.getState());
  });

  function paintOptions(answers) {
    for (const q of questions) {
      if (q.type !== 'radio' && q.type !== 'check') continue;
      const v = answers[q.id];
      const selected = q.type === 'check' ? (Array.isArray(v) ? v : []) : (v ? [v] : []);
      for (const o of q.options) {
        const wrap = wraps.get(`${q.id}|${o.id}`);
        if (!wrap) continue;
        const on = selected.includes(o.id);
        wrap.classList.toggle('is-on', on);
        const input = wrap.querySelector('input');
        if (input) input.checked = on;
      }
    }
  }

  // ---- free-text answers: what the person typed stays in the box until the server has accepted it ----
  const drafts = createDrafts();
  const typingTimers = {}; // key -> timeout: keystrokes not yet handed to the sync engine
  const committed = new Set(); // keys whose draft was handed over and awaits the server
  const sent = {}; // key -> last value handed over (avoids sending the same text twice)
  const blocked = {}; // key -> why the last save did not start

  function paintTexts(state) {
    for (const el of textEls) {
      const k = el.dataset.text;
      // A draft is retired once the server accepted it: nothing pending and nothing rejected.
      if (committed.has(k) && typingTimers[k] == null && !state.pendingIds.includes(k) && !state.rejected[k]) {
        drafts.clear(k);
        committed.delete(k);
      }
      const shown = drafts.shown(k, state.answers);
      if (el.value !== shown && document.activeElement !== el) el.value = shown;
      const note = root.querySelector(`[data-saved="${k}"]`);
      if (note) {
        note.textContent = blocked[k] || fieldLabel({
          typing: typingTimers[k] != null,
          pending: state.pendingIds.includes(k),
          rejected: state.rejected[k],
          saved: !drafts.has(k) && (state.answers[k] ?? '') !== '',
        });
      }
    }
  }

  function paintSummary(answers) {
    const sum = computeSummary(data.sections, answers);
    $('p-done').textContent = sum.done;
    $('p-bar').style.width = `${(100 * sum.done) / sum.total}%`;
    const days = $('p-days');
    const rounded = (Math.round(sum.days * 10) / 10).toLocaleString('tr-TR');
    days.textContent = `Seçtikleriniz ≈ ${rounded} gün${sum.eves ? ` + ${sum.eves} akşam` : ''} (${FULL_DAYS} tam gününüz var)`;
    days.classList.toggle('over', sum.over);
    $('p-usd').textContent = `Biletler ≈ $${Math.round(sum.usd).toLocaleString('tr-TR')}`;
    for (const [id, done] of Object.entries(sum.sectionDone)) {
      const chip = document.querySelector(`#jump a[data-sec="${id}"]`);
      if (chip) chip.classList.toggle('done', done);
    }
    $('sum-list').innerHTML = renderSummaryItems(sum.items);
  }

  function paintChrome(state) {
    const meta = state.meta || {};
    $('hero-title').textContent = meta.title || 'Tatil seçim rehberi';
    $('hero-sub').textContent = meta.subtitle || '';
    $('hero-sub').hidden = !meta.subtitle;
    if (meta.lede) $('hero-lede').textContent = meta.lede;
    if (meta.final) $('final-text').textContent = meta.final;
    document.title = meta.title ? `${meta.title} · LA tatili` : 'LA tatil planı';

    $('sync').textContent = STATUS_TEXT[state.status] || '';
    $('sync').dataset.mode = state.status;

    const banner = $('banner');
    if (state.error) banner.innerHTML = `<b>Kaydedilemedi:</b> ${esc(state.error)}`;
    else banner.innerHTML = BANNERS[state.status] || '';
    banner.hidden = !banner.innerHTML;
  }

  function paint(state) {
    paintChrome(state);
    paintOptions(state.answers);
    paintTexts(state);
    paintSummary(state.answers);
    paintMeta(root, state);
    threads.render(state);
    paintWho();
    $('notlar').hidden = !secret || state.status === 'invalid';
    if (state.status === 'live' && secret && !remembered) {
      remembered = true;
      rememberKey(localStorage, secret);
      if (source === 'storage') history.replaceState(null, '', `${location.pathname}${location.search}#k=${secret}`);
    }
  }

  // The new value is computed after the name is known, from the then-current state.
  // Resolves to 'ok' when the value was handed to the sync engine, else why it was not.
  async function choose(qid, valueFn) {
    if (sync.getState().status === 'invalid') return 'invalid'; // the banner already explains the link problem
    let by = '';
    if (secret) {
      by = await getName();
      if (!by) return 'name'; // dialog dismissed: nothing changes
    }
    sync.setAnswer(qid, valueFn(), by);
    return 'ok';
  }

  root.addEventListener('click', (e) => {
    const label = e.target.closest('label.opt');
    if (!label) return;
    e.preventDefault();
    const wrap = label.closest('.opt-wrap');
    const q = byId.get(wrap.dataset.q);
    choose(q.id, () => toggleValue(q.type, sync.getState().answers[q.id], wrap.dataset.o));
  });

  // Keyboard and assistive tech can change an input without a click on the label.
  root.addEventListener('change', (e) => {
    const input = e.target;
    if (!input.matches('label.opt input')) return;
    const wrap = input.closest('.opt-wrap');
    const q = byId.get(wrap.dataset.q);
    const current = sync.getState().answers[q.id];
    const has = q.type === 'check' ? Array.isArray(current) && current.includes(wrap.dataset.o) : current === wrap.dataset.o;
    if (input.checked === has) return;
    choose(q.id, () => toggleValue(q.type, sync.getState().answers[q.id], wrap.dataset.o));
  });

  async function commit(k) {
    if (typingTimers[k] != null) {
      clearTimeout(typingTimers[k]);
      delete typingTimers[k];
    }
    if (!drafts.has(k)) return;
    const text = drafts.get(k);
    if (committed.has(k) && sent[k] === text) return; // blur right after the pause: already on its way
    const result = await choose(k, () => drafts.get(k));
    if (result === 'ok') {
      committed.add(k);
      sent[k] = text;
      delete blocked[k];
    } else {
      blocked[k] = result === 'name' ? 'Kaydedilmedi: önce adınızı yazın' : 'Kaydedilmedi: bağlantı geçersiz';
    }
    paintTexts(sync.getState());
  }

  root.addEventListener('input', (e) => {
    const el = e.target.closest('[data-text]');
    if (!el) return;
    const k = el.dataset.text;
    drafts.set(k, el.value);
    committed.delete(k);
    delete blocked[k];
    clearTimeout(typingTimers[k]);
    typingTimers[k] = setTimeout(() => commit(k), 800);
    paintTexts(sync.getState());
  });

  // Leaving the field saves at once instead of waiting out the typing pause.
  root.addEventListener('change', (e) => {
    const el = e.target.closest('[data-text]');
    if (el) commit(el.dataset.text);
  });

  // The network may be back (or the tab visible again): retry now instead of waiting out the backoff.
  window.addEventListener('online', () => sync.kick());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync.kick();
  });

  sync.subscribe(paint);
  sync.start();
  paint(sync.getState());
}

main().catch((e) => {
  console.error(e);
  $('banner').innerHTML = '<b>Sayfa yüklenemedi.</b> Sayfayı yenileyin; sorun sürerse bir süre sonra yeniden deneyin.';
  $('banner').hidden = false;
});
