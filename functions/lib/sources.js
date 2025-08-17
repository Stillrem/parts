import * as cheerio from 'cheerio';

const UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

async function fetchHTML(url){
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
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

// ===== RepairClinic: быстрый и надёжный фолбэк =====
export async function fromRepairClinic(q){
  const BASE='https://www.repairclinic.com';
  const url = `${BASE}/Shop-For-Parts?query=${encodeURIComponent(q)}`;

  // пробуем загрузить HTML (иногда RC вернёт анти-бот пустышку)
  let items = [];
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      // быстрый захват карточек, если повезёт и страница «живая»
      $('[data-qa="product-tile"], .product-tile, .search-results__grid-item').each((_,el)=>{
        const el$ = $(el);
        const a$  = el$.find('a[href]').first();
        const name = (el$.find('[data-qa="product-title"], .product-title, a[title]').first().text()
                   || a$.attr('title')
                   || el$.text()).trim().replace(/\s+/g,' ');
        let href = (a$.attr('href') || '').trim();
        if (name && href) {
          if (href.startsWith('/')) href = BASE + href;
          items.push({
            supplier:'RepairClinic',
            name,
            url: href,
            image: '', // RC часто лениво грузит img — не рискуем
            part_number: (name.match(/[A-Z0-9-]{5,}/i)||[''])[0].toUpperCase()
          });
        }
      });
      if (items.length) return items.slice(0, 80);
    }
  } catch (_) {
    // молча падаем в фолбэк ниже
  }

  // Если ничего не получилось (анти-бот/динамика) — возвращаем кликабельную ссылку на поиск
  return [{
    supplier: 'RepairClinic',
    name: `Открыть поиск на RepairClinic для: ${q}`,
    url: url,
    image: '', // пусть подставится плейсхолдер на фронте
    part_number: (String(q).match(/[A-Z0-9-]{5,}/i)||[''])[0].toUpperCase()
  }];
}


// SearsPartsDirect — parts (если есть) + fallback на МОДЕЛИ (Shop parts)
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
    const img = ($ctx && ($ctx.find('img').attr('data-src') || $ctx.find('img').attr('src'))) || '';
    items.push({ supplier:'SearsPartsDirect', name, url:href, image:img, price, currency, part_number:pn(name) });
  };

  // 1) Сначала пробуем найти карточки деталей/товара прямо на поисковой странице
  $('.card, .product-card, [data-component="product-card"], a[href*="/product/"], a[href*="/part/"]').each((_,el)=>{
    const el$ = $(el);
    const a$ = el$.is('a') ? el$ : el$.find('a[href]').first();
    const href = (a$.attr('href')||'').trim();
    const name = (el$.text() || a$.text()).trim().replace(/\s+/g,' ');
    if (/\/part\/|\/product\//i.test(href||'')) push(el$, name, href);
  });
  if (items.length) return items;

  // 2) Fallback: возвращаем карточки МОДЕЛЕЙ с кнопкой "Shop parts" (чтобы юзер дошёл до деталей)
  // — это стабильно работает, даже если список деталей грузится динамически
  $('.card, .product-card, [data-component="product-card"]').each((_, el) => {
    const el$ = $(el);
    const a$ = el$.find('a[href]').first();
    let href = (a$.attr('href')||'').trim();
    if (!/\/model\//i.test(href||'')) return;

    // Пытаемся найти именно «Shop parts», если есть отдельная кнопка
    let shopHref = '';
    el$.find('a[href]').each((_,x)=>{
      const t = $(x).text().trim().toLowerCase();
      const h = $(x).attr('href') || '';
      if (/shop\s*parts/i.test(t) && h) shopHref = h;
    });

    const link = shopHref || href; // если кнопки нет, ведём на страницу модели
    const name = el$.text().trim().replace(/\s+/g,' ');
    push(el$, name, link);
  });

  return items;
}
