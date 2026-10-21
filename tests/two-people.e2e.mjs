// End-to-end proof with separate browser contexts (separate storage, like two phones).
//
//   node --test tests/two-people.e2e.mjs                   local: static server + in-memory fake backend (default)
//   LA_TARGET=remote node --test tests/two-people.e2e.mjs  the live site and the real Supabase project
//                                                          (LA_SITE overrides https://okavak.github.io/la-plan/)
//
// Every test makes its own throwaway plan (e2e-<random>); all of them are deleted afterwards.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { startFakeBackend } from '../tools/fake-backend.mjs';
import { startServer } from '../tools/serve.mjs';
import { createAdmin, loadEnv, supabaseRunner } from '../tools/admin.mjs';

const REMOTE = process.env.LA_TARGET === 'remote';
const POLL_WAIT = 12_000; // two poll intervals plus slack
const opts = { timeout: 120_000 };

let browser;
let site;
let backend;
const created = [];

before(async () => {
  browser = await chromium.launch();
  if (REMOTE) {
    const env = loadEnv();
    const admin = createAdmin({ runSql: supabaseRunner(env.LA_PROJECT_REF) });
    site = process.env.LA_SITE || 'https://okavak.github.io/la-plan/';
    backend = {
      newPlan: async (slug, title, secret) => admin.newPlan(slug, title, { subtitle: 'e2e', secret }),
      deletePlan: async (slug) => admin.deletePlan(slug),
      close: async () => {},
    };
  } else {
    const fake = await startFakeBackend();
    const server = await startServer({ backend: { url: fake.url } });
    site = `${server.url}/`;
    backend = {
      newPlan: (slug, title, secret) => fake.newPlan(slug, title, 'e2e', secret),
      deletePlan: (slug) => fake.deletePlan(slug),
      close: async () => { await server.close(); await fake.close(); },
    };
  }
});

after(async () => {
  for (const slug of created) await backend.deletePlan(slug);
  await browser.close();
  await backend.close();
});

async function newPlan(title) {
  const slug = `e2e-${randomBytes(4).toString('hex')}`;
  const secret = randomBytes(16).toString('base64url');
  created.push(slug);
  await backend.newPlan(slug, title, secret);
  return { slug, secret, url: `${site}#k=${secret}` };
}

const opt = (qid, oid) => `.opt-wrap[data-q="${qid}"][data-o="${oid}"]`;

/** A person on their own "phone": a fresh context with its own storage. */
async function person() {
  const ctx = await browser.newContext();
  return { ctx, close: () => ctx.close() };
}

async function openLive(ctx, url) {
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('#sync[data-mode="live"]', { timeout: 20_000 });
  return page;
}

/** Answers the "what is your name" dialog. */
async function giveName(page, name) {
  const input = page.locator('dialog.name input');
  await input.waitFor({ timeout: 5_000 });
  await input.fill(name);
  await input.press('Enter');
  await page.locator('dialog.name').waitFor({ state: 'detached', timeout: 5_000 });
}

async function tap(page, qid, oid, { name } = {}) {
  await page.click(`${opt(qid, oid)} label.opt`);
  if (name) await giveName(page, name);
}

const isOn = (page, qid, oid, timeout = POLL_WAIT) => page.waitForSelector(`${opt(qid, oid)}.is-on`, { timeout });
const isOff = (page, qid, oid, timeout = POLL_WAIT) => page.waitForSelector(`${opt(qid, oid)}:not(.is-on)`, { timeout });
const status = (page) => page.locator('#sync').getAttribute('data-mode');

async function comment(page, scope, text, { name } = {}) {
  const box = scope === 'general' ? '#notlar' : `#q-${scope.slice(2)}`;
  if (scope !== 'general') await page.click(`.cbtn[data-comments="${scope}"]`);
  await page.locator(`${box} .thread textarea`).fill(text);
  await page.locator(`${box} .thread .cmt-send`).click();
  if (name) await giveName(page, name);
}

test('person B sees person A\'s tap within a poll, and who made it', opts, async () => {
  const p = await newPlan('E2E tap');
  const a = await person();
  const b = await person();
  try {
    const pageA = await openLive(a.ctx, p.url);
    const pageB = await openLive(b.ctx, p.url);
    assert.equal(await pageB.locator('#hero-title').textContent(), 'E2E tap');
    await tap(pageA, 'disney', 'two', { name: 'Ali' });
    await isOn(pageA, 'disney', 'two', 2_000);
    await isOn(pageB, 'disney', 'two');
    await pageB.waitForFunction(() => document.querySelector('.qmeta[data-qmeta="disney"]').textContent.includes('Ali'), null, { timeout: POLL_WAIT });
    // B changes the same question: A follows, and the card A tapped is no longer selected.
    await tap(pageB, 'disney', 'dl1', { name: 'Veli' });
    await isOn(pageA, 'disney', 'dl1');
    await isOff(pageA, 'disney', 'two');
  } finally {
    await a.close();
    await b.close();
  }
});

test('a comment from B reaches A, and HTML in it stays plain text', opts, async () => {
  const p = await newPlan('E2E comment');
  const a = await person();
  const b = await person();
  try {
    const pageA = await openLive(a.ctx, p.url);
    const pageB = await openLive(b.ctx, p.url);
    await comment(pageB, 'q:disney', '<img src=x onerror="window.__pwned=1"> merhaba', { name: 'Veli' });
    await pageA.waitForFunction(() => document.querySelector('.cnt[data-count="q:disney"]').textContent === '1', null, { timeout: POLL_WAIT });
    await pageA.click('.cbtn[data-comments="q:disney"]');
    const body = await pageA.locator('#q-disney .cmt-body').first().textContent();
    assert.ok(body.includes('<img src=x onerror="window.__pwned=1">'), 'shown as text');
    assert.equal(await pageA.evaluate(() => window.__pwned), undefined, 'no script ran');
    assert.equal(await pageA.locator('#q-disney .cmt-head b').first().textContent(), 'Veli');
    assert.equal(await pageA.locator('#q-disney .cmt-del').count(), 0, 'A cannot delete B\'s comment');
    // B can delete their own.
    await pageB.click('#q-disney .cmt-del');
    await pageA.waitForFunction(() => document.querySelector('.cnt[data-count="q:disney"]').textContent === '', null, { timeout: POLL_WAIT });
  } finally {
    await a.close();
    await b.close();
  }
});

test('general notes are shared', opts, async () => {
  const p = await newPlan('E2E notes');
  const a = await person();
  const b = await person();
  try {
    const pageA = await openLive(a.ctx, p.url);
    const pageB = await openLive(b.ctx, p.url);
    await comment(pageA, 'general', 'Önce Disney günlerini sabitleyelim', { name: 'Ali' });
    await pageB.waitForFunction(() => document.querySelector('#notlar .cmt-body')?.textContent.includes('Disney'), null, { timeout: POLL_WAIT });
  } finally {
    await a.close();
    await b.close();
  }
});

test('a tap made offline is kept and arrives after going back online', opts, async () => {
  const p = await newPlan('E2E offline');
  const a = await person();
  const b = await person();
  try {
    const pageA = await openLive(a.ctx, p.url);
    const pageB = await openLive(b.ctx, p.url);
    await tap(pageA, 'universal', 'u1', { name: 'Ali' });
    await isOn(pageB, 'universal', 'u1');
    await a.ctx.setOffline(true);
    await tap(pageA, 'wb', 'tour');
    await isOn(pageA, 'wb', 'tour', 2_000);
    await pageA.waitForFunction(() => document.getElementById('sync').dataset.mode === 'offline', null, { timeout: POLL_WAIT });
    assert.match(await pageA.locator('#sync').textContent(), /Bağlantı yok/);
    await a.ctx.setOffline(false);
    await pageA.waitForFunction(() => document.getElementById('sync').dataset.mode === 'live', null, { timeout: 20_000 });
    await isOn(pageB, 'wb', 'tour', 20_000);
    assert.equal(await status(pageA), 'live');
  } finally {
    await a.close();
    await b.close();
  }
});

test('the name is asked once and remembered across a reload', opts, async () => {
  const p = await newPlan('E2E name');
  const a = await person();
  try {
    const page = await openLive(a.ctx, p.url);
    await tap(page, 'disney', 'two', { name: 'Ali' });
    await tap(page, 'universal', 'u1');
    assert.equal(await page.locator('dialog.name').count(), 0, 'second tap does not ask again');
    assert.equal(await page.locator('#whoami').textContent(), 'Siz: Ali · değiştir');
    await page.reload();
    await page.waitForSelector('#sync[data-mode="live"]');
    await tap(page, 'wb', 'tour');
    assert.equal(await page.locator('dialog.name').count(), 0, 'reload does not ask again');
    await isOn(page, 'disney', 'two', 5_000);
  } finally {
    await a.close();
  }
});

test('a wrong key shows the invalid banner and none of the plan\'s answers', opts, async () => {
  const p = await newPlan('E2E wrong key');
  const a = await person();
  const c = await person();
  try {
    const pageA = await openLive(a.ctx, p.url);
    await tap(pageA, 'disney', 'two', { name: 'Ali' });
    const wrong = `${site}#k=${randomBytes(16).toString('base64url')}`;
    const pageC = await c.ctx.newPage();
    await pageC.goto(wrong);
    await pageC.waitForSelector('#sync[data-mode="invalid"]', { timeout: 20_000 });
    assert.match(await pageC.locator('#banner').textContent(), /geçersiz/);
    assert.equal(await pageC.locator('.opt-wrap.is-on').count(), 0);
    assert.equal(await pageC.locator('#notlar').isVisible(), false);
    await pageC.click(`${opt('disney', 'two')} label.opt`);
    assert.equal(await pageC.locator('dialog.name').count(), 0, 'taps do nothing on an invalid link');
    assert.equal(await pageC.locator('.opt-wrap.is-on').count(), 0);
  } finally {
    await a.close();
    await c.close();
  }
});

test('no key shows the local banner and still lets the visitor choose, without touching the backend', opts, async () => {
  const d = await person();
  try {
    const page = await d.ctx.newPage();
    const rpcCalls = [];
    page.on('request', (req) => { if (req.url().includes('/rest/v1/')) rpcCalls.push(req.url()); });
    await page.goto(site);
    await page.waitForSelector('#sync[data-mode="local"]');
    assert.match(await page.locator('#banner').textContent(), /plan linki olmadan/);
    await tap(page, 'disney', 'two');
    assert.equal(await page.locator('dialog.name').count(), 0, 'local mode never asks for a name');
    await isOn(page, 'disney', 'two', 2_000);
    await page.reload();
    await page.waitForSelector('#sync[data-mode="local"]');
    await isOn(page, 'disney', 'two', 2_000);
    assert.deepEqual(rpcCalls, []);
  } finally {
    await d.close();
  }
});

test('plan A\'s key never shows plan B\'s answers', opts, async () => {
  const planA = await newPlan('E2E plan A');
  const planB = await newPlan('E2E plan B');
  const a = await person();
  const b = await person();
  try {
    const pageB = await openLive(b.ctx, planB.url);
    await tap(pageB, 'disney', 'hopper', { name: 'Veli' });
    await comment(pageB, 'general', 'only for plan B');
    await pageB.waitForFunction(() => document.querySelector('#notlar .cmt-body')?.textContent.includes('plan B'), null, { timeout: POLL_WAIT });
    const pageA = await openLive(a.ctx, planA.url);
    await pageA.waitForTimeout(6_000);
    assert.equal(await pageA.locator('#hero-title').textContent(), 'E2E plan A');
    assert.equal(await pageA.locator('.opt-wrap.is-on').count(), 0);
    assert.equal(await pageA.locator('#notlar .cmt').count(), 0);
  } finally {
    await a.close();
    await b.close();
  }
});

test('pasting another plan\'s link into the same tab switches plans', opts, async () => {
  const planA = await newPlan('E2E first plan');
  const planB = await newPlan('E2E second plan');
  const a = await person();
  try {
    const page = await openLive(a.ctx, planA.url);
    assert.equal(await page.locator('#hero-title').textContent(), 'E2E first plan');
    await page.evaluate((secret) => { location.hash = `#k=${secret}`; }, planB.secret);
    await page.waitForFunction(() => document.getElementById('hero-title').textContent === 'E2E second plan', null, { timeout: 15_000 });
    assert.equal(await status(page), 'live');
  } finally {
    await a.close();
  }
});

test('text typed right before tapping a card is not lost', opts, async () => {
  const p = await newPlan('E2E draft');
  const a = await person();
  const b = await person();
  try {
    const pageA = await openLive(a.ctx, p.url);
    const pageB = await openLive(b.ctx, p.url);
    await tap(pageA, 'disney', 'two', { name: 'Ali' });
    // Type, move focus away and tap a card, all inside the 800 ms typing pause (one synchronous step, so the
    // timing does not depend on how fast the test runner is).
    await pageA.evaluate(() => {
      const field = document.querySelector('[data-text="allergy"]');
      field.focus();
      field.value = 'fındık';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.blur();
      document.querySelector('.opt-wrap[data-q="daytrip"][data-o="catalina"] label.opt').click();
    });
    await isOn(pageA, 'daytrip', 'catalina', 2_000);
    await pageA.waitForTimeout(1_500);
    assert.equal(await pageA.locator('[data-text="allergy"]').inputValue(), 'fındık');
    await pageB.waitForFunction(() => document.querySelector('[data-text="allergy"]').value === 'fındık', null, { timeout: POLL_WAIT });
  } finally {
    await a.close();
    await b.close();
  }
});

test('text typed before the name is known survives polls while the name dialog is open', opts, async () => {
  const p = await newPlan('E2E draft name');
  const a = await person();
  const b = await person();
  try {
    const pageA = await openLive(a.ctx, p.url);
    const pageB = await openLive(b.ctx, p.url);
    await pageA.locator('[data-text="allergy"]').fill('fındık');
    await pageA.locator('dialog.name input').waitFor({ timeout: 5_000 }); // opens after the typing pause
    // Opening the dialog moves focus out of the field, which saves it at once; that must not ask for the name again.
    assert.equal(await pageA.locator('dialog.name').count(), 1);
    await pageA.waitForTimeout(6_500); // a poll runs behind the dialog
    await giveName(pageA, 'Ali');
    assert.equal(await pageA.locator('[data-text="allergy"]').inputValue(), 'fındık');
    await pageB.waitForFunction(() => document.querySelector('[data-text="allergy"]').value === 'fındık', null, { timeout: POLL_WAIT });
  } finally {
    await a.close();
    await b.close();
  }
});

test('a note too long for the server stays in the box and shows an error', opts, async () => {
  const p = await newPlan('E2E long note');
  const a = await person();
  try {
    const page = await openLive(a.ctx, p.url);
    await tap(page, 'disney', 'two', { name: 'Ali' });
    const note = page.locator('textarea[data-text]');
    const label = page.locator('textarea[data-text] + .saved');
    await note.evaluate((el) => el.removeAttribute('maxlength')); // get past the browser limit to reach the server's
    await note.fill('x'.repeat(4500));
    await note.blur();
    await page.waitForFunction(() => document.querySelector('textarea[data-text] + .saved').textContent.startsWith('Kaydedilemedi'), null, { timeout: 8_000 });
    await page.waitForTimeout(6_500); // a poll must not blank the box
    assert.equal((await note.inputValue()).length, 4500);
    assert.match(await label.textContent(), /Kaydedilemedi: Metin çok uzun/);
    await note.fill('kısa not');
    await note.blur();
    await page.waitForFunction(() => document.querySelector('textarea[data-text] + .saved').textContent === 'Kaydedildi', null, { timeout: 8_000 });
    assert.equal(await note.inputValue(), 'kısa not');
  } finally {
    await a.close();
  }
});

test('in-page navigation keeps the plan key in the address bar', opts, async () => {
  const p = await newPlan('E2E address bar');
  const a = await person();
  try {
    const page = await openLive(a.ctx, p.url);
    await page.click('#jump a');
    await page.waitForTimeout(400);
    assert.equal(new URL(page.url()).hash, `#k=${p.secret}`);
    await page.click('a[href="#ozet"]');
    await page.waitForTimeout(400);
    assert.equal(new URL(page.url()).hash, `#k=${p.secret}`);
    assert.equal(await status(page), 'live', 'no reload and no state change');
  } finally {
    await a.close();
  }
});
