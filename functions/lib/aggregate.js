// functions/lib/aggregate.js
import { sources } from './sources.js';
import httpGet from './http_get.js';
import * as cheerio from 'cheerio';

/* ---------- helpers (картинки) ---------- */

// JPEG для Sears по PN (Scene7/Adobe)
function searsImageFromPN(
  pn,
  { wid = 285, hei = 200, qlt = 90, sharpen = 2 } = {}
) {
  pn = String(pn || '').trim();
  if (!pn) return '';
  return `https://s.sears.com/is/image/Sears/PD_0022_628_${pn}?wid=${wid}&hei=${hei}&fmt=pjpg&qlt=${qlt}&op_sharpen=${sharpen}`;
}

// Иллюстрация Sears по PN (когда обычного фото нет)
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

// Прокси изображений через свой домен (чтобы не блочились)
function proxyImage(u) {
  if (!u) return '';
  if (u.startsWith('/api/img?u=')) return u; // уже проксировано
  let host = '';
  try { host = new URL(u).hostname; } catch { return u; }
  const ALLOW = new Set(['s.sears.com','www.repairclinic.com','rcappliancepartsimages.com']);
  if (!ALLOW.has(host)) return u;
  return `/api/img?u=${encodeURIComponent(u)}`;
}

// «Наша» PN-картинка (чтобы понять, что она построена из PN, а не реальная)
const BUILT_SEARS_PN_IMG = /https?:\/\/s\.sears\.com\/is\/image\/Sears\/PD_0022_628_\d+\b/i;

// Универсальный поиск картинки в HTML: og:image -> img/source -> PN Sears
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

/* ---------- helpers (previous part numbers) ---------- */

// Ищем «Previous part numbers» ТОЛЬКО в соответствующем блоке.
// Никаких «Frequently bought together» и т.п.
function extractPrevNumbersFromSears(html, currentPN) {
  const $ = cheerio.load(html);

  // На странице заголовок блока всегда именно такой
  const header = $('div.tw-text-2md.tw-font-semibold').filter((_, el) => {
    return $(el).text().trim().toLowerCase() === 'previous part numbers';
  }).first();

  if (!header.length) return [];

  // Блок со списком — ближайший следующий контейнер
  const container = header.parent();
  const text = container.text();

  // Забираем только «Part #ddddddd» из этого блока
  const rx = /Part\s*#\s*(\d{7,})/gi;
  const set = new Set();
  let m;
  while ((m = rx.exec(text))) {
    const pn = m[1];
    if (pn && pn !== currentPN) set.add(pn);
  }
  return Array.from(set);
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
          // добавим поле для «предыдущих» PN — пока пустое
          prev_numbers: Array.isArray(x.prev_numbers) ? x.prev_numbers : []
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

  /* ---------- постобработка изображений (как в «рабочем» билде) ---------- */

  // 1) Sears: если нет картинки ИЛИ она «словесная» — строим по PN
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

  // 2) Догруз с PDP для Sears и RepairClinic (если пусто или «наша по PN»)
  const MAX_PDP = 16; // консервативно (как было стабильно)
  const toFetchPDP = [];
  for (const it of clean) {
    if (!it.url) continue;
    const isSears = it.supplier === 'SearsPartsDirect';
    const isRC    = it.supplier === 'RepairClinic';
    if (isSears && (!it.image || BUILT_SEARS_PN_IMG.test(String(it.image)))) {
      toFetchPDP.push(it);
    }
    if (isRC && !it.image) {
      toFetchPDP.push(it);
    }
    if (toFetchPDP.length >= MAX_PDP) break;
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

        // === Новое: достаём Previous part numbers строго из их секции ===
        if (it.supplier === 'SearsPartsDirect') {
          const currentPN = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
          const prev = extractPrevNumbersFromSears(html, currentPN);
          if (prev.length) it.prev_numbers = prev;
        }
      } catch {
        // пропускаем
      }
    })
  );

  // 2b) Если осталась «наша PN-картинка», а на CDN её нет — ставим _Illustration
  for (const it of clean) {
    if (it.supplier !== 'SearsPartsDirect') continue;
    if (!BUILT_SEARS_PN_IMG.test(String(it.image || ''))) continue;
    const pn = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
    if (!pn) continue;
    try {
      const testUrl = searsImageFromPN(pn);
      const resp = await fetch(testUrl, { method: 'HEAD' });
      if (!resp.ok) it.image = searsIllustrationFromPN(pn);
    } catch {
      it.image = searsIllustrationFromPN(pn);
    }
  }

  // 3) Проксируем Sears/RC картинки через /api/img (как было)
  for (const it of clean) {
    if (it.image) it.image = proxyImage(it.image);

    // Добавим «Previous part numbers» в заголовок КРАСИВО, если они есть
    if (it.prev_numbers?.length) {
      const pn = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
      const prevText = ' — Previous part numbers: ' + it.prev_numbers.map(x => `#${x}`).join(', ');
      // показываем Part #текущий сразу после названия, prev — после тире
      if (pn && !/Part\s*#\d{7,}/i.test(it.name)) {
        it.name = `${it.name} Part #${pn}${prevText}`;
      } else {
        it.name = `${it.name}${prevText}`;
      }
    } else {
      // хотя бы текущий Part # аккуратно добавим, если его нет в названии
      const pn = (String(it.part_number || '').match(/\d{7,}/) || [])[0] || '';
      if (pn && it.name && !/Part\s*#\d{7,}/i.test(it.name)) {
        it.name = `${it.name} Part #${pn}`;
      }
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
