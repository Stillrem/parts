import axios from "axios";
import * as cheerio from "cheerio";

/* ========== helpers ========== */
function absolutize(src, base) {
  if (!src) return "";
  src = String(src).trim();
  if (!src) return "";
  // относительный путь
  if (src.startsWith("/")) return base.replace(/\/$/, "") + src;
  // протокол-относительный
  if (src.startsWith("//")) return "https:" + src;
  return src;
}

// Разворачиваем Next.js-оптимизатор: /_next/image?url=<ENCODED>&w=...&q=...
function unwrapNextImage(src) {
  if (!src) return "";
  try {
    const u = new URL(src, "https://dummy.base"); // позволяет парсить относительные /_next/image
    if (u.pathname.includes("/_next/image") && u.searchParams.has("url")) {
      const original = u.searchParams.get("url");
      return decodeURIComponent(original || "");
    }
  } catch {}
  return src;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

/* ========== public API ========== */
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

  /* -------- RepairClinic -------- */
  {
    name: "RepairClinic",
    searchUrl: (query) =>
      `https://www.repairclinic.com/Shop-For-Parts?query=${encodeURIComponent(
        query
      )}`,

    parser: async (html) => {
      const $ = cheerio.load(html);
      const results = [];

      // Основные плитки результатов (несколько селекторов на всякий случай)
      const tiles = $(
        "[data-qa='product-tile'], [data-automation-id='product-tile'], .product-card, .product-tile, .search-results__grid-item, .product-grid__item"
      );

      tiles.each((_, el) => {
        const el$ = $(el);

        // Заголовок
        const title = firstNonEmpty(
          el$.find("[data-qa='product-title']").text(),
          el$.find(".product-title").text(),
          el$.find("a[title]").attr("title"),
          el$.text()
        );

        // Ссылка
        let href = el$.find("a[href]").first().attr("href") || "";
        if (!href) return;
        const link = absolutize(href, "https://www.repairclinic.com");

        // Картинка: сначала берём то, что есть у <img>, затем разворачиваем /_next/image
        let imgRaw =
          el$.find("img").attr("data-src") ||
          el$.find("img").attr("data-original") ||
          el$.find("img").attr("srcset") ||
          el$.find("img").attr("src") ||
          "";

        // Разворачиваем Next.js-оптимизатор
        imgRaw = unwrapNextImage(imgRaw);

        // Нормализуем к абсолютному URL (на случай относительных путей)
        const image = absolutize(imgRaw, "https://www.repairclinic.com");

        results.push({
          title: title.replace(/\s+/g, " ").trim(),
          link,
          image: image || null,
          source: "RepairClinic",
        });
      });

      return results;
    },
  },
];

/* ========== HTTP fetch helper для aggregate.js (если нужно) ========== */
export async function fetchSourceHtml(url) {
  // Используем "браузерные" заголовки — повышает шанс отдать правильную вёрстку
  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: url.split("/").slice(0, 3).join("/") + "/",
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) return res.data;
  throw new Error(`HTTP ${res.status} on ${url}`);
}
