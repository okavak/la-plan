import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { esc, renderSections, renderJump, renderCredits, renderSummaryItems } from '../src/render.js';

const data = JSON.parse(readFileSync(new URL('../assets/data.json', import.meta.url), 'utf8'));
const questions = data.sections.flatMap((s) => s.questions);
const count = (html, needle) => html.split(needle).length - 1;

const fixture = {
  sections: [{
    id: 's1', title: '<script>alert(1)</script>', lead: 'a & b',
    questions: [{
      id: 'q1', type: 'radio', title: 'Soru "bir" <b>',
      options: [{ id: 'a', title: "O'Reilly <img src=x onerror=alert(1)>" }],
    }],
  }],
  details: {},
  credits: {},
};

test('esc escapes the five HTML characters', () => {
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(esc(null), '');
});

test('renderSections escapes titles', () => {
  const html = renderSections(fixture);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('one .opt-wrap per option in the data', () => {
  const options = questions.flatMap((q) => q.options ?? []);
  assert.equal(count(renderSections(data), 'class="opt-wrap'), options.length);
});

test('one article per question with a meta line and a comment button', () => {
  const html = renderSections(data);
  assert.equal(count(html, '<article class="q"'), 31);
  assert.equal(count(html, 'data-qmeta="'), 31);
  assert.equal(count(html, 'data-comments="q:'), 31);
});

test('image paths use assets/img', () => {
  const html = renderSections(data);
  assert.ok(html.includes('src="assets/img/disneyland.jpg"'));
  assert.ok(!html.includes('src="img/'));
});

test('text and number questions carry data-text', () => {
  const html = renderSections(data);
  const number = questions.find((q) => q.type === 'number');
  const text = questions.find((q) => q.type === 'text');
  const withText = questions.find((q) => q.text);
  assert.ok(html.includes(`data-text="${number.id}"`));
  assert.ok(html.includes(`data-text="${text.id}"`));
  assert.ok(html.includes(`data-text="${withText.text.id}"`));
});

test('radio options render as radios and check options as checkboxes', () => {
  const html = renderSections(data);
  const optionCount = (type) => questions.filter((q) => q.type === type).reduce((n, q) => n + q.options.length, 0);
  assert.equal(count(html, 'type="radio"'), optionCount('radio'));
  assert.equal(count(html, 'type="checkbox"'), optionCount('check'));
});

test('renderJump has one chip per section', () => {
  const html = renderJump(data);
  assert.equal(count(html, 'data-sec="'), data.sections.length);
  assert.ok(html.includes('href="#sec-parklar"'));
});

test('renderSummaryItems marks empty answers', () => {
  const html = renderSummaryItems([
    { qid: 'a', title: 'Soru <1>', text: '' },
    { qid: 'b', title: 'Soru 2', text: 'A · B' },
  ]);
  assert.ok(html.includes('Soru &lt;1&gt;'));
  assert.equal(count(html, 'class="v empty"'), 1);
  assert.ok(html.includes('Henüz seçilmedi'));
  assert.ok(html.includes('A · B'));
});

test('renderSummaryItems escapes the answer text', () => {
  const html = renderSummaryItems([{ qid: 'a', title: 'Not', text: '<img src=x onerror=alert(1)> & "q"' }]);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;'));
});

test('renderCredits links only http(s) pages', () => {
  const html = renderCredits({
    credits: {
      a: { artist: 'Ali', license: 'CC BY', page: 'https://commons.wikimedia.org/wiki/File:A.jpg' },
      b: { artist: 'Veli', license: 'CC0', page: 'javascript:alert(1)' },
    },
  });
  assert.ok(html.includes('href="https://commons.wikimedia.org/wiki/File:A.jpg"'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('Veli (CC0)'));
});
