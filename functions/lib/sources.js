import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

async function fetchHTML(url){
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if(!res.ok) throw new Error('HTTP '+res.status+' on '+url);
  return await res.text();
}

function money(text=''){
  let m = text.match(/([$€£])\s?(\d[\d,]*(?:\.\d{1,2})?)/);
  if(m) return { price:m[2], currency: ({'$':'USD','€':'EUR','£':'GBP'})[m[1]]||'' };
  m = text.match(/(\d[\d,]*(?:\.\d{1,2})?)\s?(USD|EUR|GBP)/i);
  if(m) return { price:m[1], currency:m[2].toUpperCase() };
  return { price:'', currency:'' };
}

function pn(s=''){
  const m=String(s).match(/[A-Z0-9-]{5,}/i);
  return m?m[0].toUpperCase():''; 
}

// ---------- image helpers (включая разворачивание /_next/image) ----------
function unwrapNextImage(src){
  if(!src) return '';
  try{
    const u = new URL(src, 'https://dummy.base'); // позволяет парсить относительные
    if (u.pathname.includes('/_next/image') && u.searchParams.has('url')) {
      const original = u.searchParams.get('url');
      return decodeURIComponent(original || '');
    }
  }catch{}
  return src;
}

function absolutize(src, base){
  if(!src) return '';
  src = String(src).trim();
  if(!src) return '';
  // сначала "разворачиваем" next/image
  src = unwrapNextImage(src);
  if (src.startsWith('//')) return 'https:' + src;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) {
    try { const u = new URL(base); return u.origin + src; } catch { return src; }
  }
  // srcset: берем первый URL
  if (/\s+\d+x(?:,|$)/.test(src)) {
    const first = src.split(',')[0].trim().split(' ')[0].trim();
    return absolutize(first, base);
  }
  return src;
}

function pickImg($ctx, base){
  const img = ($ctx && ($ctx.is('img') ? $ctx : $ctx.find('img').first()));
  if (img && img.length){
    const cand = img.attr('data-src') || img.attr('data-original') || img.attr('data-srcset') || img.attr('srcset') || img.attr('src');
    const abs = absolutize(cand, base);
    if (abs) return abs;
  }
  // background-image
  const style = ($ctx?.attr('style') || '') + ' ' + ($ctx?.find('[style]').first().attr('style') || '');
  const m = style.match(/url\((['"]?)(.+?)\1\)/i);
  if (m && m[2]) return absolutize(m[2], base);
  return '';
}

// ================== RepairClinic ==================
// Надёжный фолбэк: если RC отдаёт анти-бот пустышку — возвращаем ссылку на поиск.
export async function fromRepairClinic(q){
  const BASE='https://www.repairclinic.com';
  const url = `${BASE}/Shop-For-Parts?query=${encodeURIComponent(q)}`;

  let items = [];
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': BASE + '/'
      }
    });
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);

      // Плитки (несколько вариантов)
      const tileSel = [
        '[data-qa="product-tile"]',
        '[data-automation-id="product-tile"]',
        '.search-results__grid-item',
        '.product-grid__item',
        '.product-tile',
      ].join(',');

      $(tileSel).each((_,el)=>{
        const el$ = $(el);
        const a$  = el$.find('a[href]').first();
        const name = (el$.find('[data-qa="product-title"], .product-title, a[title]').first().text()
                   || a$.attr('title')
                   || el$.text()).trim().replace(/\s+/g,' ');
        let href = (a$.attr('href') || '').trim();
        if (name && href) {
          if (href.startsWith('/')) href = BASE + href;
          // картинка часто через /_next/image — разворачиваем
          const img = pickImg(el$, BASE);
          const ptxt = (el$.find('[data-qa="product-price"], .price, [itemprop="price"]').first().text() || '').trim();
          const { price, currency } = money(ptxt);
          items.push({
            supplier:'RepairClinic',
            name,
            url: href,
            image: img,
            price, currency,
            part_number: pn(name)
          });
        }
      });

      if (items.length) return items.slice(0, 80);
    }
  } catch (_) {
    // игнор — идём в фолбэк ниже
  }

  // Фолбэк: возвращаем кликабельную ссылку на поиск RC
  return [{
    supplier: 'RepairClinic',
    name: `Открыть поиск на RepairClinic для: ${q}`,
    url: url,
    image: '', // плейсхолдер
    part_number: pn(q)
  }];
}

// ================== Sears PartsDirect ==================
// По парт-номерам — карточки деталей с картинками.
// По моделям — если деталей нет, возвращаем карточки МОДЕЛЕЙ (Shop parts).
export async function fromSears(q){
  const BASE = 'https://www.searspartsdirect.com';
  const searchUrl = `${BASE}/search?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(searchUrl);
  const $ = cheerio.load(html);
  const items = [];

  const push = ($ctx, name, href) => {
    if (!name || !href) return;
    if (href.startsWith('/')) href = BASE + href;
    const text = ($ctx?.text?.() || '').trim().replace(/\s+/g,' ');
    const { price, currency } = money(text);
    const img = pickImg($ctx, BASE);
    items.push({ supplier:'SearsPartsDirect', name, url:href, image:img, price, currency, part_number:pn(name) });
  };

  // 1) Пробуем сразу найти карточки деталей/товаров на странице поиска
  $('.card, .product-card, [data-component="product-card"], a[href*="/product/"], a[href*="/part/"]').each((_,el)=>{
    const el$ = $(el);
    const a$ = el$.is('a') ? el$ : el$.find('a[href]').first();
    const href = (a$.attr('href')||'').trim();
    const name = (el$.text() || a$.text()).trim().replace(/\s+/g,' ');
    if (/\/part\/|\/product\//i.test(href||'')) push(el$, name, href);
  });
  if (items.length) return items;

  // 2) Fallback для МОДЕЛЕЙ: отдаём карточки моделей (с Shop parts)
  $('.card, .product-card, [data-component="product-card"]').each((_, el) => {
    const el$ = $(el);
    const a$ = el$.find('a[href]').first();
    let href = (a$.attr('href')||'').trim();
    if (!/\/model\//i.test(href||'')) return;

    // ищем ссылку на "Shop parts", если есть отдельная кнопка
    let shopHref = '';
    el$.find('a[href]').each((_,x)=>{
      const t = $(x).text().trim().toLowerCase();
      const h = $(x).attr('href') || '';
      if (/shop\s*parts/i.test(t) && h) shopHref = h;
    });

    const link = shopHref || href; // если отдельной кнопки нет, ведём на страницу модели
    const name = el$.text().trim().replace(/\s+/g,' ');
    push(el$, name, link);
  });

  return items;
}
