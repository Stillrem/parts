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

function pickImg($root){
  // Try common attributes for lazy images
  const el = $root.is('img') ? $root : $root.find('img').first();
  if(!el || !el.length) return '';
  return el.attr('data-src') || el.attr('data-original') || el.attr('srcset')?.split(' ')[0] || el.attr('src') || '';
}

// ========== RepairClinic ==========
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
    const img = pickImg($(el));
    if (name && link) items.push({ supplier:'RepairClinic', name, url:link, image:img, price, currency, part_number:pn(name) });
  });

  // Also: if there are "model" style links, follow a couple and extract parts from them
  const modelLinks = Array.from(new Set(
    $('a[href*="/Model/"], a[href*="/model/"], a[href*="/Product/"], a[href*="/product/"]')
      .map((_,a)=>$(a).attr('href')||'').get()
      .filter(h=>h && !/#/.test(h))
      .slice(0,2) // keep it light
  ));
  for (let href of modelLinks){
    try{
      if (href.startsWith('/')) href = 'https://www.repairclinic.com'+href;
      const mh = await fetchHTML(href);
      const $$ = cheerio.load(mh);
      $$('.product, .product-tile, a[href*="/Part/"], a[href*="/part/"]').each((_,el)=>{
        const a = $$(el).is('a') ? $$(el) : $$(el).find('a[href]').first();
        let link = a.attr('href')||'';
        if(!link) return;
        if(link.startsWith('/')) link = 'https://www.repairclinic.com'+link;
        const name = $$(el).text().trim().replace(/\s+/g,' ');
        const img = pickImg($$(el));
        if (name && link) items.push({ supplier:'RepairClinic', name, url:link, image:img, part_number:pn(name) });
      });
    }catch{ /* ignore model fetch errors */ }
  }

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

// ========== SearsPartsDirect ==========
export async function fromSears(q){
  const url = `https://www.searspartsdirect.com/search?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const items = [];

  // Product/part cards
  $('.card, .product-card, [data-component="product-card"], a[href*="/product/"], a[href*="/part/"]').each((_,el)=>{
    const el$ = $(el);
    let a = el$.is('a') ? el$ : el$.find('a[href]').first();
    let link = (a.attr('href')||'').trim();
    if (!link) return;
    if (link.startsWith('/')) link = 'https://www.searspartsdirect.com'+link;
    const text = el$.text().trim().replace(/\s+/g,' ');
    const { price, currency } = money(text);
    const img = pickImg(el$);
    const name = text || a.text().trim();
    if (name && link) items.push({ supplier:'SearsPartsDirect', name, url:link, image:img, price, currency, part_number:pn(name) });
  });

  // Also follow up to 2 model pages and harvest parts links
  const modelLinks = Array.from(new Set(
    $('a[href*="/model/"], a[href*="/Model/"]').map((_,a)=>$(a).attr('href')||'').get().filter(Boolean).slice(0,2)
  ));
  for (let href of modelLinks){
    try{
      if (href.startsWith('/')) href = 'https://www.searspartsdirect.com'+href;
      const mh = await fetchHTML(href);
      const $$ = cheerio.load(mh);
      $$('.diagram, a[href*="/part/"], a[href*="/product/"]').each((_,el)=>{
        const a = $$(el).is('a') ? $$(el) : $$(el).find('a[href]').first();
        let link = a.attr('href')||'';
        if(!link) return;
        if(link.startsWith('/')) link = 'https://www.searspartsdirect.com'+link;
        const name = $$(el).text().trim().replace(/\s+/g,' ');
        const img = pickImg($$(el));
        if (name && link) items.push({ supplier:'SearsPartsDirect', name, url:link, image:img, part_number:pn(name) });
      });
    }catch{ /* ignore model fetch errors */ }
  }

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
