import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrafts, fieldLabel } from '../src/drafts.js';

test('a draft wins over the stored answer until it is cleared', () => {
  const drafts = createDrafts();
  drafts.set('allergy', 'fındık');
  assert.equal(drafts.has('allergy'), true);
  assert.equal(drafts.get('allergy'), 'fındık');
  assert.equal(drafts.shown('allergy', { allergy: 'eski' }), 'fındık');
  assert.equal(drafts.shown('allergy', {}), 'fındık');
  drafts.clear('allergy');
  assert.equal(drafts.has('allergy'), false);
  assert.equal(drafts.shown('allergy', { allergy: 'eski' }), 'eski');
});

test('an empty draft is still a draft (the person cleared the field)', () => {
  const drafts = createDrafts();
  drafts.set('note', '');
  assert.equal(drafts.has('note'), true);
  assert.equal(drafts.shown('note', { note: 'eski' }), '');
});

test('without a draft the stored answer is shown, and an empty string when there is none', () => {
  const drafts = createDrafts();
  assert.equal(drafts.shown('note', { note: 'kayıtlı' }), 'kayıtlı');
  assert.equal(drafts.shown('note', {}), '');
});

test('fieldLabel prefers a rejection, then typing, then pending, then saved', () => {
  assert.equal(fieldLabel({ rejected: 'Metin çok uzun.', typing: true, pending: true, saved: true }), 'Kaydedilemedi: Metin çok uzun.');
  assert.equal(fieldLabel({ typing: true, pending: true, saved: true }), 'Yazılıyor…');
  assert.equal(fieldLabel({ pending: true, saved: true }), 'Kaydediliyor…');
  assert.equal(fieldLabel({ saved: true }), 'Kaydedildi');
  assert.equal(fieldLabel({}), '');
});
