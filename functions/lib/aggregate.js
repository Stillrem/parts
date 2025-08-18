// functions/lib/aggregate.js
import { sources } from './sources.js';
import httpGet from './http_get.js';
import * as cheerio from 'cheerio';

/* ---------- helpers ---------- */

// JPEG для Sears по PN (Scene7/Adobe)
function searsImageFromPN(
  pn,
  { wid = 285, hei = 200, qlt = 90, sharpen = 2 } = {}
) {
  pn = String(pn || '').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}

// Иллюстрация Sears по PN (когда основного фото нет)
function searsIllustrationFromPN(
  pn,
  { wid = 285, hei = 200, qlt = 90, sharpen = 2 } = {}
) {
  pn = String(pn || '').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}_Illustration?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}

// Если og:image у Sears без параметров — добавим тип/размер
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
  } catch { return u; }
}

// Нормализация картинок RepairClinic (относительные → абсолютные)
function normalizeRCImage(u) {
  try { return new URL(u, 'https://www.repairclinic.com').toString(); }
  catch { return u; }
}

// Прокси изображений через свой домен
function proxyImage(u) {
  if (!u) return '';
  if (u.startsWith('/api/img?u=')) return u; // уже проксировано
  let host = '';
  try { host = new URL(u).hostname; } catch { return u; }
  const ALLOW = new Set(['s.sears.com','www.repairclinic.com','rcappliancepartsimages.com']);
  if (!ALLOW.has(host)) return u;
  return `/api/img?u=${encodeURIComponent(u)}`;
}

// «Наша» PN-картинка (чтобы понять, что нужно перепроверить на PDP/HEAD)
const BUILT_SEARS_PN_IMG = /https?:\/\/s\.sears\.com\/is\/image\/Sears\/PD_0022_628_\d+\b/i;

// Универсальный поиск картинки в HTML
function findAnyImageFromHtml(html, baseHost) {
  const $ = cheerio.load(html);
  let found = $('meta[property="og:image"],meta[name="og:image"]').attr('content') || '';

  if (!found) {
    $('img,source').each((_, el) => {
      if (found) return;
      const cand = el.attribs?.srcset || el.attribs?.['data-srcset'] ||
                   el.attribs?.src    || el.attribs?.['data-src']    || '';
      const m = String(cand).match(/https?:\/\/[^?\s,]+/);
      if (m) found = m[0];
    });
  }

  if (!found) {
    const m = String(html).match(/https?:\/\/s\.sears\.com\/is\/image\/Sears\/PD_0022_628_(\d{7,})/i);
    if (m && m[1]) found = searsImageFromPN(m[1]);
  }

  if (!found) return '';
  try { return new URL(found, `https://${baseHost}`).toString(); }
  catch { return found; }
}

/* ---------- мапа «PN детали → PN картинки» (точечно) ---------- */
const SEARS_IMG_PN_REDIRECT = {
  '5304509475': '5304464094', // Kenmore Elite Microwave Thermal Cut-off
  '5304509458': '5304464097', // Crosley Microwave Door Interlock Switch Lever
  '5304509459': '5304464098'  // Kenmore Elite Microwave Door Interlock Switch
};
/* ---------------------------------------------------------------- */

/* ---------- Previous part numbers (только из блока на Sears PDP) ---------- */
function extractPrevNumbersFromSears(html, currentPN) {
  const $ = cheerio.load(html);

  let $hdr = $('*:contains("Previous part numbers")').filter((_, el) =>
    $(el).text().trim().toLowerCase() === 'previous part numbers'
  ).first();
  if (!$hdr.length) return [];

  const containers = [$hdr.next(), $hdr.parent(), $hdr.parent().next()].filter(Boolean);

  let textBlock = '';
  for (const $c of containers) {
    const t = $c.text().trim();
    if (t && /part\s*#\s*\d{7,}/i.test(t)) { textBlock = t; break; }
  }
  if (!textBlock) {
    const raw = String(html);
    const i = raw.toLowerCase().indexOf('previous part numbers');
    if (i > -1) textBlock = raw.slice(i, i + 2000);
  }
  if (!textBlock) return [];

  const rx = /Part\s*#\s*(\d{7,})/gi;
  const set = new Set();
  let m;
  while ((m = rx.exec(textBlock))) {
    const pn = m[1];
    if (pn && pn !== currentPN) set.add(pn);
  }
  return Array.from(set);
}

/* ---------- Sears: заголовок модели («Model # ...») ---------- */
function extractSearsModelTitle(html) {
  const $ = cheerio.load(html);

  // 1) Берём только H1/H2 и ищем в них “Model # …”
  let title = '';
  $('h1, h2').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (/Model\s*#\s*[A-Z0-9\-]+/i.test(t) && t.length < 140) {
      title = t;
      return false; // break
    }
  });
  if (title) {
    return title.replace(/\bOfficial\b/ig, '').replace(/\s{2,}/g, ' ').trim();
  }

  // 2) fallback: строго H1 c “Model #”
  const m = String(html).match(/<h1[^>]*>\s*([^<]*Model\s*#\s*[^<]+?)\s*<\/h1>/i);
  if (m && m[1]) {
    return m[1].replace(/\bOfficial\b/ig, '').replace(/\s{2,}/g, ' ').trim();
  }
  return '';
}

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
          oem_flag: x.oem_flag || false,
          part_label: x.part_number ? `Part #${x.part_number}` : ''
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

  // 1) Sears: если нет картинки ИЛИ «словесная» — строим по PN (с редиректом)
  const BAD_SEARS_IMG = /PD_0022_628_(KENMORE|CROSLEY|MICROWAVE|WHITE-WESTINGHOUSE|LATCH)\b/i;
  for (const it of clean) {
    if (it.supplier !== 'SearsPartsDirect') continue;
    const pnMatch = String(it.part_number || '').match(/\d{7,}/);
    const pn = pnMatch ? pnMatch[0] : '';
    const missing = !it.image;
    const bad = it.image && BAD_SEARS_IMG.test(it.image);
    if (pn && (missing || bad)) {
      const imgPN = SEARS_IMG_PN_REDIRECT[pn] || pn;
      it.image = searsImageFromPN(imgPN);
    }
  }

  // 2) Догруз с PDP для Sears и RepairClinic
  const toFetchPDP = [];
  for (const it of clean) {
    if (!it.url) continue;
    const isSears = it.supplier === 'SearsPartsDirect';
    const isRC    = it.supplier === 'RepairClinic';

    const hasNumericPN = /\d{7,}/.test(String(it.part_number || ''));
    if (isSears && ( !it.image || BUILT_SEARS_PN_IMG.test(String(it.image)) || !hasNumericPN )) {
      toFetchPDP.push(it);
    }
    if (isRC && !it.image) {
      toFetchPDP.push(it);
    }
    if (toFetchPDP.length >= 30) break;
  }

  await Promise.allSettled(
    toFetchPDP.map(async (it) => {
      try {
        const html = await httpGet(it.url, {
          Referer: it.url.split('/').slice(0, 3).join('/') + '/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        });

        const host = new URL(it.url).hostname;
        let img = findAnyImageFromHtml(html, host);

        if (img) {
          if (host.includes('searspartsdirect.com')) img = normalizeSearsImage(img);
          if (host.includes('repairclinic.com'))      img = normalizeRCImage(img);
          it.image = img;
        }

        // Sears: Previous part numbers
        if (it.supplier === 'SearsPartsDirect') {
          const currentPN = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
          const prev = extractPrevNumbersFromSears(html, currentPN);
          if (prev.length) {
            it.previous_part_numbers = prev;
            if (!/previous part numbers/i.test(it.name || '')) {
              it.name = `${it.name} — Previous part numbers: ${prev.map(p => `#${p}`).join(', ')}`;
            }
          }

          // Sears: если это страница модели — подменим имя на «Model # ...»
          const modelTitle = extractSearsModelTitle(html);
          if (modelTitle) {
            it.name = modelTitle;
          }
        }
      } catch {
        // пропускаем
      }
    })
  );

  // 2c) Sears: если картинка «по PN» и её нет на CDN — используем _Illustration
  async function checkSearsAndMaybeIllustration(it) {
    const rawPN = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
    const pn = SEARS_IMG_PN_REDIRECT[rawPN] || rawPN;
    if (!pn) return;
    if (!BUILT_SEARS_PN_IMG.test(String(it.image || ''))) return;
    try {
      const testUrl = searsImageFromPN(pn, { wid: 285, hei: 200, qlt: 90, sharpen: 2 });
      const resp = await fetch(testUrl, { method: 'HEAD' });
      if (!resp.ok) {
        it.image = searsIllustrationFromPN(pn, { wid: 285, hei: 200, qlt: 90, sharpen: 2 });
      }
    } catch {
      it.image = searsIllustrationFromPN(pn, { wid: 285, hei: 200, qlt: 90, sharpen: 2 });
    }
  }
  {
    const candidates = [];
    for (const it of clean) {
      if (it.supplier === 'SearsPartsDirect' && BUILT_SEARS_PN_IMG.test(String(it.image || ''))) {
        candidates.push(it);
        if (candidates.length >= 30) break;
      }
    }
    await Promise.allSettled(candidates.map(checkSearsAndMaybeIllustration));
  }

  // 3) Проксируем изображения
  for (const it of clean) {
    if (it.image) it.image = proxyImage(it.image);
  }

  // 4) Дописываем "Part #..." только если PN числовой
  for (const it of clean) {
    const pnDigits = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
    if (pnDigits && !/Part\s*#\d{7,}/i.test(it.name || '')) {
      it.name = `${it.name} Part #${pnDigits}`;
    }
  }

  return { items: clean, meta };
}

/* ---------- utils ---------- */

async function fetchAndParse(src, q) {
  const url = src.searchUrl(q);
  const html = await httpGet(url, { Referer: url.split('/').slice(0, 3).join('/') + '/' });
  return await src.parser(html, q);
}
