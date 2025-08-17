// functions/lib/sources.js
import * as cheerio from 'cheerio';

/* ===== базовые утилиты (внутренние; другие файлы их не используют) ===== */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

async function fetchHTML(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...extraHeaders
    }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' on ' + url);
  return await res.text();
}

function pn(s = '') {
  const m = String(s).match(/[A-Z0-9-]{5,}/i);
  return m ? m[0].toUpperCase() : '';
}

// разворачиваем Next.js-оптимизатор: /_next/image?url=<ENCODED>&w=...&q=...
function unwrapNextImage(src) {
  if (!src) return '';
  try {
    const u = new URL(src, 'https://dummy.base'); // чтобы парсить относительный /_next/image
    if (u.pathname.includes('/_next/image') && u.searchParams.has('url')) {
      const original = u.searchParams.get('url');
      return decodeURIComponent(original || '');
    }
  } catch {}
  return src;
}

function absolutize(src, base) {
  if (!src) return '';
  src = String(src).trim();
  if (!src) return '';
  // сперва разворачиваем /_next/image
  src = unwrapNextImage(src);
  if (src.startsWith('//')) return 'https:' + src;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) {
    try {
      const u = new URL(base);
      return u.origin + src;
    } catch {
      return src;
    }
  }
  // если это srcset: берем первый URL
  if (/\s+\d+x(?:,|$)/.test(src)) {
    const first = src.split(',')[0].trim().split(' ')[0].trim();
    return absolutize(first, base);
  }
  return src;
}

function firstNonEmpty(...vals) {
  for (const v of vals) if (v && String(v).trim()) return String(v).trim();
  return '';
}

/* Sears: брать product-thumb с CDN s.sears.com; если нет — обычный src */
function pickSearsThumb($ctx) {
  const BASE = 'https://www.searspartsdirect.com';

  // 1) пробуем прямой src первого <img>
  let img = $ctx.find('img').attr('src') || '';
  img = absolutize(img, BASE);
  if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(img)) return img;

  // 2) ищем любую <img> с CDN Sears внутри карточки
  $ctx.find('img').each((_, el) => {
    const raw =
      el.attribs?.src ||
      el.attribs?.['data-src'] ||
      el.attribs?.srcset ||
      '';
    const abs = absolutize(raw, BASE);
    if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)) {
      img = abs;
      return false; // break
    }
  });
  return img || '';
}

/* ===== источники ===== */

/** RepairClinic: плитки + корректные картинки (разворачиваем /_next/image) */
export async function fromRepairClinic(q) {
  const BASE = 'https://www.repairclinic.com';
  const url = `${BASE}/Shop-For-Parts?query=${encodeURIComponent(q)}`;

  const items = [];
  try {
    const html = await fetchHTML(url, { Referer: BASE + '/' });
    const $ = cheerio.load(html);

    const tiles = $([
      '[data-qa="product-tile"]',
      '[data-automation-id="product-tile"]',
      '.product-card',
      '.product-tile',
      '.search-results__grid-item',
      '.product-grid__item'
    ].join(','));

    tiles.each((_, el) => {
      const el$ = $(el);
      const a$  = el$.find('a[href]').first();
      let href  = (a$.attr('href') || '').trim();
      if (!href) return;
      if (href.startsWith('/')) href = BASE + href;

      const name = firstNonEmpty(
        el$.find('[data-qa="product-title"]').text(),
        el$.find('.product-title').text(),
        a$.attr('title'),
        el$.text()
      ).replace(/\s+/g, ' ').trim();

      // IMG: data-* / srcset / src → разворачиваем /_next/image → абсолютный URL
      let imgRaw =
        el$.find('img').attr('data-src') ||
        el$.find('img').attr('data-original') ||
        el$.find('img').attr('data-srcset') ||
        el$.find('img').attr('srcset') ||
        el$.find('img').attr('src') ||
        '';
      const image = absolutize(imgRaw, BASE);

      items.push({
        supplier: 'RepairClinic',
        name,
        url: href,
        image,
        price: '',
        currency: '',
        part_number: pn(name)
      });
    });

    // если плитки есть — возвращаем их; если нет — упадём в фолбэк ниже
    if (items.length) return items.slice(0, 80);
  } catch {
    /* если анти-бот — пойдём в фолбэк */
  }

  // Фолбэк (анти-бот): всегда отдаём кликабельную ссылку на поиск
  return [{
    supplier: 'RepairClinic',
    name: `Открыть поиск на RepairClinic для: ${q}`,
    url: url,
    image: '',
    price: '',
    currency: '',
    part_number: pn(q)
  }];
}

/** SearsPartsDirect: детали/товары + корректные миниатюры с s.sears.com; по моделям — Shop parts */
export async function fromSears(q) {
  const BASE = 'https://www.searspartsdirect.com';
  const url  = `${BASE}/search?q=${encodeURIComponent(q)}`;

  const html = await fetchHTML(url, { Referer: BASE + '/' });
  const $ = cheerio.load(html);
  const items = [];

  // 1) Детали/товары прямо со страницы поиска
  $('.part-card, .product-card, .card, [data-component="product-card"], a[href*="/part/"], a[href*="/product/"]').each((_, el) => {
    const el$ = $(el);
    const a$  = el$.is('a') ? el$ : el$.find('a[href]').first();
    let href  = (a$.attr('href') || '').trim();
    if (!/\/part\/|\/product\//i.test(href || '')) return;

    if (href.startsWith('/')) href = BASE + href;

    const name = firstNonEmpty(
      el$.find('.card-title').text(),
      el$.find('.product-title').text(),
      el$.text()
    ).replace(/\s+/g, ' ').trim();

    const image = pickSearsThumb(el$); // берём именно CDN Sears

    items.push({
      supplier: 'SearsPartsDirect',
      name,
      url: href,
      image,
      price: '',
      currency: '',
      part_number: pn(name)
    });
  });

  if (items.length) return items;

  // 2) Фолбэк по МОДЕЛЯМ: карточки «Shop parts»
  $('.card, .product-card, [data-component="product-card"]').each((_, el) => {
    const el$ = $(el);
    const a$  = el$.find('a[href]').first();
    let href  = (a$.attr('href') || '').trim();
    if (!/\/model\//i.test(href || '')) return;

    // кнопка Shop parts (если есть)
    let shop = '';
    el$.find('a[href]').each((_, x) => {
      const t = $(x).text().trim().toLowerCase();
      const h = $(x).attr('href') || '';
      if (/shop\s*parts/i.test(t) && h) shop = h;
    });

    const link  = shop || href;
    const abs   = link.startsWith('/') ? (BASE + link) : link;
    const image = pickSearsThumb(el$);
    const name  = el$.text().replace(/\s+/g, ' ').trim();

    items.push({
      supplier: 'SearsPartsDirect',
      name,
      url: abs,
      image,
      price: '',
      currency: '',
      part_number: pn(name)
    });
  });

  return items;
}
