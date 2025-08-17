import * as cheerio from 'cheerio';
import httpGet from './http_get.js';

/* ========== helpers ========== */
const BASE_SEARS = 'https://www.searspartsdirect.com';
const BASE_RC    = 'https://www.repairclinic.com';

const t = (s)=>String(s||'').replace(/\s+/g,' ').trim();
const first = (...vals)=>{ for(const v of vals){ const x=t(v); if(x) return x; } return ''; };
const pn = (s)=>{ const m=String(s).match(/[A-Z0-9\-]{5,}/i); return m?m[0].toUpperCase():''; };
const isSearsCDN = (u)=>/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(String(u||''));

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
  if (/\s+\d+x(?:,|$)/.test(src)) { // srcset → берём первый
    const u0 = src.split(',')[0].trim().split(' ')[0].trim();
    return absUrl(u0, base);
  }
  return src;
}

function pickSearsThumb($ctx){
  let img = absUrl($ctx.find('img').attr('src')||'', BASE_SEARS);
  if (isSearsCDN(img)) return img;
  $ctx.find('img').each((_,el)=>{
    const raw = el.attribs?.src || el.attribs?.['data-src'] || el.attribs?.srcset || '';
    const abs = absUrl(raw, BASE_SEARS);
    if (isSearsCDN(abs)){ img = abs; return false; }
  });
  return img || '';
}

function detectOEM(s){ return /\b(OEM|Genuine|Factory|Original)\b/i.test(s||''); }

/* ===== generic RC fallbacks ===== */
function rcFromJsonLD($){
  const out = [];
  $('script[type="application/ld+json"]').each((_,el)=>{
    const raw = $(el).contents().text(); if (!raw) return;
    try{
      const data = JSON.parse(raw);
      const arr = Array.isArray(data)?data:[data];
      for (const d of arr){
        if (!d) continue;
        if (d['@type']==='Product'){
          const title = first(d.name,d.title);
          const url = absUrl(d.url||'', BASE_RC);
          const image = absUrl(Array.isArray(d.image)?d.image[0]:d.image||'', BASE_RC);
          if (title && url) out.push({ title, link:url, image });
        }
        if (Array.isArray(d.itemListElement)){
          for (const it of d.itemListElement){
            const item = it && (it.item||it);
            if (!item) continue;
            const title = first(item.name,item.title);
            const url = absUrl(item.url||item.canonicalUrl||'', BASE_RC);
            const image = absUrl(Array.isArray(item.image)?item.image[0]:item.image||'', BASE_RC);
            if (title && url) out.push({ title, link:url, image });
          }
        }
      }
    }catch{}
  });
  const seen = new Set();
  return out.filter(x=>{ if(!x.link||seen.has(x.link)) return false; seen.add(x.link); return true; });
}
function rcFromNextData($){
  const out = [];
  const el=$('#__NEXT_DATA__').first(); if (!el.length) return out;
  let txt = el.contents().text(); if (!txt) return out;
  try{
    const data = JSON.parse(txt);
    (function walk(n){
      if (!n || typeof n!=='object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      const title = first(n.name,n.title,n.productTitle,n.partTitle);
      const url   = first(n.url,n.productUrl,n.canonicalUrl,n.href);
      const image = first(n.image,n.imageUrl,n.imageURL);
      if (title && url) out.push({ title, link: absUrl(url, BASE_RC), image: absUrl(image||'', BASE_RC) });
      for (const k of Object.keys(n)) walk(n[k]);
    })(data);
  }catch{}
  const seen = new Set();
  return out.filter(x=>{ if(!x.link||seen.has(x.link)) return false; seen.add(x.link); return true; });
}

/* ===== Sears: добор картинок с целевой страницы (модели/детали) ===== */
async function searsEnrichImages(items, limit=6){
  let used=0;
  for (const it of items){
    if (used>=limit) break;
    if (it.source!=='SearsPartsDirect') continue;
    if (it.image) continue;
    if (!it.url) continue;
    const isModel = /\/model\//i.test(it.url);
    const isPart  = /\/part\/|\/product\//i.test(it.url);
    try{
      const base = it.url.split('/').slice(0,3).join('/');
      const html = await httpGet(it.url, { 'Referer': base+'/' });
      const $ = cheerio.load(html);
      let found = '';

      if (isModel){
        // ищем первую карточку детали
        $('a[href*="/part/"], a[href*="/product/"]').each((_,a)=>{
          if (found) return;
          const box = $(a).closest('.part-card, .product-card, .card, [data-component="product-card"]');
          const raw = box.find('img').attr('src') || box.find('img').attr('srcset') || '';
          const abs = absUrl(raw, BASE_SEARS);
          if (isSearsCDN(abs)) found = abs;
        });
      }

      if (!found){
        // с любой страницы: любой img, но только Sears CDN
        $('img').each((_,img)=>{
          if (found) return;
          const raw = $(img).attr('src') || $(img).attr('srcset') || '';
          const abs = absUrl(raw, BASE_SEARS);
          if (isSearsCDN(abs)) found = abs;
        });
      }

      if (!found && isPart){
        // как крайний случай на странице детали — og:image, но только с Sears CDN
        const og = $('meta[property="og:image"]').attr('content') || '';
        const abs = absUrl(og, BASE_SEARS);
        if (isSearsCDN(abs)) found = abs;
      }

      if (found){ it.image = found; used++; }
    }catch{/* ignore */}
  }
  return items;
}

/* ========== SOURCES ========== */
export const sources = [
  /* -------- SearsPartsDirect -------- */
  {
    name: 'SearsPartsDirect',
    searchUrl: (q)=> `${BASE_SEARS}/search?q=${encodeURIComponent(q)}`,
    parser: async (html)=>{
      const $ = cheerio.load(html);
      const out = [];

      // детали/товары (сразу с миниатюрами из Sears CDN)
      $('.part-card, .product-card, .card, [data-component="product-card"], a[href*="/part/"], a[href*="/product/"]').each((_,el)=>{
        const el$ = $(el);
        const a$  = el$.is('a') ? el$ : el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!/\/part\/|\/product\//i.test(href||'')) return;

        const title = first(el$.find('.card-title').text(), el$.find('.product-title').text(), el$.text());
        const link  = absUrl(href, BASE_SEARS);
        const image = pickSearsThumb(el$);
        const availability = t(el$.find('.availability, [data-qa="availability"]').text());

        out.push({
          title: t(title), link, image,
          source: 'SearsPartsDirect',
          part_number: pn(title),
          availability,
          oem_flag: detectOEM(title)
        });
      });

      // модели (карточки + любые ссылки на /model/)
      if (!out.length){
        // карточки
        $('.model-card, [data-component="model-card"], .card, .product-card').each((_,el)=>{
          const el$ = $(el);
          let modelHref = '';
          el$.find('a[href]').each((_,a)=>{
            const h = $(a).attr('href') || '';
            const txt = t($(a).text()).toLowerCase();
            if (/\/model\//i.test(h)) modelHref = modelHref || h;
            if (/shop\s*parts/i.test(txt) && h) modelHref = h; // приоритет кнопке
          });
          if (!modelHref) return;
          const link = absUrl(modelHref, BASE_SEARS);
          const title = first(el$.find('.card-title, .product-title, .model-title').text(), el$.attr('aria-label'), el$.text());
          const image = pickSearsThumb(el$);
          out.push({ title:t(title), link, image, source:'SearsPartsDirect', part_number: pn(title), oem_flag: detectOEM(title) });
        });

        // любые ссылки /model/ по странице
        if (!out.length){
          const seen = new Set();
          $('a[href*="/model/"]').each((_,a)=>{
            const h = $(a).attr('href') || '';
            if (!h || seen.has(h)) return;
            seen.add(h);
            const link = absUrl(h, BASE_SEARS);
            const title = t($(a).text()) || link;
            out.push({ title, link, image:'', source:'SearsPartsDirect', part_number: pn(title), oem_flag: detectOEM(title) });
          });
        }
      }

      // добираем картинки у моделей/деталей без превью (до 6 запросов)
      await searsEnrichImages(out, 6);

      // de-dup
      const seen = new Set();
      return out.filter(x=>{ const k=x.link; if(!k||seen.has(k)) return false; seen.add(k); return true; });
    }
  },

  /* -------- RepairClinic -------- */
  {
    name: 'RepairClinic',
    searchUrl: (q)=> `${BASE_RC}/Shop-For-Parts?query=${encodeURIComponent(q)}`,
    parser: async (html, q)=>{
      const $ = cheerio.load(html);
      let out = [];

      // плитки
      const tiles = $("[data-qa='product-tile'], [data-automation-id='product-tile'], .product-card, .product-tile, .search-results__grid-item, .product-grid__item");
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

        // картинки берём из разных мест: data-*, srcset, src → разворачиваем
        let imgRaw = el$.find('img').attr('data-src')
                 || el$.find('img').attr('data-original')
                 || el$.find('img').attr('data-srcset')
                 || el$.find('img').attr('srcset')
                 || el$.find('img').attr('src')
                 || '';

        out.push({
          title: t(title),
          link : absUrl(href, BASE_RC),
          image: absUrl(imgRaw, BASE_RC),
          source:'RepairClinic',
          part_number: pn(title)
        });
      });

      // JSON-LD
      if (!out.length){
        const ld = rcFromJsonLD($);
        if (ld.length) out = ld.map(x=>({ ...x, source:'RepairClinic', part_number: pn(x.title) }));
      }

      // Next.js data
      if (!out.length){
        const nx = rcFromNextData($);
        if (nx.length) out = nx.map(x=>({ ...x, source:'RepairClinic', part_number: pn(x.title) }));
      }

      // если всё же пусто — правильная ссылка на поиск
      if (!out.length && q){
        out.push({
          title:`Открыть поиск RepairClinic: ${q}`,
          link: `${BASE_RC}/Shop-For-Parts?query=${encodeURIComponent(q)}`,
          image:'',
          source:'RepairClinic',
          part_number: pn(q)
        });
      }

      // попытка добора картинок для карточек RC без фото: идём на страницу детали и берём og:image
      let used = 0;
      for (const it of out){
        if (used>=6) break;
        if (it.image || !it.link) continue;
        try{
          const base = it.link.split('/').slice(0,3).join('/');
          const html2 = await httpGet(it.link, { 'Referer': base+'/' });
          const $2 = cheerio.load(html2);
          const og = $2('meta[property="og:image"]').attr('content') || '';
          const abs = absUrl(og, base);
          if (abs) { it.image = abs; used++; }
        }catch{ /* ignore */ }
      }

      const seen = new Set();
      return out.filter(x=>{ const k=x.link; if(!k||seen.has(k)) return false; seen.add(k); return true; });
    }
  }
];
