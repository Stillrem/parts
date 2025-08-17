import * as cheerio from 'cheerio';
import httpGet from './http_get.js';

/* ========== helpers ========== */
function t(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function first(...vals){ for(const v of vals){ const x=t(v); if(x) return x; } return ''; }
function pn(s){ const m=String(s).match(/[A-Z0-9\-]{5,}/i); return m?m[0].toUpperCase():''; }
function detectOEM(s){ return /\b(OEM|Genuine|Factory|Original)\b/i.test(s||''); }

function unwrapNext(src){
  if(!src) return '';
  try{
    const u = new URL(src, 'https://dummy.base');
    if (u.pathname.includes('/_next/image') && u.searchParams.has('url')){
      return decodeURIComponent(u.searchParams.get('url')||'');
    }
  }catch{}
  return src;
}
function absUrl(src, base){
  if(!src) return '';
  src = unwrapNext(String(src).trim());
  if(!src) return '';
  if (src.startsWith('//')) return 'https:'+src;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) return base.replace(/\/$/,'') + src;
  if (/\s+\d+x(?:,|$)/.test(src)) { // srcset → берем первый
    const firstU = src.split(',')[0].trim().split(' ')[0].trim();
    return absUrl(firstU, base);
  }
  return src;
}

function pickSearsThumb($ctx){
  const BASE = 'https://www.searspartsdirect.com';
  let img = absUrl($ctx.find('img').attr('src')||'', BASE);
  if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(img)) return img;

  $ctx.find('img').each((_,el)=>{
    const raw = el.attribs?.src || el.attribs?.['data-src'] || el.attribs?.srcset || '';
    const abs = absUrl(raw, BASE);
    if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)){ img = abs; return false; }
  });
  return img || '';
}

/* ===== RepairClinic fallbacks ===== */
function tryJsonLDProducts($, base){
  const out = [];
  $('script[type="application/ld+json"]').each((_,el)=>{
    const raw = $(el).contents().text();
    if (!raw) return;
    try{
      const data = JSON.parse(raw);
      const arr = Array.isArray(data)?data:[data];
      for (const d of arr){
        if (!d) continue;
        if (d['@type']==='Product'){
          const title = first(d.name, d.title);
          const url   = absUrl(d.url||'', base);
          const image = absUrl(Array.isArray(d.image)?d.image[0]:d.image||'', base);
          if (title && url) out.push({ title, link:url, image });
        }
        if (Array.isArray(d.itemListElement)){
          for (const it of d.itemListElement){
            const p = it && (it.item||it);
            const title = first(p?.name, p?.title);
            const url   = absUrl(p?.url||p?.canonicalUrl||'', base);
            const image = absUrl(Array.isArray(p?.image)?p.image[0]:p?.image||'', base);
            if (title && url) out.push({ title, link:url, image });
          }
        }
      }
    }catch{}
  });
  // de-dup
  const seen=new Set();
  return out.filter(x=>{ if(!x.link||seen.has(x.link))return false; seen.add(x.link); return true; });
}

function tryNextData($, base){
  const out=[];
  const el=$('#__NEXT_DATA__').first();
  if(!el.length) return out;
  let txt = el.contents().text();
  if(!txt) return out;
  try{
    const data = JSON.parse(txt);
    (function walk(n){
      if (!n || typeof n!=='object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      const title = first(n.name, n.title, n.productTitle, n.partTitle);
      const url   = first(n.url, n.productUrl, n.canonicalUrl, n.href);
      const image = first(n.image, n.imageUrl, n.imageURL);
      if (title && url){
        out.push({ title, link: absUrl(url, base), image: absUrl(image||'', base) });
      }
      for (const k of Object.keys(n)) walk(n[k]);
    })(data);
  }catch{}
  // de-dup
  const seen=new Set();
  return out.filter(x=>{ if(!x.link||seen.has(x.link))return false; seen.add(x.link); return true; });
}

/* ===== Sears model image enrichment (без динамических импортов) ===== */
async function enrichSearsImages(items, limit = 6){
  let done = 0;
  for (const it of items){
    if (done >= limit) break;
    if (it.source!=='SearsPartsDirect') continue;
    if (it.image) continue;
    if (!it.url || !/searspartsdirect\.com\/model\//i.test(it.url)) continue;

    try{
      const base = it.url.split('/').slice(0,3).join('/');
      const html = await httpGet(it.url, { 'Referer': base+'/' });
      const $ = cheerio.load(html);

      // искать картинку детали на странице модели
      let found = '';
      $('a[href*="/part/"], a[href*="/product/"]').each((_,a)=>{
        if (found) return;
        const box = $(a).closest('.part-card, .product-card, .card, [data-component="product-card"]');
        const raw = (box.find('img').attr('src') || box.find('img').attr('srcset') || '').trim();
        const abs = absUrl(raw, base);
        if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)) found = abs;
      });
      if (!found){
        $('img').each((_,img)=>{
          if (found) return;
          const raw = $(img).attr('src') || $(img).attr('srcset') || '';
          const abs = absUrl(raw, base);
          if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)) found = abs;
        });
      }
      if (found){ it.image = found; done++; }
    }catch{ /* игнор — оставим без картинки */ }
  }
  return items;
}

/* ========== SOURCES ========== */
export const sources = [
  /* -------- SearsPartsDirect -------- */
  {
    name: 'SearsPartsDirect',
    searchUrl: (q) => `https://www.searspartsdirect.com/search?q=${encodeURIComponent(q)}`,
    parser: async (html) => {
      const $ = cheerio.load(html);
      const BASE = 'https://www.searspartsdirect.com';
      const out = [];

      // детали/товары
      $('.part-card, .product-card, .card, [data-component="product-card"], a[href*="/part/"], a[href*="/product/"]').each((_,el)=>{
        const el$ = $(el);
        const a$  = el$.is('a') ? el$ : el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!/\/part\/|\/product\//i.test(href||'')) return;

        const title = first(el$.find('.card-title').text(), el$.find('.product-title').text(), el$.text());
        const link  = absUrl(href, BASE);
        const image = pickSearsThumb(el$);
        const availability = t(el$.find('.availability, [data-qa="availability"]').text());

        out.push({
          title: t(title), link, image,
          source: 'SearsPartsDirect',
          part_number: pn(title), availability, oem_flag: detectOEM(title)
        });
      });

      // модели (карточки + ссылки «Shop parts»)
      if (!out.length){
        const models = $('.model-card, [data-component="model-card"], .card, .product-card');
        models.each((_,el)=>{
          const el$ = $(el);
          let modelHref = '';
          el$.find('a[href]').each((_,a)=>{
            const h = $(a).attr('href') || '';
            const tt = t($(a).text()).toLowerCase();
            if (/\/model\//i.test(h)) modelHref = modelHref || h;
            if (/shop\s*parts/i.test(tt) && h) modelHref = h;
          });
          if (!modelHref) return;

          const link = absUrl(modelHref, BASE);
          const title = first(el$.find('.card-title, .product-title, .model-title').text(), el$.attr('aria-label'), el$.text());
          const image = pickSearsThumb(el$);

          out.push({
            title: t(title), link, image,
            source: 'SearsPartsDirect',
            part_number: pn(title), availability: '', oem_flag: detectOEM(title)
          });
        });
      }

      // модели: JSON-LD
      if (!out.length){
        const ld = tryJsonLDProducts($, BASE).filter(x=>/\/model\//i.test(x.link||''));
        out.push(...ld.map(x=>({ ...x, source:'SearsPartsDirect', part_number: pn(x.title), oem_flag: detectOEM(x.title) })));
      }

      // модели: любые ссылки на /model/ по странице
      if (!out.length){
        const seen = new Set();
        $('a[href*="/model/"]').each((_,a)=>{
          const h = $(a).attr('href')||'';
          if (!h || seen.has(h)) return;
          seen.add(h);
          const title = t($(a).text()) || h;
          out.push({ title, link: absUrl(h, BASE), image: '', source:'SearsPartsDirect', part_number: pn(title), oem_flag: detectOEM(title) });
        });
      }

      // догружаем изображения у моделей, где пусто (до 6 штук)
      await enrichSearsImages(out, 6);

      return out;
    }
  },

  /* -------- RepairClinic -------- */
  {
    name: 'RepairClinic',
    searchUrl: (q) => `https://www.repairclinic.com/Shop-For-Parts?query=${encodeURIComponent(q)}`,
    parser: async (html, q) => {
      const $ = cheerio.load(html);
      const BASE = 'https://www.repairclinic.com';
      let out = [];

      // плитки
      const tiles = $(
        "[data-qa='product-tile'], [data-automation-id='product-tile'], .product-card, .product-tile, .search-results__grid-item, .product-grid__item"
      );
      tiles.each((_,el)=>{
        const el$ = $(el);
        const a$  = el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!href) return;

        const title = first(
          el$.find("[data-qa='product-title']").text(),
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

        out.push({
          title: t(title),
          link:  absUrl(href, BASE),
          image: absUrl(imgRaw, BASE),
          source:'RepairClinic',
          part_number: pn(title)
        });
      });

      // JSON-LD
      if (!out.length){
        const ld = tryJsonLDProducts($, BASE);
        if (ld.length) out = ld.map(x=>({ ...x, source:'RepairClinic', part_number: pn(x.title) }));
      }

      // Next.js data
      if (!out.length){
        const nx = tryNextData($, BASE);
        if (nx.length) out = nx.map(x=>({ ...x, source:'RepairClinic', part_number: pn(x.title) }));
      }

      // последний шанс — просто ссылка на правильный поиск
      if (!out.length && q){
        out.push({
          title: `Открыть поиск RepairClinic: ${q}`,
          link:  `${BASE}/Shop-For-Parts?query=${encodeURIComponent(q)}`,
          image: '',
          source:'RepairClinic',
          part_number: pn(q)
        });
      }

      // de-dup
      const seen = new Set();
      return out.filter(x=>{ const k=x.link; if(!k||seen.has(k)) return false; seen.add(k); return true; });
    }
  }
];
