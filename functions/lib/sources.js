// functions/lib/sources.js
import * as cheerio from "cheerio";

/* ========== helpers (без внешних зависимостей) ========== */

// Разворачиваем Next.js оптимизатор: "/_next/image?url=<ENCODED>&w=..."
function unwrapNextImage(src) {
  if (!src) return "";
  try {
    const u = new URL(src, "https://dummy.base"); // позволяет парсить относительные пути
    if (u.pathname.includes("/_next/image") && u.searchParams.has("url")) {
      const original = u.searchParams.get("url");
      return decodeURIComponent(original || "");
    }
  } catch {}
  return src;
}

function absolutize(src, base) {
  if (!src) return "";
  src = String(src).trim();
  if (!src) return "";
  // сперва разворачиваем /_next/image (актуально для RepairClinic)
  src = unwrapNextImage(src);
  if (src.startsWith("//")) return "https:" + src;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("/")) return base.replace(/\/$/, "") + src;
  // srcset: берём первый URL
  if (/\s+\d+x(?:,|$)/.test(src)) {
    const first = src.split(",")[0].trim().split(" ")[0].trim();
    return absolutize(first, base);
  }
  return src;
}

function textClean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const t = textClean(v);
    if (t) return t;
  }
  return "";
}

/** Sears: выбрать product-thumb ТОЛЬКО с CDN s.sears.com */
function pickSearsThumb($ctx) {
  const BASE = "https://www.searspartsdirect.com";

  // 1) прямой src у первого <img>
  let img = absolutize($ctx.find("img").attr("src") || "", BASE);
  if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(img)) return img;

  // 2) перебор всех картинок внутри карточки в поисках CDN Sears
  $ctx.find("img").each((_, el) => {
    const raw =
      el.attribs?.src ||
      el.attribs?.["data-src"] ||
      el.attribs?.srcset ||
      "";
    const abs = absolutize(raw, BASE);
    if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)) {
      img = abs;
      return false; // break
    }
  });

  return img || "";
}

/* ========== PUBLIC API: экспорт одного массива sources ========== */
export const sources = [
  // -------- SearsPartsDirect --------
  {
    name: "SearsPartsDirect",
    searchUrl: (query) =>
      `https://www.searspartsdirect.com/search?q=${encodeURIComponent(query)}`,

    // parser получает готовый HTML (его скачивает aggregate.js) и НИЧЕГО не делает с сетью
    parser: async (html) => {
      const $ = cheerio.load(html);
      const results = [];

      // 1) карточки деталей/товаров на странице поиска
      $(
        ".part-card, .product-card, .card, [data-component='product-card'], a[href*='/part/'], a[href*='/product/']"
      ).each((_, el) => {
        const el$ = $(el);
        const a$ = el$.is("a") ? el$ : el$.find("a[href]").first();
        const href = a$.attr("href") || "";
        if (!/\/part\/|\/product\//i.test(href || "")) return;

        const title = firstNonEmpty(
          el$.find(".card-title").text(),
          el$.find(".product-title").text(),
          el$.text()
        );

        const link = absolutize(href, "https://www.searspartsdirect.com");
        const image = pickSearsThumb(el$); // только s.sears.com/is/image/Sears/...

        results.push({
          title,
          link,
          image: image || null,
          source: "SearsPartsDirect",
        });
      });

      // 2) fallback: карточки МОДЕЛЕЙ (Shop parts), если деталей нет
      if (!results.length) {
        $(".card, .product-card, [data-component='product-card']").each(
          (_, el) => {
            const el$ = $(el);
            const a$ = el$.find("a[href]").first();
            const href = a$.attr("href") || "";
            if (!/\/model\//i.test(href || "")) return;

            // пытаемся найти кнопку "Shop parts"
            let shop = "";
            el$.find("a[href]").each((_, x) => {
              const t = textClean($(x).text()).toLowerCase();
              const h = $(x).attr("href") || "";
              if (/shop\s*parts/i.test(t) && h) shop = h;
            });

            const link = absolutize(
              shop || href,
              "https://www.searspartsdirect.com"
            );
            const title = textClean(el$.text());
            const image = pickSearsThumb(el$);

            results.push({
              title,
              link,
              image: image || null,
              source: "SearsPartsDirect",
            });
          }
        );
      }

      return results;
    },
  },

  // -------- RepairClinic --------
  {
    name: "RepairClinic",
    searchUrl: (query) =>
      `https://www.repairclinic.com/Shop-For-Parts?query=${encodeURIComponent(
        query
      )}`,

    parser: async (html) => {
      const $ = cheerio.load(html);
      const results = [];

      // плитки результатов (несколько селекторов, т.к. разметка может меняться)
      $(
        "[data-qa='product-tile'], [data-automation-id='product-tile'], .product-card, .product-tile, .search-results__grid-item, .product-grid__item"
      ).each((_, el) => {
        const el$ = $(el);
        const a$ = el$.find("a[href]").first();
        const href = a$.attr("href") || "";
        if (!href) return;

        const title = firstNonEmpty(
          el$.find("[data-qa='product-title']").text(),
          el$.find(".product-title").text(),
          a$.attr("title"),
          el$.text()
        );

        // IMG: data-*, srcset, src → разворачиваем /_next/image → абсолютный URL
        let imgRaw =
          el$.find("img").attr("data-src") ||
          el$.find("img").attr("data-original") ||
          el$.find("img").attr("data-srcset") ||
          el$.find("img").attr("srcset") ||
          el$.find("img").attr("src") ||
          "";
        const image = absolutize(imgRaw, "https://www.repairclinic.com");

        const link = absolutize(href, "https://www.repairclinic.com");

        results.push({
          title,
          link,
          image: image || null,
          source: "RepairClinic",
        });
      });

      // Если RC отдал анти-бот и плиток нет — вернём пусто;
      // твой aggregate уже покажет fallback-карточку "Открыть поиск…" или просто вернёт другие источники.
      return results;
    },
  },
];
