import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_DAYS, LAST_KEY, parseKey, resolveKey, rememberKey, isEmptyValue, toggleValue,
  reconcile, computeSummary, groupComments,
} from '../src/store.js';
import { memStorage } from './helpers.mjs';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 chars
const OTHER = 'ZyXwVuTsRqPoNmLkJiHgFe';

test('FULL_DAYS is 7', () => {
  assert.equal(FULL_DAYS, 7);
});

test('parseKey accepts a 22-char key and rejects malformed hashes', () => {
  assert.equal(parseKey(`#k=${KEY}`), KEY);
  assert.equal(parseKey(`k=${KEY}`), KEY);
  assert.equal(parseKey(`#k=${'a'.repeat(64)}`), 'a'.repeat(64));
  for (const bad of ['', '#', '#k=', '#k=short', `#x=${KEY}`, `#k=${KEY}/x`, `#k=${KEY} x`, `#k=${'a'.repeat(65)}`]) {
    assert.equal(parseKey(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(parseKey(undefined), null);
});

test('resolveKey prefers a valid hash key over the stored one', () => {
  const storage = memStorage({ [LAST_KEY]: OTHER });
  assert.deepEqual(resolveKey(`#k=${KEY}`, storage), { key: KEY, source: 'hash' });
});

test('resolveKey falls back to the stored key when the hash has none', () => {
  const storage = memStorage({ [LAST_KEY]: OTHER });
  assert.deepEqual(resolveKey('', storage), { key: OTHER, source: 'storage' });
  assert.deepEqual(resolveKey('#nonsense', storage), { key: OTHER, source: 'storage' });
});

test('resolveKey returns null/null when neither exists or the stored value is malformed', () => {
  assert.deepEqual(resolveKey('', memStorage()), { key: null, source: null });
  assert.deepEqual(resolveKey('', memStorage({ [LAST_KEY]: 'short' })), { key: null, source: null });
});

test('rememberKey stores the key for later resolveKey calls', () => {
  const storage = memStorage();
  rememberKey(storage, KEY);
  assert.deepEqual(resolveKey('', storage), { key: KEY, source: 'storage' });
});

test('isEmptyValue covers the five empty forms', () => {
  for (const empty of [null, undefined, '', '   ', []]) assert.equal(isEmptyValue(empty), true, JSON.stringify(empty));
  for (const full of ['x', ['a'], 0]) assert.equal(isEmptyValue(full), false, JSON.stringify(full));
});

test('toggleValue radio sets then clears', () => {
  assert.equal(toggleValue('radio', undefined, 'a'), 'a');
  assert.equal(toggleValue('radio', 'a', 'b'), 'b');
  assert.equal(toggleValue('radio', 'a', 'a'), undefined);
});

test('toggleValue check adds, removes, returns undefined when last removed', () => {
  assert.deepEqual(toggleValue('check', undefined, 'a'), ['a']);
  assert.deepEqual(toggleValue('check', ['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleValue('check', ['a', 'b'], 'a'), ['b']);
  assert.equal(toggleValue('check', ['b'], 'b'), undefined);
  assert.deepEqual(toggleValue('check', 'corrupt', 'a'), ['a']);
});

test('reconcile keeps pending over server', () => {
  const out = reconcile({ server: { a: '1' }, local: { a: '2' }, pending: { a: '2' }, ackedAt: {}, startedAt: 100 });
  assert.deepEqual(out, { a: '2' });
});

test('reconcile treats an empty pending value as a pending clear', () => {
  const out = reconcile({ server: { a: '1' }, local: {}, pending: { a: '' }, ackedAt: {}, startedAt: 100 });
  assert.deepEqual(out, {});
});

test('reconcile ignores a server value when the ack is newer than the poll start', () => {
  const out = reconcile({ server: { a: 'old' }, local: { a: 'new' }, pending: {}, ackedAt: { a: 200 }, startedAt: 100 });
  assert.deepEqual(out, { a: 'new' });
  const cleared = reconcile({ server: { a: 'old' }, local: {}, pending: {}, ackedAt: { a: 200 }, startedAt: 100 });
  assert.deepEqual(cleared, {});
});

test('reconcile treats an ack in the same millisecond as the poll start as newer', () => {
  const out = reconcile({ server: { a: 'old' }, local: { a: 'new' }, pending: {}, ackedAt: { a: 100 }, startedAt: 100 });
  assert.deepEqual(out, { a: 'new' });
});

test('reconcile takes the server value when the ack is older than the poll start', () => {
  const out = reconcile({ server: { a: 'server' }, local: { a: 'new' }, pending: {}, ackedAt: { a: 50 }, startedAt: 100 });
  assert.deepEqual(out, { a: 'server' });
});

test('reconcile takes the server value and drops local keys absent from the server', () => {
  const out = reconcile({ server: { a: '1' }, local: { a: '1', b: 'x' }, pending: {}, ackedAt: {}, startedAt: 100 });
  assert.deepEqual(out, { a: '1' });
});

const sections = [
  { id: 's1', title: 'S1', questions: [
    { id: 'q1', type: 'radio', title: 'Park?', options: [
      { id: 'a', title: 'İki gün', w: 2, usd: 100 },
      { id: 'no', title: 'Gitmeyelim', w: 0 },
    ] },
    { id: 'q2', type: 'check', title: 'Gezi', options: [
      { id: 'c', title: 'Catalina', w: 5.5, eve: true, usd: 50 },
      { id: 'd', title: 'Sörf', w: 1, usd: null },
    ] },
  ] },
  { id: 's2', title: 'S2', questions: [
    { id: 'diet', type: 'check', title: 'Beslenme', options: [{ id: 'veg', title: 'Vejetaryen' }], text: { id: 'allergy', label: 'Alerji' } },
    { id: 'boy', type: 'number', title: 'Boy' },
    { id: 'not', type: 'text', title: 'Not' },
  ] },
];

test('computeSummary counts days, eves, usd and flags over 7', () => {
  const s = computeSummary(sections, { q1: 'a', q2: ['c', 'd'] });
  assert.equal(s.total, 5);
  assert.equal(s.done, 2);
  assert.equal(s.days, 8.5);
  assert.equal(s.eves, 1);
  assert.equal(s.usd, 150);
  assert.equal(s.over, true);
  assert.deepEqual(s.sectionDone, { s1: true, s2: false });
  const none = computeSummary(sections, { q1: 'no' });
  assert.equal(none.days, 0);
  assert.equal(none.over, false);
});

test('computeSummary renders number and text answers', () => {
  const s = computeSummary(sections, { diet: ['veg'], allergy: 'fındık', boy: '118', not: 'merhaba' });
  const text = Object.fromEntries(s.items.map((i) => [i.qid, i.text]));
  assert.equal(text.diet, 'Vejetaryen · fındık');
  assert.equal(text.boy, '118 cm');
  assert.equal(text.not, 'merhaba');
  assert.equal(text.q1, '');
  assert.equal(s.done, 3);
  assert.deepEqual(s.items.map((i) => i.title).slice(0, 2), ['Park?', 'Gezi']);
});

test('groupComments orders oldest first per scope', () => {
  const map = groupComments([
    { id: '1', scope: 'q:a', author: 'A', body: 'x', at: '2026-10-21T10:05:00Z' },
    { id: '2', scope: 'general', author: 'A', body: 'x', at: '2026-10-21T10:00:00Z' },
    { id: '3', scope: 'q:a', author: 'B', body: 'x', at: '2026-10-21T10:01:00Z' },
  ]);
  assert.deepEqual(map.get('q:a').map((c) => c.id), ['3', '1']);
  assert.deepEqual(map.get('general').map((c) => c.id), ['2']);
  assert.equal(map.get('day:1'), undefined);
});
