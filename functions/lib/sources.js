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

// ========== RepairClinic (tiles + JSON-LD + script JSON fallbacks) ==========
export async function fromRepairClinic(q){
  const BASE='https://www.repairclinic.com';
  const url = `${BASE}/Shop-For-Parts?query=${encodeURIComponent(q)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': BASE + '/',
      'Cache-Control': 'no-cache',
    }
  });
  if (!res.ok) throw new Error('HTTP '+res.status+' on '+url);
  const html = await res.text();

  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();
  const push = (obj) => {
    if (!obj || !obj.name || !obj.url) return;
    let href = String(obj.url).trim();
    if (href.startsWith('/')) href = BASE + href;
    const key = obj.name + '|' + href;
    if (seen.has(key)) return;
    seen.add(key);
    const price = obj.price || '';
    const currency = obj.currency || '';
    const image = (obj.image && absolutize(obj.image, BASE)) || '';
    items.push({
      supplier:'RepairClinic',
      name: obj.name.trim(),
      url: href,
      image,
      price: String(price || ''),
      currency: currency || '',
      part_number: pn(obj.part_number || obj.name)
    });
  };

  // 1) Плитки (несколько вариантов классов)
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
    const ptxt = (el$.find('[data-qa="product-price"], .price, [itemprop="price"]').first().text() || '').trim();
    const { price, currency } = money(ptxt);
    const image = pickImg(el$, BASE);
    if (name && href) push({ name, url: href, price, currency, image });
  });

  // 2) Fallback: JSON-LD
  if (!items.length) {
    $('script[type="application/ld+json"]').each((_,s)=>{
      const txt = $(s).contents().text();
      try{
        const json = JSON.parse(txt);
        const collect = (obj)=>{
          if (!obj) return;
          if (Array.isArray(obj)) { obj.forEach(collect); return; }
          const t = obj['@type'];
          if (t === 'Product' || (t && String(t).includes('Product'))) {
            push({
              name: obj.name || '',
              url: obj.url || '',
              price: obj?.offers?.price || obj?.offers?.lowPrice || '',
              currency: obj?.offers?.priceCurrency || '',
              image: Array.isArray(obj.image) ? obj.image[0] : (obj.image||''),
            });
          }
          if (obj['@graph']) collect(obj['@graph']);
          if (obj.itemListElement) collect(obj.itemListElement);
        };
        collect(json);
      }catch{/* ignore */}
    });
  }

  // 3) Fallback: любые JSON внутри <script> (initial-state/SSR)
  if (!items.length) {
    $('script').each((_,s)=>{
      let txt = $(s).contents().text();
      // отсекаем явно не JSON
      if (!/[{"\[]/.test(txt)) return;
      // пробуем вытащить массивы с товарами/результатами
      const tryParses = [];
      tryParses.push(JSON.parse.bind(null, txt));
      // простая эвристика: выделяем JSON-объекты из кода
      const blobs = txt.match(/\{[\s\S]*?\}/g) || [];
      blobs.slice(0,5).forEach(b=>{
        tryParses.push(JSON.parse.bind(null, b));
      });

      for (const f of tryParses){
        try{
          const data = f();
          const walk = (o)=>{
            if (!o) return;
            if (Array.isArray(o)) { o.forEach(walk); return; }
            if (typeof o === 'object'){
              // общие поля товара
              if (o.name && (o.url || o.link || o.slug)) {
                push({
                  name: o.name,
                  url: o.url || o.link || (typeof o.slug==='string' ? ('/'+o.slug.replace(/^\/+/,'') ) : ''),
                  price: o.price || o.salePrice || o.regularPrice || '',
                  currency: o.currency || (o.priceCurrency || ''),
                  image: o.image || o.img || ''
                });
              }
              // известные контейнеры
              ['products','items','results','list','hits'].forEach(k=>{
                if (o[k]) walk(o[k]);
              });
              Object.values(o).forEach(v=>walk(v));
            }
          };
          walk(data);
        }catch{/* skip bad parse */}
      }
    });
  }

  // 4) Fallback: если перекинуло на PDP
  if (!items.length){
    const title = ($('h1').first().text()||'').trim();
    if (title){
      const priceText = ($('[data-qa="product-price"]').first().text()||$('.price').first().text()||'').trim();
      const { price, currency } = money(priceText);
      const canonical = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content') || url;
      const img = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '';
      push({
        name: title,
        url: canonical,
        price, currency,
        image: img
      });
    }
  }

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
