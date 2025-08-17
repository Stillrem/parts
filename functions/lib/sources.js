
import * as cheerio from 'cheerio';

/* helpers */
function textClean(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function firstNonEmpty(...vals){ for(const v of vals){ const t=textClean(v); if(t) return t; } return ''; }
function unwrapNextImage(src){
  if(!src) return '';
  try{
    const u = new URL(src, 'https://dummy.base');
    if (u.pathname.includes('/_next/image') && u.searchParams.has('url')){
      const real = u.searchParams.get('url');
      return decodeURIComponent(real||'');
    }
  }catch{}
  return src;
}
function absolutize(src, base){
  if(!src) return '';
  src = String(src).trim();
  if(!src) return '';
  src = unwrapNextImage(src);
  if (src.startsWith('//')) return 'https:'+src;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) return base.replace(/\/$/,'') + src;
  if (/\s+\d+x(?:,|$)/.test(src)) {
    const first = src.split(',')[0].trim().split(' ')[0].trim();
    return absolutize(first, base);
  }
  return src;
}
function pickSearsThumb($ctx){
  const BASE='https://www.searspartsdirect.com';
  let img = absolutize($ctx.find('img').attr('src')||'', BASE);
  if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(img)) return img;
  $ctx.find('img').each((_,el)=>{
    const raw = el.attribs?.src || el.attribs?.['data-src'] || el.attribs?.srcset || '';
    const abs = absolutize(raw, BASE);
    if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)){ img = abs; return false; }
  });
  return img || '';
}
function partNumberFrom(s){ const m = String(s).match(/[A-Z0-9\-]{5,}/i); return m?m[0].toUpperCase():''; }
function detectOEM(name){ return /\b(OEM|Genuine|Factory|Original)\b/i.test(name||''); }

/* ---- generic extractors for RepairClinic fallbacks ---- */
function tryJsonLDProducts($, base){
  const out = [];
  $('script[type="application/ld+json"]').each((_,el)=>{
    let txt = $(el).contents().text();
    if (!txt) return;
    try {
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr){
        if (!obj) continue;
        if (obj['@type'] === 'Product' || obj['@graph'] || obj.itemListElement){
          const products = [];
          if (obj['@type'] === 'Product') products.push(obj);
          if (Array.isArray(obj['@graph'])) products.push(...obj['@graph'].filter(x=>x['@type']==='Product'));
          if (Array.isArray(obj.itemListElement)) {
            for (const e of obj.itemListElement){
              if (e && e.item && (e.item['@type']==='Product' || e.item.name)) products.push(e.item);
            }
          }
          for (const p of products){
            const title = firstNonEmpty(p.name, p.title);
            const image = absolutize(Array.isArray(p.image)?p.image[0]:p.image || '', base);
            const url = absolutize(p.url || p.productUrl || p.canonicalUrl || '', base);
            if (title && url){
              out.push({ title, link:url, image });
            }
          }
        }
      }
    } catch {}
  });
  return out;
}

function walkNextData(node, cb, path=''){
  if (node && typeof node === 'object'){
    if (Array.isArray(node)){
      node.forEach((v,i)=>walkNextData(v, cb, path+'['+i+']'));
    } else {
      cb(node, path);
      for (const k of Object.keys(node)){
        walkNextData(node[k], cb, path+'.'+k);
      }
    }
  }
}

function tryNextData($, base){
  const out = [];
  const el = $('#__NEXT_DATA__').first();
  if (!el.length) return out;
  let txt = el.contents().text();
  if (!txt) return out;
  try {
    const data = JSON.parse(txt);
    walkNextData(data, (n)=>{
      if (!n || typeof n !== 'object') return;
      const title = firstNonEmpty(n.name, n.title, n.productTitle, n.partTitle);
      const url = firstNonEmpty(n.url, n.productUrl, n.canonicalUrl, n.href);
      let image = firstNonEmpty(n.image, n.imageUrl, n.imageURL);
      if (title && url && (image || /repairclinic\.com/i.test(base))){
        out.push({
          title,
          link: absolutize(url, base),
          image: absolutize(image||'', base)
        });
      }
    });
  } catch {}
  // de-dup by link
  const seen = new Set();
  return out.filter(x=>{
    if (!x.link) return false;
    if (seen.has(x.link)) return false;
    seen.add(x.link); return true;
  });
}

/* sources */
export const sources = [
  {
    name: 'SearsPartsDirect',
    searchUrl: (q) => `https://www.searspartsdirect.com/search?q=${encodeURIComponent(q)}`,
    parser: async (html) => {
      const $ = cheerio.load(html);
      const out = [];
      $('.part-card, .product-card, .card, [data-component="product-card"], a[href*="/part/"], a[href*="/product/"]').each((_,el)=>{
        const el$ = $(el);
        const a$ = el$.is('a') ? el$ : el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!/\/part\/|\/product\//i.test(href||'')) return;
        const title = firstNonEmpty(el$.find('.card-title').text(), el$.find('.product-title').text(), el$.text());
        const link = absolutize(href, 'https://www.searspartsdirect.com');
        const image = pickSearsThumb(el$);
        const availability = textClean(el$.find('.availability, [data-qa="availability"]').text());
        out.push({ title, link, image, source:'SearsPartsDirect',
          part_number: partNumberFrom(title),
          availability,
          oem_flag: detectOEM(title)
        });
      });
      if (!out.length){
        $('.card, .product-card, [data-component="product-card"]').each((_,el)=>{
          const el$ = $(el);
          const a$ = el$.find('a[href]').first();
          const href = a$.attr('href') || '';
          if (!/\/model\//i.test(href||'')) return;
          let shop = '';
          el$.find('a[href]').each((_,x)=>{
            const t = textClean($(x).text()).toLowerCase();
            const h = $(x).attr('href') || '';
            if (/shop\s*parts/i.test(t) && h) shop = h;
          });
          const link = absolutize(shop||href, 'https://www.searspartsdirect.com');
          const title = textClean(el$.text());
          const image = pickSearsThumb(el$);
          out.push({ title, link, image, source:'SearsPartsDirect',
            part_number: partNumberFrom(title),
            availability: '',
            oem_flag: detectOEM(title)
          });
        });
      }
      return out;
    }
  },
  {
    name: 'RepairClinic',
    searchUrl: (q) => `https://www.repairclinic.com/Shop-For-Parts?query=${encodeURIComponent(q)}`,
    parser: async (html, q) => {
      const $ = cheerio.load(html);
      const base = 'https://www.repairclinic.com';
      let out = [];

      // 1) Visible tiles
      const tiles = $('[data-qa="product-tile"], [data-automation-id="product-tile"], .product-card, .product-tile, .search-results__grid-item, .product-grid__item');
      tiles.each((_,el)=>{
        const el$ = $(el);
        const a$ = el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!href) return;
        const title = firstNonEmpty(
          el$.find('[data-qa="product-title"]').text(),
          el$.find('.product-title').text(),
          a$.attr('title'),
          el$.text()
        );
        let imgRaw = el$.find('img').attr('data-src')
                 || el$.find('img').attr('data-original')
                 || el$.find('img').attr('data-srcset')
                 || el$.find('img').attr('srcset')
                 || el$.find('img').attr('src')
                 || '';
        const image = absolutize(imgRaw, base);
        const link = absolutize(href, base);
        if (title && link) out.push({ title, link, image, source:'RepairClinic', part_number: partNumberFrom(title) });
      });

      // 2) JSON-LD fallback
      if (!out.length){
        const ld = tryJsonLDProducts($, base);
        if (ld.length) out = ld.map(x=>({ ...x, source:'RepairClinic', part_number: partNumberFrom(x.title) }));
      }

      // 3) __NEXT_DATA__ fallback
      if (!out.length){
        const nx = tryNextData($, base);
        if (nx.length) out = nx.map(x=>({ ...x, source:'RepairClinic', part_number: partNumberFrom(x.title) }));
      }

      // 4) Alternate search path if still empty
      if (!out.length && q){
        // tell aggregate to try alternate URL too by encoding in link to open
        const alt = `${base}/Shop-For-Parts?query=${encodeURIComponent(q)}`;
        out.push({ title: `Открыть поиск RepairClinic: ${q}`, link: alt, image:'', source:'RepairClinic', part_number: partNumberFrom(q) });
      }

      return out;
    }
  }
];
