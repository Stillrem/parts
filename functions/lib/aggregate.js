// functions/lib/aggregate.js
import { sources } from './sources.js';
import httpGet from './http_get.js';
import * as cheerio from 'cheerio';

/* ---------- helpers ---------- */

// Построение JPEG для Sears по PN (Scene7/Adobe)
function searsImageFromPN(
  pn,
  { wid = 285, hei = 200, qlt = 90, sharpen = 2 } = {}
) {
  pn = String(pn || '').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}

// Нормализация ссылки Sears: если og:image без параметров — добавим их
function normalizeSearsImage(u) {
  try {
    const url = new URL(u);
    if (url.hostname !== 's.sears.com') return u;
    const hasSize =
      url.searchParams.has('wid') ||
      url.searchParams.has('w') ||
      url.searchParams.has('hei') ||
      url.searchParams.has('h') ||
      url.searchParams.has('fmt');
    if (!hasSize) {
      url.searchParams.set('wid', '285');
      url.searchParams.set('hei', '200');
      url.searchParams.set('fmt', 'pjpg');
      url.searchParams.set('qlt', '90');
      url.searchParams.set('op_sharpen', '2');
      return url.toString();
    }
    return u;
  } catch {
    return u;
  }
}

// Прокси картинок через свой домен, чтобы не упереться в CSP/браузер
function proxyImage(u) {
  if (!u) return '';
  if (u.startsWith('/api/img?u=')) return u; // уже проксировано
  let host = '';
  try { host = new URL(u).hostname; } catch { return u; }
  const ALLOW = new Set([
    's.sears.com',
    'www.repairclinic.com',
    'rcappliancepartsimages.com'
  ]);
  if (!ALLOW.has(host)) return u;
  return `/api/img?u=${encodeURIComponent(u)}`;
}

// Узнаём, «наша» ли картинка, построенная из PN (то, что нужно пере-проверить по og:image)
const BUILT_SEARS_PN_IMG = /https?:\/\/s\.sears\.com\/is\/image\/Sears\/PD_0022_628_\d+\b/i;

/* ---------- main ---------- */

export async function aggregate(q) {
  const started = Date.now();
  const results = await Promise.allSettled(sources.map((s) => fetchAndParse(s, q)));

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
  const clean = items.filter((it) => {
    if (!it.url) return false;
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  /* ---------- постобработка изображений ---------- */

  // 1) Sears: если нет картинки ИЛИ она «словесная» (старый баг) — строим по PN
  const BAD_SEARS_IMG = /PD_0022_628_(KENMORE|CROSLEY|MICROWAVE|WHITE-WESTINGHOUSE|LATCH)\b/i;

  for (const it of clean) {
    if (it.supplier !== 'SearsPartsDirect') continue;
    const pnMatch = String(it.part_number || '').match(/\d{7,}/);
    const pn = pnMatch ? pnMatch[0] : '';
    const missing = !it.image;
    const bad = it.image && BAD_SEARS_IMG.test(it.image);
    if (pn && (missing || bad)) {
      it.image = searsImageFromPN(pn);
    }
  }

// 2) Sears: если картинка ПУСТАЯ ИЛИ это «наша, построенная по PN»,
//    делаем запрос на PDP и пытаемся достать реальную картинку,
//    проверяя og:image, <img>, srcset, а при необходимости — PN из тела HTML.
const toFetchPDP = [];
for (const it of clean) {
  if (it.supplier !== 'SearsPartsDirect') continue;
  if (!it.url) continue;
  if (!it.image || BUILT_SEARS_PN_IMG.test(String(it.image))) {
    toFetchPDP.push(it);
    if (toFetchPDP.length >= 16) break; // разумный лимит на запрос
  }
}

await Promise.allSettled(
  toFetchPDP.map(async (it) => {
    try {
      const html = await httpGet(it.url, {
        Referer: 'https://www.searspartsdirect.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      });

      const $ = cheerio.load(html);

      // 1) og:image
      let found =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="og:image"]').attr('content') || '';

      // 2) любые IMG/SOURCE, ведущие на s.sears.com/is/image/Sears/PD_0022_628_*
      if (!found) {
        $('img,source').each((_, el) => {
          if (found) return;
          const cand =
            el.attribs?.srcset ||
            el.attribs?.['data-srcset'] ||
            el.attribs?.src ||
            el.attribs?.['data-src'] ||
            '';
          const m = String(cand).match(/https?:\/\/s\.sears\.com\/is\/image\/Sears\/PD_0022_628_[^?\s,]+/i);
          if (m) found = m[0];
        });
      }

      // 3) Последняя страховка: PN из тела HTML -> построим URL сами
      if (!found) {
        const m = String(html).match(/PD_0022_628_(\d{7,})/i);
        if (m && m[1]) {
          found = searsImageFromPN(m[1]); // построим JPEG с размерами
        }
      }

      if (found) {
        // нормализуем размеры, если в og:image их нет
        found = normalizeSearsImage(found);
        it.image = found;
      }
    } catch {
      // тихо пропускаем
    }
  })
);

  // 3) Проксируем Sears/RC картинки через /api/img
  for (const it of clean) {
    if (it.image) it.image = proxyImage(it.image);
  }

  return { items: clean, meta };
}

/* ---------- utils ---------- */

async function fetchAndParse(src, q) {
  const url = src.searchUrl(q);
  const html = await httpGet(url, { Referer: url.split('/').slice(0, 3).join('/') + '/' });
  return await src.parser(html, q);
}
