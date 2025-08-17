import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (X11: Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

async function fetchHTML(url){
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if(!res.ok) throw new Error('HTTP ' + res.status + ' on ' + url);
  return await res.text();
}

function money(text=''){
  let m = text.match(/([$€£])\s?(\d[\d,]*(?:\.\d{1,2})?)/);
  if(m) return { price: m[2], currency: ({'$':'USD','€':'EUR','£':'GBP'})[m[1]] || '' };
  m = text.match(/(\d[\d,]*(?:\.\d{1,2})?)\s?(USD|EUR|GBP)/i);
  if(m) return { price: m[1], currency: m[2].toUpperCase() };
  return { price: '', currency: '' };
}

function pn(s=''){
  const m = String(s).match(/[A-Z0-9-]{5,}/i);
  return m ? m[0].toUpperCase() : '';
}

export async function fromRepairClinic(q){
  const url = `https://www.repairclinic.com/Shop-For-Parts?query=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const items = [];
  $('[data-qa="product-tile"], .product-tile, .search-results__grid-item').each((_,el)=>{
    const name = $(el).text().trim().replace(/\s+/g,' ');
    const a = $(el).find('a[href]').first();
    const href = a.attr('href') || '';
    const link = href.startsWith('/') ? 'https://www.repairclinic.com' + href : href;
    const priceText = $(el).find('.price,[data-qa="product-price"]').text();
    const { price, currency } = money(priceText);
    const img = $(el).find('img').attr('src') || '';
    items.push({ supplier:'RepairClinic', name, url:link, image:img, price, currency, part_number:pn(name) });
  });
  return items;
}

export async function fromAppliancePartsPros(q){
  const url = `https://www.appliancepartspros.com/search.aspx?model=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const items = [];
  $('.product, .plp-product, .search-results .product-list-item').each((_,el)=>{
    const titleEl = $(el).find('.product-title, h2 a, a[title]').first();
    const name = titleEl.text().trim() || $(el).text().trim();
    let link = titleEl.attr('href') || '';
    if(link && link.startsWith('/')) link = 'https://www.appliancepartspros.com' + link;
    const priceText = $(el).text();
    const { price, currency } = money(priceText);
    const img = $(el).find('img').attr('src') || '';
    items.push({ supplier:'AppliancePartsPros', name, url:link, image:img, price, currency, part_number:pn(name) });
  });
  return items;
}


export async function fromPartSelect(q){
  // PartSelect shows results on either a search list or directly on a product detail page (PDP).
  // We'll request the search page first; if no list items are found, we'll try PDP extraction from the same HTML.
  const url = `https://www.partselect.com/AdvancedSearch.aspx?SearchTerm=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const items = [];

  // Try list mode
  $('.product-list li, .product-list__item, .ps-product-tile').each((_,el)=>{
    const name = $(el).text().trim().replace(/\s+/g,' ');
    const a = $(el).find('a[href]').first();
    let link = a.attr('href') || '';
    if(link && link.startsWith('/')) link = 'https://www.partselect.com' + link;
    const img = $(el).find('img').attr('src') || '';
    const { price, currency } = money($(el).text());
    items.push({ supplier:'PartSelect', name, url:link, image:img, price, currency, part_number:pn(name) });
  });

  if(items.length){
    return items;
  }

  // Fallback: PDP mode — extract from product page HTML that search might have redirected/rendered
  const title = ($('h1[itemprop="name"]').first().text()
              || $('.product-title').first().text()
              || $('h1').first().text()).trim().replace(/\s+/g,' ');

  if(title){
    // Best-effort URL (if search HTML contains canonical)
    let canonical = $('link[rel="canonical"]').attr('href') || '';
    if(!canonical){
      canonical = $('meta[property="og:url"]').attr('content') || '';
    }
    const priceText = ($('[itemprop="price"]').attr('content')
                    || $('.price, .product-price').first().text()
                    || '').toString();
    const { price, currency } = money(priceText);
    const img = ($('#main-product-image').attr('src')
              || $('.product-image img').attr('src')
              || $('meta[property="og:image"]').attr('content')
              || '');

    const text = $.root().text();
    const mfgMatches = Array.from(text.matchAll(/\b(?:Manufacturer\s+)?Part\s+Number\s*[:#]?\s*([A-Z0-9-]{5,})/gi)).map(m=>m[1].toUpperCase());
    const psMatches  = Array.from(text.matchAll(/\bPS\d{5,}\b/g)).map(m=>m[0].toUpperCase());
    const eq = Array.from(new Set([...mfgMatches, ...psMatches]));

    return [{
      supplier: 'PartSelect',
      name: title,
      url: canonical || url,
      image: img,
      price,
      currency,
      part_number: pn(title) || (eq[0] || ''),
      equivalents: eq,
    }];
  }

  return items;
}


export async function fromSears(q){
  const url = `https://www.searspartsdirect.com/search?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const items = [];
  $('.card, .product-card, [data-component="product-card"], a[href*="/product/"], a[href*="/part/"]').each((_,el)=>{
    const name = $(el).text().trim().replace(/\s+/g,' ');
    const a = $(el).attribs && $(el).attribs.href ? $(el) : $(el).find('a[href]').first();
    let link = (a.attr('href') || '').trim();
    if(!link) return;
    if(link.startsWith('/')) link = 'https://www.searspartsdirect.com' + link;
    const img = $(el).find('img').attr('src') || '';
    const { price, currency } = money($(el).text());
    items.push({ supplier:'SearsPartsDirect', name, url:link, image:img, price, currency, part_number:pn(name) });
  });
  return items;
}
