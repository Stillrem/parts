import * as cheerio from 'cheerio';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

/* -------------------- базовые утилиты -------------------- */
async function fetchHTML(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' on ' + url);
  return await res.text();
}

function money(text = '') {
  let m = text.match(/([$€£])\s?(\d[\d,]*(?:\.\d{1,2})?)/);
  if (m) return { price: m[2], currency: { '$': 'USD', '€': 'EUR', '£': 'GBP' }[m[1]] || '' };
  m = text.match(/(\d[\d,]*(?:\.\d{1,2})?)\s?(USD|EUR|GBP)/i);
  if (m) return { price: m[1], currency: m[2].toUpperCase() };
  return { price: '', currency: '' };
}

function pn(s = '') {
  const m = String(s).match(/[A-Z0-9-]{5,}/i);
  return m ? m[0].toUpperCase() : '';
}

/* -------------------- картинки -------------------- */
// разворачиваем Next.js /_next/image?url=...
function unwrapNextImage(src) {
  if (!src) return '';
  try {
    const u = new URL(src, 'https://dummy.base');
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
  // srcset "… 1x, … 2x" — берём первый URL
  if (/\s+\d+x(?:,|$)/.test(src)) {
    const first = src.split(',')[0].trim().split(' ')[0].trim();
    return absolutize(first, base);
  }
  return src;
}

function pickImg($ctx, base) {
  const img = $ctx && ($ctx.is('img') ? $ctx : $ctx.find('img').first());
  if (img && img.length) {
    const cand =
      img.attr('data-src') ||
      img.attr('data-original') ||
      img.attr('data-srcset') ||
      img.attr('srcset') ||
      img.attr('src');
    const abs = absolutize(cand, base);
    if (abs) return abs;
  }
  // background-image
  const style = ($ctx?.attr('style') || '') + ' ' + ($ctx?.find('[style]').first().attr('style') || '');
  const m = style.match(/url\((['"]?)(.+?)\1\)/i);
  if (m && m[2]) return absolutize(m[2], base);
  return '';
}

/* Sears: брать только product-thumb с CDN s.sears.com, по возможности тот, где есть part number */
function pickSearsThumb($ctx, q) {
  const BASE = 'https://www.searspartsdirect.com';
  const pnMatch = String(q || '').match(/[A-Z0-9-]{5,}/i);
  const pnum = pnMatch ? pnMatch[0].toUpperCase() : '';

  const candidates = [];
  $ctx.find('img').each((_, img) => {
    const $img = cheerio(img);
    const raw =
      $img.attr('data-src') || $img.attr('data-original') || $img.attr('data-srcset') || $img.attr('srcset') || $img.attr('src') || '';
    const url = absolutize(raw, BASE);
    if (/s\.sears\.com\/is\/image\/Sears\//i.test(url)) candidates.push(url);
  });

  if (!candidates.length) return pickImg($ctx, BASE);
  if (pnum) {
    const hit = candidates.find((u) => u.toUpperCase().includes(pnum));
    if (hit) return hit;
  }
  return candidates[0];
}

/* дотягивание фото со страницы детали (og:image), с «браузерными» заголовками */
async function enrichImages(items, maxFetch = 8) {
  let done = 0;
  for (const it of items) {
    if (done >= maxFetch) break;
    if (it.image) continue;
    if (!it.url) continue;
    try {
      const base = it.url.split('/').slice(0, 3).join('/');
      const html = await fetchHTML(it.url, { Referer: base + '/' });
      const $ = cheerio.load(html);
      const og = $('meta[property="og:image"]').attr('content') || '';
      const firstImg = $('img').first().attr('src') || '';
      const cand = og || firstImg;
      if (cand) {
        it.image = absolutize(cand, base);
        done++;
      }
    } catch {
      /* ignore */
    }
  }
  return items;
}

/* -------------------- RepairClinic -------------------- */
/* Если анти-бот — возвращаем ссылку на поиск (без фото).
   Если плитки есть — берём картинку (включая /_next/image) и дотягиваем og:image. */
export async function fromRepairClinic(q) {
  const BASE = 'https://www.repairclinic.com';
  const url = `${BASE}/Shop-For-Parts?query=${encodeURIComponent(q)}`;

  let items = [];
  try {
    const html = await fetchHTML(url, { Referer: BASE + '/' });
    const $ = cheerio.load(html);

    const tileSel = [
      '[data-qa="product-tile"]',
      '[data-automation-id="product-tile"]',
      '.search-results__grid-item',
      '.product-grid__item',
      '.product-tile',
    ].join(',');

    $(tileSel).each((_, el) => {
      const el$ = $(el);
      const a$ = el$.find('a[href]').first();
      const name =
        (el$.find('[data-qa="product-title"], .product-title, a[title]').first().text() ||
          a$.attr('title') ||
          el$.text())
          .trim()
          .replace(/\s+/g, ' ');
      let href = (a$.attr('href') || '').trim();
      if (name && href) {
        if (href.startsWith('/')) href = BASE + href;
        const ptxt =
          (el$.find('[data-qa="product-price"], .price, [itemprop="price"]').first().text() || '').trim();
        const { price, currency } = money(ptxt);
        const img = pickImg(el$, BASE); // развернёт /_next/image → прямой CDN
        items.push({
          supplier: 'RepairClinic',
          name,
          url: href,
          image: img,
          price,
          currency,
          part_number: pn(name),
        });
      }
    });

    if (items.length) {
      await enrichImages(items, 6); // страховка
      return items.slice(0, 80);
    }
  } catch {
    /* ignore */
  }

  // фолбэк: ссылка на поиск (картинку тут не достать)
  return [
    {
      supplier: 'RepairClinic',
      name: `Открыть поиск на RepairClinic для: ${q}`,
      url: url,
      image: '',
      part_number: pn(q),
    },
  ];
}

/* -------------------- Sears PartsDirect -------------------- */
/* 1) С поисковой берём name+url; миниатюру — только с CDN s.sears.com (приоритет: с part number).
   2) Дотягиваем og:image со страницы детали; если не вышло — оставляем CDN-миниатюру.
   3) Если деталей нет — отдаём карточки моделей (Shop parts) и те же правила по фото. */
export async function fromSears(q) {
  const BASE = 'https://www.searspartsdirect.com';
  const searchUrl = `${BASE}/search?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(searchUrl, { Referer: BASE + '/' });
  const $ = cheerio.load(html);
  const items = [];
  const fallbackThumbs = []; // [href, thumb]

  const pushItem = (name, href, thumb = '') => {
    if (!name || !href) return;
    if (href.startsWith('/')) href = BASE + href;
    items.push({
      supplier: 'SearsPartsDirect',
      name,
      url: href,
      image: '', // заполним позже (og:image или CDN-thumb)
      price: '',
      currency: '',
      part_number: pn(name),
    });
    if (thumb) fallbackThumbs.push([href, thumb]);
  };

  // 1) Детали/товары с поисковой
  $('.card, .product-card, [data-component="product-card"], a[href*="/product/"], a[href*="/part/"]').each(
    (_, el) => {
      const el$ = $(el);
      const a$ = el$.is('a') ? el$ : el$.find('a[href]').first();
      const href = (a$.attr('href') || '').trim();
      const name = (el$.text() || a$.text()).trim().replace(/\s+/g, ' ');
      if (/\/part\/|\/product\//i.test(href || '')) {
        const thumb = pickSearsThumb(el$, q); // ⟵ только s.sears.com/is/image/Sears/...
        pushItem(name, href, thumb);
      }
    }
  );

  if (items.length) {
    // дотягиваем og:image
    await enrichImages(items, 12);
    // если у части карточек так и нет картинок — подставим CDN-миниатюры
    const thumbByHref = new Map(fallbackThumbs);
    for (const it of items) {
      if (!it.image && thumbByHref.has(it.url)) it.image = thumbByHref.get(it.url);
    }
    return items;
  }

  // 2) Фолбэк по МОДЕЛЯМ: карточки моделей (Shop parts)
  $('.card, .product-card, [data-component="product-card"]').each((_, el) => {
    const el$ = $(el);
    const a$ = el$.find('a[href]').first();
    let href = (a$.attr('href') || '').trim();
    if (!/\/model\//i.test(href || '')) return;

    // пробуем найти ссылку "Shop parts"
    let shopHref = '';
    el$.find('a[href]').each((_, x) => {
      const t = $(x).text().trim().toLowerCase();
      const h = $(x).attr('href') || '';
      if (/shop\s*parts/i.test(t) && h) shopHref = h;
    });
    const link = shopHref || href;
    const name = el$.text().trim().replace(/\s+/g, ' ');
    const thumb = pickSearsThumb(el$, q);
    pushItem(name, link, thumb);
  });

  await enrichImages(items, 8);
  const thumbByHref = new Map(fallbackThumbs);
  for (const it of items) {
    if (!it.image && thumbByHref.has(it.url)) it.image = thumbByHref.get(it.url);
  }
  return items;
}
