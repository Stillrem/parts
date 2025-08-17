
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

/* sources */
export const sources = [
  {
    name: 'SearsPartsDirect',
    searchUrl: (q) => `https://www.searspartsdirect.com/search?q=${encodeURIComponent(q)}`,
    parser: async (html) => {
      const $ = cheerio.load(html);
      const out = [];
      // parts/products
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
      // models fallback
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
    parser: async (html) => {
      const $ = cheerio.load(html);
      const out = [];
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
        const image = absolutize(imgRaw, 'https://www.repairclinic.com');
        const availability = textClean(el$.find('.availability, [data-qa="availability"]').text());
        const link = absolutize(href, 'https://www.repairclinic.com');
        out.push({ title, link, image, source:'RepairClinic',
          part_number: partNumberFrom(title),
          availability,
          oem_flag: detectOEM(title)
        });
      });
      return out;
    }
  }
];
