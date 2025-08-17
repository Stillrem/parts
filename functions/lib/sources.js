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

// ========== RepairClinic (tiles + JSON-LD fallback) ==========
export async function fromRepairClinic(q){
  const BASE='https://www.repairclinic.com';
  const url = `${BASE}/Shop-For-Parts?query=${encodeURIComponent(q)}`;

  // отдельный fetch с чуть более «браузерными» заголовками
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': BASE + '/',
    }
  });
  if (!res.ok) throw new Error('HTTP '+res.status+' on '+url);
  const html = await res.text();

  const $ = cheerio.load(html);
  const items = [];
  console.log('[RC] URL:', url);

  const push = (name, href, $ctx) => {
    if (!name || !href) return;
    if (href.startsWith('/')) href = BASE + href;
    const text = ($ctx?.text?.() || '').trim().replace(/\s+/g,' ');
    const { price, currency } = money(
      ($ctx?.find?.('[data-qa="product-price"], .price, [itemprop="price"]').first().text() || text)
    );
    // pickImg должен быть объявлен у тебя выше; если нет — возьми из моей предыдущей версии
    const img = ($ctx && pickImg($ctx, BASE)) || '';
    items.push({ supplier:'RepairClinic', name, url:href, image:img, price, currency, part_number:pn(name) });
  };

  // 1) Карточки-тайлы (несколько вариантов разметки)
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
    const href = (a$.attr('href') || '').trim();
    if (name && href) push(name, href, el$);
  });

  console.log('[RC] tiles:', items.length);

  // 2) Fallback: JSON-LD (<script type="application/ld+json">)
  if (!items.length) {
    $('script[type="application/ld+json"]').each((_,s)=>{
      let txt = $(s).contents().text();
      try{
        const json = JSON.parse(txt);
        const list = [];
        const collect = (obj)=>{
          if (!obj) return;
          if (Array.isArray(obj)) { obj.forEach(collect); return; }
          if (obj['@type']==='Product' || (obj['@type'] && String(obj['@type']).includes('Product'))) {
            const name = (obj.name||'').trim();
            let href = obj.url || '';
            if (href && href.startsWith('/')) href = BASE + href;
            const price = (obj.offers && (obj.offers.price||obj.offers.lowPrice)) || '';
            const currency = (obj.offers && obj.offers.priceCurrency) || '';
            const img = Array.isArray(obj.image) ? obj.image[0] : (obj.image||'');
            if (name && href) {
              list.push({ supplier:'RepairClinic', name, url:href, image:img, price:String(price), currency, part_number:pn(name) });
            }
          }
          if (obj['@graph']) collect(obj['@graph']);
          if (obj.itemListElement) collect(obj.itemListElement);
        };
        collect(json);
        list.forEach(x=>items.push(x));
      }catch(e){ /* JSON parse fail — игнор */ }
    });
    console.log('[RC] jsonld items:', items.length);
  }

  // 3) Fallback: PDP (если нас перекинуло сразу на страницу детали)
  if (!items.length){
    const title = ($('h1').first().text()||'').trim();
    if (title){
      const priceText = ($('[data-qa="product-price"]').first().text()||$('.price').first().text()||'').trim();
      const { price, currency } = money(priceText);
      const canonical = $('link[rel="canonical"]').attr('href') || url;
      const img = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '';
      items.push({
        supplier:'RepairClinic',
        name:title,
        url: canonical.startsWith('/') ? BASE+canonical : canonical,
        image: img.startsWith('/') ? BASE+img : img,
        price, currency,
        part_number: pn(title)
      });
    }
  }

  // слегка ограничим, чтобы не раздувать ответ
  return items.slice(0, 80);
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
