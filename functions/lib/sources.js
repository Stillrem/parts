// functions/lib/sources.js
import * as cheerio from 'cheerio';

const BASE_SEARS  = 'https://www.searspartsdirect.com';
const BASE_RC     = 'https://www.repairclinic.com';
const BASE_RP     = 'https://www.reliableparts.com';
const BASE_APP    = 'https://www.appliancepartspros.com';
const BASE_PS     = 'https://www.partselect.com';
const BASE_ENC    = 'https://www.encompass.com';
const BASE_MAR    = 'https://www.marcone.com';
const BASE_EBAY   = 'https://www.ebay.com';
const BASE_AMZ    = 'https://www.amazon.com';
const BASE_WMT    = 'https://www.walmart.com';

// Утилиты
const t = (s)=>String(s||'').replace(/\s+/g,' ').trim();
const first = (...vals)=>{ for (const v of vals){ const x=t(v); if (x) return x; } return ''; };

// PN из текста (запасной вариант)
const pnText = (s)=>{
  const m = String(s).match(/[A-Z0-9\-]{5,}/i);
  return m ? m[0].toUpperCase() : '';
};

// PN из URL Sears: .../id-5304509451 (7+ цифр)
const pnFromLink = (url)=>{
  const m = String(url||'').match(/(?:^|[^\d])(\d{7,})\b/);
  return m ? m[1].toUpperCase() : '';
};

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
  // случай с srcset: "https://... 1x, https://... 2x"
  if (/\s+\d+x(?:,|$)/.test(src)) {
    const u0 = src.split(',')[0].trim().split(' ')[0].trim();
    return absUrl(u0, base);
  }
  return src;
}

/* === Sears CDN helper === */
const isSearsCDN = (u)=>/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(String(u||''));

function pickSearsThumb($ctx){
  let img =
    absUrl($ctx.find('img').attr('src')||'', BASE_SEARS) ||
    absUrl($ctx.find('img').attr('data-src')||'', BASE_SEARS);

  if (!isSearsCDN(img)) {
    const srcset = $ctx.find('img').attr('srcset') || $ctx.find('img').attr('data-srcset') || '';
    if (srcset) img = absUrl(srcset, BASE_SEARS);
  }

  if (!isSearsCDN(img)) {
    let found = '';
    $ctx.find('picture source').each((_,s)=>{
      if (found) return;
      const ss = absUrl(s.attribs?.srcset||'', BASE_SEARS);
      if (isSearsCDN(ss)) found = ss;
    });
    if (found) img = found;
  }

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

/* === RepairClinic fallbacks === */
function rcFromJsonLD($){
  const out=[];
  $('script[type="application/ld+json"]').each((_,el)=>{
    const raw=$(el).contents().text(); if(!raw) return;
    try{
      const data=JSON.parse(raw);
      const arr=Array.isArray(data)?data:[data];
      for(const d of arr){
        if(!d) continue;
        if(d['@type']==='Product'){
          const title=first(d.name,d.title);
          const url=absUrl(d.url||'', BASE_RC);
          const image=absUrl(Array.isArray(d.image)?d.image[0]:d.image||'', BASE_RC);
          if(title && url) out.push({title,link:url,image});
        }
        if(Array.isArray(d.itemListElement)){
          for(const it of d.itemListElement){
            const item=it && (it.item||it);
            if(!item) continue;
            const title=first(item.name,item.title);
            const url=absUrl(item.url||item.canonicalUrl||'', BASE_RC);
            const image=absUrl(Array.isArray(item.image)?item.image[0]:item.image||'', BASE_RC);
            if(title && url) out.push({title,link:url,image});
          }
        }
      }
    }catch{}
  });
  const seen=new Set();
  return out.filter(x=>{ if(!x.link||seen.has(x.link)) return false; seen.add(x.link); return true; });
}

function rcFromNextData($){
  const out=[]; const el=$('#__NEXT_DATA__').first(); if(!el.length) return out;
  const txt=el.contents().text(); if(!txt) return out;
  try{
    const data=JSON.parse(txt);
    (function walk(n){
      if(!n || typeof n!=='object') return;
      if(Array.isArray(n)) return n.forEach(walk);
      const title=first(n.name,n.title,n.productTitle,n.partTitle);
      const url=first(n.url,n.productUrl,n.canonicalUrl,n.href);
      const image=first(n.image,n.imageUrl,n.imageURL);
      if(title && url) out.push({title,link:absUrl(url,BASE_RC),image:absUrl(image||'',BASE_RC)});
      for(const k of Object.keys(n)) walk(n[k]);
    })(data);
  }catch{}
  const seen=new Set();
  return out.filter(x=>{ if(!x.link||seen.has(x.link)) return false; seen.add(x.link); return true; });
}

/* ===== SOURCES ===== */
export const sources = [
  /* SearsPartsDirect */
{
  name: 'SearsPartsDirect',
  searchUrl: q => `${BASE_SEARS}/search?q=${encodeURIComponent(q)}`,
  parser: async (html, q) => {
    const $ = cheerio.load(html);
    let out = [];

    // Модель, которую ввёл пользователь (DLE4970W → только буквы/цифры)
    const qModelRaw = String(q || '').toUpperCase().trim();
    const qModel = qModelRaw.replace(/[^A-Z0-9]/g, '');

    /* 1. СНАЧАЛА ПРОБУЕМ НАЙТИ ТОЧНУЮ МОДЕЛЬ /model/... */

    if (qModel) {
      const exactModels = [];
      const seenLinks = new Set();
      const reModel = new RegExp(`\\b${qModel}\\b`);

      $('a[href*="/model/"]').each((_, a) => {
        const href = $(a).attr('href') || '';
        if (!href || seenLinks.has(href)) return;

        const link = absUrl(href, BASE_SEARS);
        const title = t($(a).text()) || link;

        const matchStr = (title + ' ' + link).toUpperCase().replace(/[^A-Z0-9]/g, ' ');
        if (!reModel.test(matchStr)) return; // пропускаем DLE4970WE и т.п.

        seenLinks.add(href);

        // Пытаемся взять картинку из ближайшей карточки модели
        const card$ = $(a).closest('.model-card, .card, .product-card');
        const image = card$.length ? pickSearsThumb(card$) : '';

        exactModels.push({
          title,
          link,
          image,
          source: 'SearsPartsDirect',
          part_number: qModel    // красиво покажет Part #DLE4970W
        });
      });

      if (exactModels.length) {
        // Если нашлись точные совпадения по модели — возвращаем ТОЛЬКО их
        return exactModels;
      }
    }

    /* 2. ЕСЛИ ТОЧНОЙ МОДЕЛИ НЕТ — СТАРОЕ ПОВЕДЕНИЕ (ДЕТАЛИ + МОДЕЛИ) */

    // детали / товары
    $('.part-card, .product-card, .card, [data-component="product-card"], a[href*="/part/"], a[href*="/product/"]').each(
      (_, el) => {
        const el$ = $(el);
        const a$ = el$.is('a') ? el$ : el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!/\/part\/|\/product\//i.test(href || '')) return;

        const title = first(
          el$.find('.card-title').text(),
          el$.find('.product-title').text(),
          el$.text()
        );
        const link = absUrl(href, BASE_SEARS);
        const image = pickSearsThumb(el$);
        const part_number = pnFromLink(link) || pnText(title);

        out.push({
          title: t(title),
          link,
          image,
          source: 'SearsPartsDirect',
          part_number
        });
      }
    );

    // модели (если деталей нет)
    if (!out.length) {
      $('.model-card, [data-component="model-card"], .card, .product-card').each(
        (_, el) => {
          const el$ = $(el);
          let modelHref = '';

          el$.find('a[href]').each((_, a) => {
            const h = $(a).attr('href') || '';
            const txt = t($(a).text()).toLowerCase();
            if (/\/model\//i.test(h)) modelHref = modelHref || h;
            if (/shop\s*parts/i.test(txt) && h) modelHref = h;
          });

          if (!modelHref) return;
          const link = absUrl(modelHref, BASE_SEARS);
          const title = first(
            el$.find('.card-title, .product-title, .model-title').text(),
            el$.attr('aria-label'),
            el$.text()
          );
          const image = pickSearsThumb(el$);
          const part_number = pnFromLink(link) || pnText(title);

          out.push({
            title: t(title),
            link,
            image,
            source: 'SearsPartsDirect',
            part_number
          });
        }
      );

      // любые ссылки /model/ (fallback)
      if (!out.length) {
        const seen = new Set();
        $('a[href*="/model/"]').each((_, a) => {
          const h = $(a).attr('href') || '';
          if (!h || seen.has(h)) return;
          seen.add(h);

          const link = absUrl(h, BASE_SEARS);
          const title = t($(a).text()) || link;
          const part_number = pnFromLink(link) || pnText(title);

          out.push({
            title,
            link,
            image: '',
            source: 'SearsPartsDirect',
            part_number
          });
        });
      }
    }

    // убираем дубликаты по ссылке
    const seen = new Set();
    out = out.filter(x => {
      const k = x.link;
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return out;
  }
},

  /* --- RepairClinic --- */
  {
    name: 'RepairClinic',
    searchUrl: (q)=> `${BASE_RC}/Shop-For-Parts?query=${encodeURIComponent(q)}`,
    parser: async (html, q)=>{
      const $=cheerio.load(html);
      let out=[];

      const tiles = $(
        "[data-qa='product-tile'], [data-automation-id='product-tile'], .product-card, .product-tile, .search-results__grid-item, .product-grid__item"
      );

      tiles.each((_,el)=>{
        const el$=$(el);
        const a$=el$.find('a[href]').first();
        const href=a$.attr('href')||'';
        if(!href) return;

        const title=first(
          el$.find("[data-qa='product-title']").text(),
          el$.find('.product-title').text(),
          a$.attr('title'),
          el$.text()
        );

        let imgRaw =
          el$.find('img').attr('data-src')      ||
          el$.find('img').attr('data-original') ||
          el$.find('img').attr('data-srcset')   ||
          el$.find('img').attr('srcset')        ||
          el$.find('img').attr('src')           ||
          '';

        out.push({
          title: t(title),
          link : absUrl(href, BASE_RC),
          image: absUrl(imgRaw, BASE_RC),
          source:'RepairClinic',
          part_number: pnText(title)
        });
      });

      if(!out.length){
        const ld=rcFromJsonLD($);
        if(ld.length) {
          out = ld.map(x=>({
            ...x,
            source:'RepairClinic',
            part_number: pnText(x.title)
          }));
        }
      }

      if(!out.length){
        const nx=rcFromNextData($);
        if(nx.length) {
          out = nx.map(x=>({
            ...x,
            source:'RepairClinic',
            part_number: pnText(x.title)
          }));
        }
      }

      if(!out.length && q){
        out.push({
          title:`Открыть поиск RepairClinic: ${q}`,
          link:`${BASE_RC}/Shop-For-Parts?query=${encodeURIComponent(q)}`,
          image:'',
          source:'RepairClinic',
          part_number: pnText(q)
        });
      }

      const seen=new Set();
      return out.filter(x=>{
        const k=x.link;
        if(!k||seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  },

  /* --- ReliableParts --- */
  {
    name: 'ReliableParts',
    searchUrl: (q)=> `${BASE_RP}/catalogsearch/result/?q=${encodeURIComponent(q)}`,
    parser: async (html, q)=>{
      const $ = cheerio.load(html);
      const out = [];

      $('.product-item').each((_, el) => {
        const el$ = $(el);

        const a$ =
          el$.find('.product-item-link').first().length
            ? el$.find('.product-item-link').first()
            : el$.find('a[href]').first();

        const href = a$.attr('href') || '';
        if (!href) return;

        const link = absUrl(href, BASE_RP);

        const title = first(
          a$.text(),
          el$.find('.product-item-name').text(),
          el$.find('h2, h3').first().text(),
          el$.text()
        );

        let imgRaw =
          el$.find('img.product-image-photo').attr('src') ||
          el$.find('img').attr('data-src') ||
          el$.find('img').attr('srcset') ||
          el$.find('img').attr('src') ||
          '';

        const image = absUrl(imgRaw, BASE_RP);

        const blockText = t(el$.text());
        const pn =
          pnText(blockText) ||
          pnText(title)      ||
          pnText(link);

        const priceText = t(
          el$.find('.price').first().text() ||
          el$.find('[data-price-type="finalPrice"]').first().text()
        );
        const priceNum = priceText
          .replace(/[^0-9.,]/g, '')
          .replace(',', '.');

        const availability = /in stock/i.test(blockText) ? 'In stock' : '';

        out.push({
          title: t(title),
          link,
          image,
          source: 'ReliableParts',
          part_number: pn,
          price: priceNum || '',
          currency: priceText.includes('$') ? 'USD' : '',
          availability
        });
      });

      if (!out.length && q) {
        out.push({
          title: `Открыть поиск ReliableParts: ${q}`,
          link: `${BASE_RP}/catalogsearch/result/?q=${encodeURIComponent(q)}`,
          image: '',
          source: 'ReliableParts',
          part_number: pnText(q)
        });
      }

      const seen = new Set();
      return out.filter(x => {
        const k = x.link;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  },

  /* --- AppliancePartsPros --- */
  {
    name: 'AppliancePartsPros',
    searchUrl: (q)=> `${BASE_APP}/search.aspx?searchtext=${encodeURIComponent(q)}`,
    parser: async (html, q)=>{
      const $ = cheerio.load(html);
      const out = [];

      // разные возможные контейнеры результатов
      $('.searchProduct, .list-item, .product-list-item, .product').each((_, el)=>{
        const el$ = $(el);
        const a$  = el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!href) return;

        const link = absUrl(href, BASE_APP);

        const title = first(
          el$.find('.productname, .searchProductTitle').text(),
          el$.find('h2, h3').first().text(),
          a$.attr('title'),
          a$.text()
        );

        let imgRaw =
          el$.find('img').attr('data-src') ||
          el$.find('img').attr('src') ||
          '';
        const image = absUrl(imgRaw, BASE_APP);

        const blockText = t(el$.text());
        const pn = pnText(blockText) || pnText(title) || pnText(link);

        out.push({
          title: t(title),
          link,
          image,
          source: 'AppliancePartsPros',
          part_number: pn
        });
      });

      if (!out.length && q){
        out.push({
          title: `Открыть поиск AppliancePartsPros: ${q}`,
          link: `${BASE_APP}/search.aspx?searchtext=${encodeURIComponent(q)}`,
          image: '',
          source: 'AppliancePartsPros',
          part_number: pnText(q)
        });
      }

      const seen = new Set();
      return out.filter(x=>{
        const k=x.link;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  },

  /* --- PartSelect --- */
  {
    name: 'PartSelect',
    searchUrl: (q)=> `${BASE_PS}/Search.aspx?SearchText=${encodeURIComponent(q)}`,
    parser: async (html, q)=>{
      const $ = cheerio.load(html);
      const out = [];

      $('.search-result, .ps-product-list__item, .product-list-item').each((_, el)=>{
        const el$ = $(el);
        const a$  = el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!href) return;

        const link = absUrl(href, BASE_PS);

        const title = first(
          el$.find('.product-title, .ps-product-list__title').text(),
          el$.find('h2, h3').first().text(),
          a$.attr('title'),
          a$.text()
        );

        let imgRaw =
          el$.find('img').attr('data-src') ||
          el$.find('img').attr('src') ||
          '';
        const image = absUrl(imgRaw, BASE_PS);

        const blockText = t(el$.text());
        const pn = pnText(blockText) || pnText(title) || pnText(link);

        out.push({
          title: t(title),
          link,
          image,
          source: 'PartSelect',
          part_number: pn
        });
      });

      if (!out.length && q){
        out.push({
          title: `Открыть поиск PartSelect: ${q}`,
          link: `${BASE_PS}/Search.aspx?SearchText=${encodeURIComponent(q)}`,
          image: '',
          source: 'PartSelect',
          part_number: pnText(q)
        });
      }

      const seen = new Set();
      return out.filter(x=>{
        const k=x.link;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  },

  /* --- Encompass --- */
  {
    name: 'Encompass',
    // можно использовать общий поиск по PN
    searchUrl: (q)=> `${BASE_ENC}/search?q=${encodeURIComponent(q)}`,
    parser: async (html, q)=>{
      const $ = cheerio.load(html);
      const out = [];

      $('.product-item, .search-result-item, .result-item').each((_, el)=>{
        const el$ = $(el);
        const a$  = el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!href) return;

        const link = absUrl(href, BASE_ENC);

        const title = first(
          el$.find('.product-title, .item-title').text(),
          el$.find('h2, h3').first().text(),
          a$.attr('title'),
          a$.text()
        );

        let imgRaw =
          el$.find('img').attr('data-src') ||
          el$.find('img').attr('src') ||
          '';
        const image = absUrl(imgRaw, BASE_ENC);

        const blockText = t(el$.text());
        const pn = pnText(blockText) || pnText(title) || pnText(link);

        out.push({
          title: t(title),
          link,
          image,
          source: 'Encompass',
          part_number: pn
        });
      });

      if (!out.length && q){
        out.push({
          title: `Открыть поиск Encompass: ${q}`,
          link: `${BASE_ENC}/search?q=${encodeURIComponent(q)}`,
          image: '',
          source: 'Encompass',
          part_number: pnText(q)
        });
      }

      const seen = new Set();
      return out.filter(x=>{
        const k=x.link;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  },

  /* --- Marcone --- */
  {
    name: 'Marcone',
    searchUrl: (q)=> `${BASE_MAR}/Search?query=${encodeURIComponent(q)}`,
    parser: async (html, q)=>{
      const $ = cheerio.load(html);
      const out = [];

      $('.product, .product-item, .search-result-item').each((_, el)=>{
        const el$ = $(el);
        const a$  = el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!href) return;

        const link = absUrl(href, BASE_MAR);

        const title = first(
          el$.find('.product-title, .item-title').text(),
          el$.find('h2, h3').first().text(),
          a$.attr('title'),
          a$.text()
        );

        let imgRaw =
          el$.find('img').attr('data-src') ||
          el$.find('img').attr('src') ||
          '';
        const image = absUrl(imgRaw, BASE_MAR);

        const blockText = t(el$.text());
        const pn = pnText(blockText) || pnText(title) || pnText(link);

        out.push({
          title: t(title),
          link,
          image,
          source: 'Marcone',
          part_number: pn
        });
      });

      if (!out.length && q){
        out.push({
          title: `Открыть поиск Marcone: ${q}`,
          link: `${BASE_MAR}/Search?query=${encodeURIComponent(q)}`,
          image: '',
          source: 'Marcone',
          part_number: pnText(q)
        });
      }

      const seen = new Set();
      return out.filter(x=>{
        const k=x.link;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  },

    /* --- eBay --- */
{
  name: 'eBay',
  searchUrl: (q)=> `${BASE_EBAY}/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  parser: async (html, q)=>{
    const $ = cheerio.load(html);
    let out = [];

    // Вспомогательная функция: из одного блока вытащить карточку
    function pushFromBlock(el$) {
      const linkEl =
        el$.find('a.s-item__link[href]').first().length
          ? el$.find('a.s-item__link[href]').first()
          : el$.find('a[href*="/itm/"]').first();

      const href = linkEl.attr('href') || '';
      if (!href) return;

      const link = absUrl(href, BASE_EBAY);

      const title = first(
        el$.find('.s-item__title').text(),
        linkEl.attr('aria-label'),
        linkEl.text()
      );

      let imgRaw =
        el$.find('img.s-item__image-img').attr('src') ||
        el$.find('img').attr('data-src') ||
        el$.find('img').attr('src') ||
        '';

      const image = absUrl(imgRaw, BASE_EBAY);

      // ---- ЦЕНА ----
      const priceRaw = t(
        el$.find('.s-item__price').first().text() ||
        el$.find('[data-testid="item-price"]').first().text()
      );

      // только цифры + точка/запятая
      let priceNum = priceRaw.replace(/[^0-9.,]/g, '');
      priceNum = priceNum.replace(',', '.');
      if (!priceNum) priceNum = '';

      // ---- Part number без HTTPS/HTTP/WWW ----
      const pn = (() => {
        const upper = `${title || ''} ${link || ''}`.toUpperCase();
        const matches = upper.match(/[A-Z0-9\-]{5,}/g) || [];
        for (const m of matches) {
          if (m === 'HTTPS' || m === 'HTTP' || m === 'WWW') continue;
          return m;
        }
        return '';
      })();

      out.push({
        title: t(title || q),
        link,
        image,
        source: 'eBay',
        part_number: pn,
        price: priceNum,               // например "45.99"
        currency: priceNum ? 'USD' : ''// фронт сам добавит $/USD как у других
      });
    }

    // 1) Классическая разметка
    $('li.s-item').each((_, el) => {
      pushFromBlock($(el));
    });

    // 2) Иногда товары лежат в других контейнерах
    if (!out.length) {
      $('div.s-item__wrapper, [data-testid="item"]').each((_, el) => {
        pushFromBlock($(el));
      });
    }

    // 3) Жёсткий fallback: любые ссылки /itm/
    if (!out.length) {
      $('a[href*="/itm/"]').each((_, a) => {
        const el$ = $(a).closest('li, div').length ? $(a).closest('li, div') : $(a);
        pushFromBlock(el$);
      });
    }

    // 4) Если совсем ничего не распарсили — один fallback-элемент "открыть поиск"
    if (!out.length) {
      out = [{
        title: `Открыть поиск eBay: ${q}`,
        link: `${BASE_EBAY}/sch/i.html?_nkw=${encodeURIComponent(q)}`,
        image: '',
        source: 'eBay',
        part_number: pnText(q),
        price: '',
        currency: ''
      }];
    }

    const seen = new Set();
    return out.filter(x => {
      const k = x.link;
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
},

    /* --- Amazon --- */
  {
    name: 'Amazon',
    searchUrl: (q)=> `${BASE_AMZ}/s?k=${encodeURIComponent(q)}`,
    parser: async (html, q)=>{
      const $ = cheerio.load(html);
      const out = [];

      // аккуратно вытаскиваем заголовок товара
      const extractAmazonTitle = (el$)=>{
        const main = first(
          el$.find('span.a-size-medium.a-color-base.a-text-normal').text(),
          el$.find('span.a-size-base-plus.a-color-base.a-text-normal').text(),
          el$.find('h2 a span').text(),
          el$.find('h2 span').text()
        );
        if (main) return t(main);

        const fallback = first(
          el$.find('span.a-size-medium').text(),
          el$.find('span.a-size-base-plus').text()
        );
        if (fallback) return t(fallback);

        // если ничего не нашли, лучше понятный дефолт, чем пустая строка
        return 'Amazon item';
      };

      $('div[data-component-type="s-search-result"]').each((_, el)=>{
        const el$ = $(el);
        const a$  = el$.find(
          'a.a-link-normal.a-text-normal, a.a-link-normal.s-no-outline, a[href]'
        ).first();
        const href = a$.attr('href') || '';
        if (!href) return;

        const link  = absUrl(href, BASE_AMZ);
        const title = extractAmazonTitle(el$);

        let imgRaw =
          el$.find('img.s-image').attr('src') ||
          el$.find('img').attr('src') ||
          '';
        const image = absUrl(imgRaw, BASE_AMZ);

        const priceWhole = t(el$.find('span.a-price-whole').text());
        const priceFrac  = t(el$.find('span.a-price-fraction').text());
        const priceText  = (priceWhole || priceFrac)
          ? `$${priceWhole}${priceFrac}`
          : '';

        // PN берём только из заголовка, НЕ из URL, чтобы не ловить HTTPS
        let pn = pnText(title);
        if (pn === 'HTTPS') pn = '';   // страховка, на всякий случай

        out.push({
          title,
          link,
          image,
          source: 'Amazon',
          part_number: pn,
          price: priceText,
          currency: priceText ? 'USD' : ''
        });
      });

      if (!out.length && q){
        out.push({
          title: `Открыть поиск Amazon: ${q}`,
          link: `${BASE_AMZ}/s?k=${encodeURIComponent(q)}`,
          image: '',
          source: 'Amazon',
          part_number: pnText(q)
        });
      }

      const seen = new Set();
      return out.filter(x=>{
        const k=x.link;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  },

  /* --- Walmart --- */
  {
    name: 'Walmart',
    searchUrl: (q)=> `${BASE_WMT}/search?q=${encodeURIComponent(q)}`,
    parser: async (html, q)=>{
      const $ = cheerio.load(html);
      const out = [];

      // Walmart часто меняет разметку, берём общие контейнеры
      $('div.search-result-gridview-item, div[data-type="items"] div, div[data-automation-id="search-product"]').each((_, el)=>{
        const el$ = $(el);
        const a$  = el$.find('a[href]').first();
        const href = a$.attr('href') || '';
        if (!href) return;

        const link = absUrl(href, BASE_WMT);

        const title = first(
          el$.find('a span, .product-title, .line-clamp-2').first().text(),
          a$.attr('aria-label'),
          a$.text()
        );

        let imgRaw =
          el$.find('img').attr('data-image-src') ||
          el$.find('img').attr('src') ||
          '';
        const image = absUrl(imgRaw, BASE_WMT);

        const priceText = t(
          el$.find('span[aria-hidden="true"]').first().text() ||
          el$.find('.price-main').text()
        );

        const pn = pnText(title) || pnText(link);

        out.push({
          title: t(title),
          link,
          image,
          source: 'Walmart',
          part_number: pn,
          price: priceText,
          currency: priceText.includes('$') ? 'USD' : ''
        });
      });

      if (!out.length && q){
        out.push({
          title: `Открыть поиск Walmart: ${q}`,
          link: `${BASE_WMT}/search?q=${encodeURIComponent(q)}`,
          image: '',
          source: 'Walmart',
          part_number: pnText(q)
        });
      }

      const seen = new Set();
      return out.filter(x=>{
        const k=x.link;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  }
];
