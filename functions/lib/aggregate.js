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

/* точечные соответствия: картинка на CDN под другим PN */
const SEARS_IMG_PN_REDIRECT = {
  '5304509475': '5304464094', // Thermal Cut-off
  '5304509458': '5304464097', // Door Interlock Switch Lever
  '5304509459': '5304464098'  // Door Interlock Switch
};

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

/* ====== КОРРЕКТНОЕ ВЫТАСКИВАНИЕ Previous part numbers ТОЛЬКО ИЗ СЕКЦИИ ====== */
function extractPrevPNsFromSearsPDP(html, currentPN='') {
  const $ = cheerio.load(html);

  // 1) найти узел, который содержит заголовок "Previous part numbers"
  let $section = null;
  $('*').each((_, el) => {
    const txt = $(el).text().trim();
    if (/^previous\s+part\s+numbers$/i.test(txt)) {
      // берём ближайший контейнер секции
      $section = $(el).closest('section,div');
      return false;
    }
    return undefined;
  });

  // 2) если нашли — соберём PN только внутри этой секции
  const set = new Set();
  const rxPN = /\b(530\d{7})\b/g;

  if ($section && $section.length) {
    const txt = $section.text();
    let m;
    while ((m = rxPN.exec(txt))) set.add(m[1]);
  } else {
    // 3) fallback по «окну» между заголовком и следующей секцией,
    // чтобы не залезть в «Customers also bought» и т.д.
    const body = String(html);
    const start = body.search(/Previous\s+part\s+numbers/i);
    if (start !== -1) {
      // до ближайшего следующего заголовка/секции
      const tail = body.slice(start, start + 5000);
      const stop = tail.search(/(This\s+Part\s+Also\s+Fits|Customers\s+also|You\s+Might\s+Also|<h\d|<\/section>|<\/div>)/i);
      const windowText = tail.slice(0, stop > 0 ? stop : 2000);
      let m;
      while ((m = rxPN.exec(windowText))) set.add(m[1]);
    }
  }

  if (currentPN) set.delete(String(currentPN));
  // максимум 6
  return Array.from(set).slice(0, 6);
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
          prev_part_numbers: x.prev_part_numbers || [],
          availability: x.availability || '',
          oem_flag: x.oem_flag || false
        });
      }
    } else {
      meta.sources.push({ name, ok: false, error: String(r.reason?.message || r.reason) });
      console.warn('[aggregate] failed for', name, r.reason?.message || r.reason);
    }
  }

  // de-dup
  const seen = new Set();
  const clean = items.filter((it) => {
    if (!it.url) return false;
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  /* ---------- images ---------- */

  const BAD_SEARS_IMG = /PD_0022_628_(KENMORE|CROSLEY|MICROWAVE|WHITE-WESTINGHOUSE|LATCH)\b/i;
  for (const it of clean) {
    if (it.supplier !== 'SearsPartsDirect') continue;
    const pnMatch = String(it.part_number || '').match(/\d{7,}/);
    const pnRaw = pnMatch ? pnMatch[0] : '';
    const pn = SEARS_IMG_PN_REDIRECT[pnRaw] || pnRaw;
    const missing = !it.image;
    const bad = it.image && BAD_SEARS_IMG.test(it.image);
    if (pn && (missing || bad)) {
      it.image = searsImageFromPN(pn);
    }
  }

  /* ---------- PDP fetch: для картинок И/ИЛИ Previous PN ---------- */
  const toFetchPDP = [];
  const MAX_PDP = 16;

  for (const it of clean) {
    if (!it.url) continue;
    const isSears = it.supplier === 'SearsPartsDirect';
    const isRC    = it.supplier === 'RepairClinic';

    const needsImage =
      (isSears && (!it.image || BUILT_SEARS_PN_IMG.test(String(it.image)))) ||
      (isRC && !it.image);

    const needsPrev = isSears && (!it.prev_part_numbers || it.prev_part_numbers.length === 0);

    if (needsImage || needsPrev) {
      toFetchPDP.push(it);
      if (toFetchPDP.length >= MAX_PDP) break;
    }
  }

  await Promise.allSettled(
    toFetchPDP.map(async (it) => {
      try {
        const html = await httpGet(it.url, {
          Referer: it.url.split('/').slice(0, 3).join('/') + '/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        });

        const host = new URL(it.url).hostname;

        // добираем картинку, если надо
        if (!it.image || BUILT_SEARS_PN_IMG.test(String(it.image))) {
          let img = findAnyImageFromHtml(html, host);
          if (!img && host.includes('searspartsdirect.com')) {
            const rawPN = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
            const imgPN = SEARS_IMG_PN_REDIRECT[rawPN] || rawPN;
            img = searsIllustrationFromPN(imgPN);
          }
          if (img) {
            if (host.includes('searspartsdirect.com')) img = normalizeSearsImage(img);
            if (host.includes('repairclinic.com'))      img = normalizeRCImage(img);
            it.image = img;
          }
        }

        // строго: Previous part numbers — только из соответствующей секции
        if (host.includes('searspartsdirect.com')) {
          const currentPN = (String(it.part_number||'').match(/\d{7,}/)||[])[0] || '';
          const prev = extractPrevPNsFromSearsPDP(html, currentPN);
          if (prev.length) {
            it.prev_part_numbers = Array.from(new Set([...(it.prev_part_numbers||[]), ...prev]));
          }
        }
      } catch { /* skip */ }
    })
  );

  // HEAD-проверка «построенных» картинок + фоллбек-иллюстрация
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
        if (candidates.length >= 16) break;
      }
    }
    await Promise.allSettled(candidates.map(checkSearsAndMaybeIllustration));
  }

  // прокси картинок
  for (const it of clean) {
    if (it.image) it.image = proxyImage(it.image);
  }

  /* ---------- финальное форматирование заголовка ---------- */
  for (const it of clean) {
    const lines = [];
    const baseName = (it.name || '').trim();
    if (baseName) lines.push(baseName);

    const currentPN = (String(it.part_number||'').match(/\d{7,}/)||[])[0] || it.part_number || '';
    if (currentPN) lines.push(`Part #${currentPN}`);

    if (it.prev_part_numbers && it.prev_part_numbers.length) {
      const prev = Array.from(new Set(
        it.prev_part_numbers
          .map(p => String(p))
          .filter(p => p !== String(currentPN) && /^530\d{7}$/.test(p))
      ));
      if (prev.length) {
        lines.push('Previous part numbers');
        prev.forEach(p => lines.push(`Part #${p}`));
      }
    }

    if (lines.length) it.name = lines.join('\n');
  }

  return { items: clean, meta };
}

/* ---------- utils ---------- */

async function fetchAndParse(src, q) {
  const url = src.searchUrl(q);
  const html = await httpGet(url, { Referer: url.split('/').slice(0, 3).join('/') + '/' });
  return await src.parser(html, q);
}
