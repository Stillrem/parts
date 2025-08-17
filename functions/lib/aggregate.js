// functions/lib/aggregate.js
import { sources } from './sources.js';
import httpGet from './http_get.js';
import * as cheerio from 'cheerio';

/* ---------- helpers for images ---------- */

// JPEG для Sears по PN (Scene7/Adobe)
function searsImageFromPN(
  pn,
  { wid = 285, hei = 200, qlt = 90, sharpen = 2 } = {}
) {
  pn = String(pn || '').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}

// Заворачиваем внешние картинки в свой прокси /api/img (чтобы не упираться в CSP/3rd-party)
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

/* ---------- main ---------- */

export async function aggregate(q) {
  const started = Date.now();

  // запускаем все источники параллельно
  const results = await Promise.allSettled(
    sources.map((s) => fetchAndParse(s, q))
  );

  const items = [];
  const meta = { took_ms: Date.now() - started, sources: [] };

  // собираем результаты
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
      meta.sources.push({
        name,
        ok: false,
        error: String(r.reason?.message || r.reason)
      });
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

  // 1) Sears: если нет картинки ИЛИ она "битая" (собрана из слов), строим по PN
  const BAD_SEARS_IMG =
    /PD_0022_628_(KENMORE|CROSLEY|MICROWAVE|WHITE-WESTINGHOUSE|LATCH)\b/i;

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

  // 2) Точечный догруз для Sears: если после шага (1) фото всё ещё нет — берём og:image с PDP
  const needsPDP = clean.filter(
    (it) => it.supplier === 'SearsPartsDirect' && !it.image && it.url
  );

  for (const it of needsPDP) {
    try {
      const html = await httpGet(it.url, {
        Referer: 'https://www.searspartsdirect.com/'
      });
      const $ = cheerio.load(html);
      const og = $('meta[property="og:image"]').attr('content') || '';
      if (og) it.image = og;
    } catch {
      // тихо пропускаем, если не удалось
    }
  }

  // 3) Проксируем Sears/RC картинки через /api/img
  for (const it of clean) {
    if (it.image) it.image = proxyImage(it.image);
  }

  return { items: clean, meta };
}

/* ---------- utils ---------- */

async function fetchAndParse(src, q) {
  const url = src.searchUrl(q);
  const html = await httpGet(url, {
    Referer: url.split('/').slice(0, 3).join('/') + '/'
  });
  return await src.parser(html, q);
}
