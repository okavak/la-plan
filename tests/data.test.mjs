import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(join(root, 'assets', 'data.json'), 'utf8');
const data = JSON.parse(text);
const questions = data.sections.flatMap((s) => s.questions);
const options = questions.flatMap((q) => q.options ?? []);
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

test('has 9 sections, 31 questions, 201 options, 94 details, 79 credits', () => {
  assert.equal(data.sections.length, 9);
  assert.equal(questions.length, 31);
  assert.equal(options.length, 201);
  assert.equal(Object.keys(data.details).length, 94);
  assert.equal(Object.keys(data.credits).length, 79);
});

test('question types are 18 check, 11 radio, 1 number, 1 text', () => {
  const count = (type) => questions.filter((q) => q.type === type).length;
  assert.deepEqual(
    { check: count('check'), radio: count('radio'), number: count('number'), text: count('text') },
    { check: 18, radio: 11, number: 1, text: 1 },
  );
});

test('all 32 answer keys match the key pattern and are unique', () => {
  const keys = [
    ...questions.map((q) => q.id),
    ...questions.filter((q) => q.text).map((q) => q.text.id),
  ];
  assert.equal(keys.length, 32);
  assert.equal(new Set(keys).size, 32, 'answer keys must be unique');
  for (const k of keys) assert.match(k, KEY, `bad answer key: ${k}`);
});

test('every option and compare image key has assets/img/<key>.jpg and a credits entry', () => {
  const keys = new Set();
  for (const o of options) for (const k of [o.img, o.img2]) if (k) keys.add(k);
  for (const q of questions) for (const k of q.compare?.imgs ?? []) if (k) keys.add(k);
  assert.ok(keys.size > 0);
  for (const k of keys) {
    assert.ok(existsSync(join(root, 'assets', 'img', `${k}.jpg`)), `missing file for ${k}`);
    assert.ok(data.credits[k], `missing credit for ${k}`);
  }
});

// SHA-256 of lowercase words that must never appear in the public catalog: the lodging name and its
// street number, family names and the company name. Only hashes are committed, so the words themselves
// stay out of this public repository. Public places (a park, restaurants on a boulevard) are fine.
const FORBIDDEN_WORD_HASHES = new Set([
  'a17312e77236a137f5b028e1c3dacdf18f89a4a62459fdfa564639f0e1ceaea2',
  '7a752682405307d3e133cff870caa1ce9d39a4d10c0077a8734d9dff6697bc44',
  'ee637cd127ecb569e067690a855a4b704c80560ef7fa3db658ef7cc27e3919e3',
  '6b846231c066ef19d5a8345cd8da8488e1cf87fea493756e36931f4a56e6d8ea',
  'd78d83820b56cd74f42fe80cfb6692ea5f6384e2ea4ca2ea22b47046c5720062',
  '79872ee7968f97bc50d2602fd4d93dc7bb736e8e1c9dd5398d208e6dcfdcfebe',
]);

test('contains no forbidden word and no email address', () => {
  const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const hits = [...words].filter((w) => FORBIDDEN_WORD_HASHES.has(createHash('sha256').update(w).digest('hex')));
  assert.deepEqual(hits, [], 'forbidden word present in assets/data.json');
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), 'email address present in assets/data.json');
});
