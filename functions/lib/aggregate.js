// functions/lib/aggregate.js
import { sources } from './sources.js';
import httpGet from './http_get.js';

// Строим картинку Sears по PN (Scene7 формат — стабильный JPEG)
function searsImageFromPN(pn, { wid = 285, hei = 200, qlt = 90, sharpen = 2 } = {}) {
  pn = String(pn || '').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}

// Оборачиваем «разрешённые» внешние картинки через собственный прокси
function proxyImage(u) {
  if (!u) return '';
  let host = '';
  try { host = new URL(u).hostname; } catch { return u; }
  const ALLOW = new Set(['s.sears.com','www.repairclinic.com','rcappliancepartsimages.com']);
  if (!ALLOW.has(host)) return u;       // чужие домены не трогаем
  return `/api/img?u=${encodeURIComponent(u)}`;
}

export async function aggregate(q) {
  const started = Date.now();
  const results = await Promise.allSettled(sources.map(s => fetchAndParse(s, q)));

  const items = [];
  const meta = { took_ms: Date.now() - started, sources: [] };

  for (let i = 0; i < results.length; i++) {
    const name = sources[i].name;
    const r = results[i];
    if (r.status === 'fulfilled') {
      const arr = Array.isArray(r.value) ? r.value : [];
      meta.sources.push({ name, ok: true, count: arr.length });
      for (const x of arr) {
        items.push({
          supplier: name,
          name: x.title || x.name || '',
          url: x.link || x.url || '',
          image: x.image || '',
          price: x.price || '',
          currency: x.currency || '',
          part_number: x.part_number || '',
          availability: x.availability || '',
          oem_flag: x.oem_flag || false
        });
      }
    } else {
      meta.sources.push({ name, ok: false, error: String(r.reason?.message || r.reason) });
      console.warn('[aggregate] failed for', name, r.reason?.message || r.reason);
    }
  }

  // де-дуп по URL
  const seen = new Set();
  const clean = items.filter(it => {
    if (!it.url) return false;
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  // 1) Sears: если нет картинки — строим по PN (гарантированное фото)
  for (const it of clean) {
    if (!it.image && it.supplier === 'SearsPartsDirect' && it.part_number) {
      it.image = searsImageFromPN(it.part_number);
    }
  }

  // 2) Все Sears/RC картинки заворачиваем через наш прокси
  for (const it of clean) {
    if (it.image) it.image = proxyImage(it.image);
  }

  return { items: clean, meta };
}

async function fetchAndParse(src, q) {
  const url = src.searchUrl(q);
  const html = await httpGet(url, { 'Referer': url.split('/').slice(0,3).join('/') + '/' });
  return await src.parser(html, q);
}
