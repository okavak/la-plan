// Pure HTML-string renderers. Markup and class names follow the original guide page
// (sayfa/rehber.template.html) so the existing styles keep applying.

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.8"/></svg>';
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

function dots(n) {
  const k = Math.max(1, Math.min(3, n | 0));
  return '●●●'.slice(0, k) + '○○○'.slice(0, 3 - k);
}

function safeUrl(u) {
  return /^https?:\/\//i.test(u || '') ? u : '';
}

const imgTag = (key) => `<img src="assets/img/${esc(key)}.jpg" alt="" loading="lazy" decoding="async">`;

function compareBlock(data, q) {
  const c = q.compare;
  const imgs = c.imgs || [];
  const cimg = (i) => (imgs[i] && data.credits[imgs[i]] ? imgTag(imgs[i]) : '');
  let h = '<div class="compare-wrap"><table class="compare"><thead><tr>';
  h += c.cols.map((col, i) => `<th scope="col">${i ? cimg(i) : ''}${esc(col)}</th>`).join('');
  h += '</tr></thead><tbody>';
  for (const r of c.rows) h += `<tr><th scope="row">${esc(r[0])}</th><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`;
  h += '</tbody></table></div><div class="compare-stack">';
  for (let ci = 1; ci < c.cols.length; ci++) {
    h += `<div class="cs-col">${cimg(ci)}<div class="cs-body"><h4>${esc(c.cols[ci])}</h4><dl>`;
    for (const r of c.rows) h += `<dt>${esc(r[0])}</dt><dd>${esc(r[ci])}</dd>`;
    h += '</dl></div></div>';
  }
  return `${h}</div>`;
}

function textField(id, label, labelAttrs = '') {
  return `<div class="field"><label for="t-${esc(id)}"${labelAttrs}>${esc(label)}</label>`;
}

function question(data, q, num) {
  let h = `<article class="q" id="q-${esc(q.id)}" data-q="${esc(q.id)}"><div class="q-head">`;
  h += `<div class="q-title"><span class="q-num">${num}</span><h3>${esc(q.title)}</h3></div>`;
  if (q.type === 'radio') h += '<span class="mode one">Birini seçin</span>';
  if (q.type === 'check') h += '<span class="mode">Beğendiklerinizin hepsini işaretleyin</span>';
  if (q.intro) h += `<p class="q-intro">${esc(q.intro)}</p>`;
  h += '</div>';
  if (q.compare) h += compareBlock(data, q);
  if (q.note) h += `<p class="note"><b>Not:</b> ${esc(q.note)}</p>`;
  if (q.type === 'radio' || q.type === 'check') {
    const rich = q.options.some((o) => o.img || o.time);
    h += `<div class="opts${rich ? '' : ' compact'}">${q.options.map((o) => option(data, q, o)).join('')}</div>`;
    if (q.text) {
      h += `${textField(q.text.id, q.text.label)}<input type="text" id="t-${esc(q.text.id)}" data-text="${esc(q.text.id)}" maxlength="300" placeholder="${esc(q.text.placeholder || '')}"><span class="saved" data-saved="${esc(q.text.id)}"></span></div>`;
    }
  } else if (q.type === 'number') {
    h += `${textField(q.id, 'Boy (cm)')}<input type="number" inputmode="numeric" min="90" max="170" id="t-${esc(q.id)}" data-text="${esc(q.id)}" placeholder="${esc(q.placeholder || '')}"><span class="saved" data-saved="${esc(q.id)}"></span></div>`;
  } else if (q.type === 'text') {
    h += `${textField(q.id, 'Notunuz', ' class="muted"')}<textarea id="t-${esc(q.id)}" data-text="${esc(q.id)}" maxlength="1000" placeholder="${esc(q.placeholder || '')}"></textarea><span class="saved" data-saved="${esc(q.id)}"></span></div>`;
  }
  h += `<div class="qfoot"><p class="qmeta" data-qmeta="${esc(q.id)}"></p>`;
  h += `<button type="button" class="cbtn" data-comments="q:${esc(q.id)}" aria-expanded="false">Yorum <span class="cnt" data-count="q:${esc(q.id)}"></span></button></div>`;
  return `${h}</article>`;
}

function option(data, q, o) {
  const type = q.type === 'radio' ? 'radio' : 'checkbox';
  const inputId = `o-${q.id}-${o.id}`;
  const imgs = [o.img, o.img2].filter((k) => k && data.credits[k]);
  let h = `<div class="opt-wrap${imgs.length ? ' has-img' : ''}" data-q="${esc(q.id)}" data-o="${esc(o.id)}">`;
  h += `<label class="opt" for="${esc(inputId)}"><input type="${type}" id="${esc(inputId)}" name="${esc(q.id)}" value="${esc(o.id)}">`;
  if (imgs.length) h += `<div class="pics" style="--n:${imgs.length}">${imgs.map(imgTag).join('')}</div>`;
  h += '<div class="opt-body">';
  const badges = (o.rec ? '<span class="badge rec">Önerimiz</span>' : '') + (o.star ? '<span class="badge star">Unutulmaz</span>' : '');
  if (badges) h += `<div class="badges">${badges}</div>`;
  h += `<div class="opt-top"><span class="opt-title">${esc(o.title)}</span><span class="tick ${type === 'radio' ? 'radio' : 'check'}">${CHECK}</span></div>`;
  if (o.desc) h += `<p class="desc">${esc(o.desc)}</p>`;
  if (o.kids) h += `<p class="kids">${esc(o.kids)}</p>`;
  let facts = '';
  if (o.time) facts += `<div><dt>Süre</dt><dd>${esc(o.time)}</dd></div>`;
  if (o.cost) facts += `<div><dt>Maliyet</dt><dd>${esc(o.cost)}</dd></div>`;
  if (o.drive) facts += `<div><dt>Otelden</dt><dd>${esc(o.drive)}</dd></div>`;
  if (facts) h += `<dl class="facts">${facts}</dl>`;
  if (o.fit) {
    h += `<p class="fit"><span>7 yaş <span class="dots" aria-label="3 üzerinden ${o.fit[0]}">${dots(o.fit[0])}</span></span>`;
    h += `<span>12 yaş <span class="dots" aria-label="3 üzerinden ${o.fit[1]}">${dots(o.fit[1])}</span></span></p>`;
  }
  if (o.imgNote) h += `<p class="kids">${esc(o.imgNote)}</p>`;
  h += '</div></label>';
  if (imgs.length) {
    const credit = imgs.map((k) => {
      const c = data.credits[k];
      const u = safeUrl(c.page);
      return `${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">` : ''}${esc(c.artist || 'Wikimedia Commons')}, ${esc(c.license)}${u ? '</a>' : ''}`;
    }).join(' · ');
    h += `<p class="credit">Foto: ${credit}</p>`;
  }
  h += moreBlock(data, q, o);
  return `${h}</div>`;
}

function moreBlock(data, q, o) {
  const det = (o.ids || []).map((id) => data.details[id]).filter(Boolean);
  let extra = '';
  if (o.more && typeof o.more === 'object') {
    let kv = '';
    for (const [k, v] of Object.entries(o.more)) if (v && String(v).trim()) kv += `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
    if (kv) extra += `<div class="more-item"><dl class="kv">${kv}</dl></div>`;
  }
  const srcs = (o.src || [])
    .map((s) => {
      const u = safeUrl(s.u);
      return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(s.t || 'Kaynak')}</a>` : '';
    })
    .filter(Boolean);
  if (srcs.length) extra += `<p class="src-line">Kaynak: ${srcs.join(' · ')}</p>`;
  if (!det.length && !extra) return '';
  const summary = det.length ? 'Bilet, kalabalık, park ve yemek bilgisi' : (q.food ? 'Ne sipariş edilir, saatler, park' : 'Saatler, park ve ipuçları');
  let h = `<details class="more"><summary>${summary}</summary><div class="more-body">`;
  for (const d of det) {
    let kv = '';
    const row = (k, v) => { if (v && String(v).trim()) kv += `<dt>${k}</dt><dd>${esc(v)}</dd>`; };
    row('En ucuz bilet', d.tickets); row('En sakin zaman', d.crowd); row('Park', d.parking); row('Yemek', d.food);
    row('Açık günler', d.days); row('Rezervasyon', d.book); row('Sınırlar', d.limits); row('Dikkat', d.warn);
    h += `<div class="more-item">${det.length > 1 ? `<h4>${esc(d.name)}</h4>` : ''}<dl class="kv">${kv}</dl></div>`;
  }
  return `${h}${extra}</div></details>`;
}

/** All sections with their question cards. */
export function renderSections(data) {
  let n = 0;
  let html = '';
  for (const s of data.sections) {
    html += `<section class="sec" id="sec-${esc(s.id)}" aria-labelledby="h-${esc(s.id)}"><div class="sec-head"><h2 id="h-${esc(s.id)}">${esc(s.title)}</h2>${s.lead ? `<p>${esc(s.lead)}</p>` : ''}</div>`;
    for (const q of s.questions) html += question(data, q, ++n);
    html += '</section>';
  }
  return html;
}

/** Section chips for the sticky bar. */
export function renderJump(data) {
  return data.sections.map((s) => `<a href="#sec-${esc(s.id)}" data-sec="${esc(s.id)}">${esc(s.title)}</a>`).join('');
}

export function renderCredits(data) {
  const keys = Object.keys(data.credits || {}).sort();
  const list = keys.map((k) => {
    const c = data.credits[k];
    const u = safeUrl(c.page);
    return `${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">` : ''}${esc(c.artist || k)} (${esc(c.license)})${u ? '</a>' : ''}`;
  }).join(', ');
  return "<p>Bilgiler sekiz uzman ajanın 30 Eylül 2026 tarihli araştırmasından. Fiyatlar 2026 fiyatları ya da o günkü teklifler; Mart 2027 saatleri ve fiyatları Ocak–Şubat 2027'de yeniden doğrulanmalı.</p>"
    + `<p>Fotoğraflar Wikimedia Commons'tan, serbest lisanslı: ${list}.</p>`;
}

export function renderSummaryItems(items) {
  return items
    .map((i) => `<li><span class="k">${esc(i.title)}</span><span class="v${i.text ? '' : ' empty'}">${i.text ? esc(i.text) : 'Henüz seçilmedi'}</span></li>`)
    .join('');
}
