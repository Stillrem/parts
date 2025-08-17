import * as cheerio from 'cheerio';
import httpGet from './http_get.js';

import * as cheerio from 'cheerio';

/* helpers */
const BASE_SEARS = 'https://www.searspartsdirect.com';
const t = (s)=>String(s||'').replace(/\s+/g,' ').trim();
const first = (...vals)=>{ for(const v of vals){ const x=t(v); if(x) return x; } return ''; };
const pnText = (s)=>{ const m=String(s).match(/[A-Z0-9\-]{5,}/i); return m?m[0].toUpperCase():''; };
// ВЫТЯГИВАЕМ PN из ссылки Sears: .../id-5304509451
const pnFromLink = (url)=>{ const m=String(url||'').match(/(?:^|[^\d])(\d{7,})\b/); return m?m[1].toUpperCase():''; };

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
  if (/\s+\d+x(?:,|$)/.test(src)) { const u0 = src.split(',')[0].trim().split(' ')[0].trim(); return absUrl(u0, base); }
  return src;
}
const isSearsCDN = (u)=>/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(String(u||''));

function pickSearsThumb($ctx){
  let img = absUrl($ctx.find('img').attr('src')||'', BASE_SEARS)
        || absUrl($ctx.find('img').attr('data-src')||'', BASE_SEARS);
  if (!isSearsCDN(img)){
    const srcset = $ctx.find('img').attr('srcset') || $ctx.find('img').attr('data-srcset') || '';
    if (srcset) img = absUrl(srcset, BASE_SEARS);
  }
  if (!isSearsCDN(img)){
    $ctx.find('picture source').each((_,s)=>{
      const ss = absUrl(s.attribs?.srcset||'', BASE_SEARS);
      if (isSearsCDN(ss)) { img = ss; return false; }
    });
  }
  if (!isSearsCDN(img)){
    $ctx.find('img').each((_,el)=>{
      const raw = el.attribs?.src || el.attribs?.['data-src'] || el.attribs?.srcset || el.attribs?.['data-srcset'] || '';
      const abs = absUrl(raw, BASE_SEARS);
      if (isSearsCDN(abs)) { img = abs; return false; }
    });
  }
  return isSearsCDN(img) ? img : '';
}

/* Sears: достать превью из всех возможных мест карточки */
function pickSearsThumb($ctx){
  // 1) прямые
  let img =
    absUrl($ctx.find('img').attr('src')||'', BASE_SEARS) ||
    absUrl($ctx.find('img').attr('data-src')||'', BASE_SEARS);

  // 2) srcset / data-srcset
  if (!isSearsCDN(img)) {
    const srcset = $ctx.find('img').attr('srcset') || $ctx.find('img').attr('data-srcset') || '';
    if (srcset) img = absUrl(srcset, BASE_SEARS);
  }

  // 3) <picture><source srcset=...>
  if (!isSearsCDN(img)) {
    let found = '';
    $ctx.find('picture source').each((_,s)=>{
      if (found) return;
      const ss = $(s).attr('srcset') || '';
      const abs = absUrl(ss, BASE_SEARS);
      if (isSearsCDN(abs)) found = abs;
    });
    if (found) img = found;
  }

  // 4) запасной обход всех <img> в карточке
  if (!isSearsCDN(img)) {
    $ctx.find('img').each((_,el)=>{
      if (img && isSearsCDN(img)) return;
      const raw = el.attribs?.src || el.attribs?.['data-src'] || el.attribs?.srcset || el.attribs?.['data-srcset'] || '';
      const abs = absUrl(raw, BASE_SEARS);
      if (isSearsCDN(abs)) img = abs;
    });
  }

  return isSearsCDN(img) ? img : '';
}

/* RC fallbacks */
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

/* Sears: добор картинок с целевой страницы (модель/деталь) */
async function searsEnrichImages(items, limit=24){
  let used=0;
  for (const it of items){
    if (used>=limit) break;
    if (it.source!=='SearsPartsDirect') continue;
    if (it.image) continue;
    if (!it.url) continue;

    try{
      const base = it.url.split('/').slice(0,3).join('/');
      const html = await httpGet(it.url, { 'Referer': base+'/' });
      const $ = cheerio.load(html);
      let found = '';

      // приоритет — картинки деталей внутри страницы
      $('a[href*="/part/"], a[href*="/product/"]').each((_,a)=>{
        if (found) return;
        const box = $(a).closest('.part-card, .product-card, .card, [data-component="product-card"]');
        const raw = box.find('img').attr('src') || box.find('img').attr('data-src') || box.find('img').attr('srcset') || box.find('img').attr('data-srcset') || '';
        const abs = absUrl(raw, BASE_SEARS);
        if (isSearsCDN(abs)) found = abs;
        if (!found){
          // picture>source на странице детали/модели
          box.find('picture source').each((_,s)=>{
            if (found) return;
            const ss = $(s).attr('srcset') || '';
            const abs2 = absUrl(ss, BASE_SEARS);
            if (isSearsCDN(abs2)) found = abs2;
          });
        }
      });

      // любой <img> на странице, но только Sears CDN
      if (!found){
        $('img').each((_,img)=>{
          if (found) return;
          const raw = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('srcset') || $(img).attr('data-srcset') || '';
          const abs = absUrl(raw, BASE_SEARS);
          if (isSearsCDN(abs)) found = abs;
        });
      }

      // крайний случай — og:image, только если с Sears CDN
      if (!found){
        const og = $('meta[property="og:image"]').attr('content') || '';
        const abs = absUrl(og, BASE_SEARS);
        if (isSearsCDN(abs)) found = abs;
      }

      if (found){ it.image = found; used++; }
    }catch{/* ignore */}
  }
  return items;
}

/* ===== SOURCES ===== */
export const sources = [
  {
    name: 'SearsPartsDirect',
    searchUrl: (q)=> `${BASE_SEARS}/search?q=${encodeURIComponent(q)}`,
    parser: async (html)=>{
      const $ = cheerio.load(html);
      const out = [];

      // детали/товары
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
        $('.model-card, [data-component="model-card"], .card, .product-card').each((_,el)=>{
          const el$ = $(el);
          let modelHref = '';
          el$.find('a[href]').each((_,a)=>{
            const h = $(a).attr('href') || '';
            const txt = t($(a).text()).toLowerCase();
            if (/\/model\//i.test(h)) modelHref = modelHref || h;
            if (/shop\s*parts/i.test(txt) && h) modelHref = h;
          });
          if (!modelHref) return;

          const link = absUrl(modelHref, BASE_SEARS);
          const title = first(el$.find('.card-title, .product-title, .model-title').text(), el$.attr('aria-label'), el$.text());
          const image = pickSearsThumb(el$);

          out.push({ title: t(title), link, image, source:'SearsPartsDirect', part_number: pn(title), oem_flag: detectOEM(title) });
        });

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

      // добор картинок у Sears (до 24 карточек)
      await searsEnrichImages(out, 24);

      // de-dup
      const seen = new Set();
      return out.filter(x=>{ const k=x.link; if(!k||seen.has(k)) return false; seen.add(k); return true; });
    }
  },

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

      // JSON-LD / Next.js
      if (!out.length){
        const ld = rcFromJsonLD($);
        if (ld.length) out = ld.map(x=>({ ...x, source:'RepairClinic', part_number: pn(x.title) }));
      }
      if (!out.length){
        const nx = rcFromNextData($);
        if (nx.length) out = nx.map(x=>({ ...x, source:'RepairClinic', part_number: pn(x.title) }));
      }

      // если пусто — ссылка на правильный поиск
      if (!out.length && q){
        out.push({ title:`Открыть поиск RepairClinic: ${q}`, link:`${BASE_RC}/Shop-For-Parts?query=${encodeURIComponent(q)}`, image:'', source:'RepairClinic', part_number: pn(q) });
      }

      // добор картинок на RC из og:image (до 8 карточек)
      let used = 0;
      for (const it of out){
        if (used>=8) break;
        if (it.image || !it.link) continue;
        try{
          const base = it.link.split('/').slice(0,3).join('/');
          const html2 = await httpGet(it.link, { 'Referer': base+'/' });
          const $2 = cheerio.load(html2);
          const og = $2('meta[property="og:image"]').attr('content') || '';
          const abs = absUrl(og, base);
          if (abs) { it.image = abs; used++; }
        }catch{}
      }

      const seen = new Set();
      return out.filter(x=>{ const k=x.link; if(!k||seen.has(k)) return false; seen.add(k); return true; });
    }
  }
];
