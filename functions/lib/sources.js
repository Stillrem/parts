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

// RepairClinic — confirmed working
export async function fromRepairClinic(q){
  const url = `https://www.repairclinic.com/Shop-For-Parts?query=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const items = [];
  // Product tiles grid
  $('[data-qa="product-tile"], .product-tile, .search-results__grid-item').each((_,el)=>{
    const name = $(el).find('[data-qa="product-title"], .product-title, a').first().text().trim().replace(/\s+/g,' ');
    const a = $(el).find('a[href]').first();
    let link = a.attr('href')||'';
    if(link && link.startsWith('/')) link = 'https://www.repairclinic.com'+link;
    const priceText = $(el).find('.price, [data-qa="product-price"]').first().text();
    const { price, currency } = money(priceText);
    const img = $(el).find('img').attr('src')||'';
    if (name && link) items.push({ supplier:'RepairClinic', name, url:link, image:img, price, currency, part_number:pn(name) });
  });
  // Fallback: single PDP
  if (!items.length){
    const title = ($('h1').first().text()||'').trim();
    if (title){
      const priceText = ($('[data-qa="product-price"]').first().text()||$('.price').first().text()||'').trim();
      const { price, currency } = money(priceText);
      const canonical = $('link[rel="canonical"]').attr('href') || url;
      const img = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '';
      items.push({ supplier:'RepairClinic', name:title, url:canonical, image:img, price, currency, part_number:pn(title) });
    }
  }
  return items;
}

// SearsPartsDirect — search page
export async function fromSears(q){
  const url = `https://www.searspartsdirect.com/search?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const items = [];
  // Common patterns: product cards and anchors to product/part pages
  $('.card, .product-card, [data-component="product-card"], a[href*="/product/"], a[href*="/part/"]').each((_,el)=>{
    const el$ = $(el);
    const text = el$.text().trim().replace(/\s+/g,' ');
    // Prefer inner link
    let a = el$.is('a') ? el$ : el$.find('a[href]').first();
    let link = (a.attr('href')||'').trim();
    if (!link) return;
    if (link.startsWith('/')) link = 'https://www.searspartsdirect.com'+link;
    const { price, currency } = money(text);
    const img = el$.find('img').attr('src')||'';
    const name = text || a.text().trim();
    if (name && link) items.push({ supplier:'SearsPartsDirect', name, url:link, image:img, price, currency, part_number:pn(name) });
  });
  // Fallback: PDP
  if (!items.length){
    const title = ($('h1').first().text()||'').trim();
    if (title){
      const priceText = ($('[data-qa="price"], .price').first().text()||'').trim();
      const { price, currency } = money(priceText);
      const canonical = $('link[rel="canonical"]').attr('href') || url;
      const img = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '';
      items.push({ supplier:'SearsPartsDirect', name:title, url:canonical, image:img, price, currency, part_number:pn(title) });
    }
  }
  return items;
}

// ========== SearsPartsDirect (модель → диаграммы → детали) ==========
export async function fromSears(q){
  const BASE = 'https://www.searspartsdirect.com';
  const searchUrl = `${BASE}/search?q=${encodeURIComponent(q)}`;

  // --- 1) Поиск: карточки товара/детали прямо из выдачи ---
  const html = await fetchHTML(searchUrl);
  const $ = cheerio.load(html);
  const items = [];

  function pushItem(name, link, $ctx){
    if(!name || !link) return;
    const text = ($ctx?.text?.() || '').trim().replace(/\s+/g,' ');
    const { price, currency } = money(text);
    const img = pickImg($ctx || $('img'), BASE);
    items.push({
      supplier: 'SearsPartsDirect',
      name,
      url: link,
      image: img,
      price,
      currency,
      part_number: pn(name)
    });
  }

  // Карточки детали/товара
  $('.card, .product-card, [data-component="product-card"], a[href*="/product/"], a[href*="/part/"]').each((_,el)=>{
    const el$ = $(el);
    const a = el$.is('a') ? el$ : el$.find('a[href]').first();
    let href = (a.attr('href')||'').trim();
    if(!href) return;
    if(href.startsWith('/')) href = BASE + href;
    const name = (el$.text() || a.text()).trim().replace(/\s+/g,' ');
    pushItem(name, href, el$);
  });
  if(items.length) return items;

  // --- 2) Если ничего нет: попробовать страницы МОДЕЛЕЙ ---
  const modelLinks = Array.from(new Set(
    $('a[href*="/model/"], a[href*="/Model/"]')
      .map((_,a)=>$(a).attr('href')||'').get()
      .filter(Boolean)
  )).slice(0,2);  // не усугубляем нагрузку

  for (let href of modelLinks){
    try{
      if(href.startsWith('/')) href = BASE + href;
      const mh = await fetchHTML(href);
      const $$ = cheerio.load(mh);

      // На странице модели часто есть ссылки на диаграммы (sections)
      const diagramLinks = Array.from(new Set(
        $$('a[href*="/diagram/"], a[href*="/Diagram/"]')
          .map((_,a)=> $$(a).attr('href')||'').get()
          .filter(Boolean)
      )).slice(0,2);

      // Собрать детали прямо с модели (иногда уже есть списки частей)
      $$('a[href*="/part/"], a[href*="/product/"]').each((_,el)=>{
        const a = $$(el).is('a') ? $$(el) : $$(el).find('a[href]').first();
        let link = (a.attr('href')||'').trim();
        if(!link) return;
        if(link.startsWith('/')) link = BASE + link;
        const name = $$(el).text().trim().replace(/\s+/g,' ');
        pushItem(name, link, $$(el));
      });

      // --- 3) Пройти по 1–2 диаграммам и вытащить карточки деталей ---
      for (let dHref of diagramLinks){
        try{
          if(dHref.startsWith('/')) dHref = BASE + dHref;
          const dh = await fetchHTML(dHref);
          const $$$ = cheerio.load(dh);

          // Часто детали представлены как ссылки на /part/ внутри списков
          $$$('a[href*="/part/"], a[href*="/product/"]').each((_,el)=>{
            const a = $$$(el).is('a') ? $$$(el) : $$$(el).find('a[href]').first();
            let link = (a.attr('href')||'').trim();
            if(!link) return;
            if(link.startsWith('/')) link = BASE + link;
            const name = $$$(el).text().trim().replace(/\s+/g,' ');
            pushItem(name, link, $$$(el));
          });

          // Иногда на диаграмме есть карточки со структурой похожей на product-card
          $$$('.card, .product-card, [data-component="product-card"]').each((_,el)=>{
            const el$ = $$$(el);
            const a = el$.is('a') ? el$ : el$.find('a[href]').first();
            let link = (a.attr('href')||'').trim();
            if(!link) return;
            if(link.startsWith('/')) link = BASE + link;
            const name = (el$.text() || a.text()).trim().replace(/\s+/g,' ');
            pushItem(name, link, el$);
          });

        }catch(e){ /* диаграмма не критична, идём дальше */ }
      }
    }catch(e){ /* модель не критична, идём дальше */ }
  }

  return items;
}
