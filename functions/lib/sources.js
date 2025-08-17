import * as cheerio from 'cheerio';

/* ---------- helpers ---------- */
function absolutize(src, base) {
  if (!src) return '';
  src = String(src).trim();
  if (!src) return '';
  if (src.startsWith('//')) return 'https:' + src;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) return base.replace(/\/$/, '') + src;
  // srcset "… 1x, … 2x" — берём первый url
  if (/\s+\d+x(?:,|$)/.test(src)) {
    const first = src.split(',')[0].trim().split(' ')[0].trim();
    return absolutize(first, base);
  }
  return src;
}

// /_next/image?url=<ENCODED>&w=... → достаём оригинал
function unwrapNextImage(src) {
  if (!src) return '';
  try {
    const u = new URL(src, 'https://dummy.base');
    if (u.pathname.includes('/_next/image') && u.searchParams.has('url')) {
      const real = u.searchParams.get('url');
      return decodeURIComponent(real || '');
    }
  } catch {}
  return src;
}

function firstNonEmpty(...vals) {
  for (const v of vals) if (v && String(v).trim()) return String(v).trim();
  return '';
}

function pn(s='') {
  const m = String(s).match(/[A-Z0-9-]{5,}/i);
  return m ? m[0].toUpperCase() : '';
}

/* Sears: брать CDN-миниатюру s.sears.com; если нет — пробуем обычный src */
function pickSearsThumb($ctx) {
  const BASE = 'https://www.searspartsdirect.com';
  let img = '';
  // сначала прямой src
  const primary = $ctx.find('img').attr('src') || '';
  if (primary) {
    const abs = absolutize(primary, BASE);
    if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)) return abs;
    img = abs;
  }
  // обойти другие <img> внутри карточки и найти CDN Sears
  $ctx.find('img').each((_, el) => {
    const raw = cheerio(el).attr('src') || cheerio(el).attr('data-src') || cheerio(el).attr('srcset') || '';
    const abs = absolutize(raw, BASE);
    if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)) {
      img = abs;
      return false; // break
    }
  });
  return img;
}

/* ---------- SOURCES ---------- */
export const sources = [
  /* SearsPartsDirect */
  {
    name: 'SearsPartsDirect',
    searchUrl: (query) => `https://www.searspartsdirect.com/search?q=${encodeURIComponent(query)}`,
    parser: async (html /*, q */) => {
      const $ = cheerio.load(html);
      const out = [];

      // карточки деталей/товаров на поиске
      $('.part-card, .product-card, .card, [data-component="product-card"], a[href*="/part/"], a[href*="/product/"]').each((_, el) => {
        const el$ = $(el);
        const a$ = el$.is('a') ? el$ : el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!/\/part\/|\/product\//i.test(href || '')) return;

        const title = firstNonEmpty(
          el$.find('.card-title').text(),
          el$.find('.product-title').text(),
          el$.text()
        ).replace(/\s+/g,' ').trim();

        const link = absolutize(href, 'https://www.searspartsdirect.com');
        const image = pickSearsThumb(el$); // берём именно CDN Sears
        out.push({ title, link, image, source: 'SearsPartsDirect', part_number: pn(title) });
      });

      // fallback по моделям (Shop parts)
      if (!out.length) {
        $('.card, .product-card, [data-component="product-card"]').each((_, el) => {
          const el$ = $(el);
          const a$ = el$.find('a[href]').first();
          const href = a$.attr('href') || '';
          if (!/\/model\//i.test(href || '')) return;

          // кнопка Shop parts (если есть)
          let shop = '';
          el$.find('a[href]').each((_, x) => {
            const t = $(x).text().trim().toLowerCase();
            const h = $(x).attr('href') || '';
            if (/shop\s*parts/i.test(t) && h) shop = h;
          });

          const title = el$.text().replace(/\s+/g,' ').trim();
          const link = absolutize(shop || href, 'https://www.searspartsdirect.com');
          const image = pickSearsThumb(el$);
          out.push({ title, link, image, source: 'SearsPartsDirect', part_number: pn(title) });
        });
      }

      return out;
    }
  },

  /* RepairClinic */
  {
    name: 'RepairClinic',
    searchUrl: (query) => `https://www.repairclinic.com/Shop-For-Parts?query=${encodeURIComponent(query)}`,
    parser: async (html /*, q */) => {
      const $ = cheerio.load(html);
      const out = [];

      // если анти-бот, плиток может не быть — тогда вернём ссылку позже в aggregate (но тут попробуем вытащить всё что есть)
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
        const a$ = el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        const title = firstNonEmpty(
          el$.find('[data-qa="product-title"]').text(),
          el$.find('.product-title').text(),
          a$.attr('title'),
          el$.text()
        ).replace(/\s+/g,' ').trim();
        if (!href || !title) return;

        // картинка: может быть /_next/image → достанем оригинал из url=
        let img = firstNonEmpty(
          el$.find('img').attr('data-src'),
          el$.find('img').attr('data-original'),
          el$.find('img').attr('srcset'),
          el$.find('img').attr('src')
        );
        img = unwrapNextImage(img);
        img = absolutize(img, 'https://www.repairclinic.com');

        const link = absolutize(href, 'https://www.repairclinic.com');
        out.push({ title, link, image: img || '', source: 'RepairClinic', part_number: pn(title) });
      });

      // если вообще ничего — aggregate вернёт fallback-карточку «Открыть поиск…»
      return out;
    }
  }
];
