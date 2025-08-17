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

// SearsPartsDirect — search + model (EXACT MATCH) + diagrams → parts
export async function fromSears(q){
  const BASE = 'https://www.searspartsdirect.com';
  const searchUrl = `${BASE}/search?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(searchUrl);
  const $ = cheerio.load(html);
  const items = [];

  const push = ($ctx, name, href) => {
    if(!name || !href) return;
    if (href.startsWith('/')) href = BASE + href;
    const text = ($ctx?.text?.() || '').trim().replace(/\s+/g,' ');
    const { price, currency } = money(text);
    const img = ($ctx && ($ctx.find('img').attr('src') || $ctx.find('img').attr('data-src'))) || '';
    items.push({ supplier:'SearsPartsDirect', name, url:href, image:img, price, currency, part_number:pn(name) });
  };

  // 1) Пробуем сразу найти карточки деталей на странице поиска
  $('.card, .product-card, [data-component="product-card"], a[href*="/product/"], a[href*="/part/"]').each((_,el)=>{
    const el$ = $(el);
    const a$ = el$.is('a') ? el$ : el$.find('a[href]').first();
    const href = (a$.attr('href')||'').trim();
    const name = (el$.text() || a$.text()).trim().replace(/\s+/g,' ');
    if (/\/part\/|\/product\//.test(href||'')) push(el$, name, href);
  });
  if (items.length) return items;

  // 2) Это, скорее всего, список МОДЕЛЕЙ. Ищем «EXACT MATCH» (или берём первую карточку модели)
  const modelCards = $('.card, .product-card, [data-component="product-card"]')
    .filter((_,el)=>{
      const href = $(el).find('a[href]').attr('href') || '';
      return /\/model\//i.test(href);
    }).toArray();

  // ищем карточку с бейджем EXACT MATCH
  let chosen = modelCards.find(el => /exact\s*match/i.test($(el).text()));
  if (!chosen) chosen = modelCards[0];

  // если нашли модель — заходим на неё
  if (chosen) {
    let modelHref = $(chosen).find('a[href]').attr('href') || '';
    if (modelHref.startsWith('/')) modelHref = BASE + modelHref;

    const mh = await fetchHTML(modelHref);
    const $$ = cheerio.load(mh);

    // 2.1) Собираем ссылки на диаграммы (sections)
    const diagramLinks = Array.from(new Set(
      $$('a[href*="/diagram/"]').map((_,a)=> $$(a).attr('href')||'').get().filter(Boolean)
    )).slice(0, 2); // чтобы не грузить слишком много

    // 2.2) Иногда на странице модели уже есть ссылки на детали — заберём их
    $$('a[href*="/part/"], a[href*="/product/"]').each((_,el)=>{
      const el$ = $$(el);
      let href = (el$.attr('href')||'').trim();
      const name = el$.text().trim().replace(/\s+/g,' ');
      if (href) push(el$, name, href);
    });

    // 3) Заходим на 1–2 диаграммы и собираем детали
    for (let dHref of diagramLinks) {
      try {
        if (dHref.startsWith('/')) dHref = BASE + dHref;
        const dh = await fetchHTML(dHref);
        const $$$ = cheerio.load(dh);

        // Вариант 1: явные карточки деталей
        $$$('a[href*="/part/"], a[href*="/product/"]').each((_,el)=>{
          const el$ = $$$(el);
          let href = (el$.attr('href')||'').trim();
          const name = el$.text().trim().replace(/\s+/g,' ');
          if (href) push(el$, name, href);
        });

        // Вариант 2: списки с data-partnumber
        $$$('.part-list-item, .part, li[data-partnumber]').each((_,el)=>{
          const el$ = $$$(el);
          const name = el$.text().trim().replace(/\s+/g,' ');
          const partNum = el$.attr('data-partnumber') || pn(name);
          // бывает, что у таких элементов нет прямой ссылки — используем ссылку диаграммы
          if (name || partNum) {
            const img = el$.find('img').attr('src') || '';
            items.push({ supplier:'SearsPartsDirect', name, url:dHref, image:img, part_number:partNum });
          }
        });
      } catch { /* пропускаем неудачные диаграммы */ }
    }
  }

  return items;
}
