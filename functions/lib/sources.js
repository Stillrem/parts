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
export const sources = [
  /* -------- SearsPartsDirect -------- */
  {
    name: "SearsPartsDirect",
    searchUrl: (query) =>
      `https://www.searspartsdirect.com/search?q=${encodeURIComponent(query)}`,

    parser: async (html) => {
      const $ = cheerio.load(html);
      const results = [];

      // Карточки деталей/товаров на странице поиска
      // Подхватываем несколько возможных контейнеров
      const cards = $(
        ".part-card, .product-card, .card, [data-component='product-card']"
      );

      cards.each((_, el) => {
        const el$ = $(el);

        // Заголовок
        const title = firstNonEmpty(
          el$.find(".card-title").text(),
          el$.find(".product-title").text(),
          el$.text()
        );

        // Ссылка
        const href = el$.find("a[href]").first().attr("href") || "";
        if (!href) return;
        const link = absolutize(href, "https://www.searspartsdirect.com");

        // Картинка — БЕРЁМ ИМЕННО src (их CDN), а не data-src
        let img =
          el$.find("img").attr("src") ||
          el$.find("img").attr("data-src") ||
          el$.find("img").attr("srcset") ||
          "";

        img = absolutize(img, "https://www.searspartsdirect.com");

        // Доп. фильтр: оставляем только CDN Sears, если он есть
        if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(img) === false) {
          // если попалась не та картинка (декор), попробуем найти правильную среди всех <img> внутри карточки
          const imgs = el$.find("img");
          for (let i = 0; i < imgs.length; i++) {
            const raw =
              $(imgs[i]).attr("src") ||
              $(imgs[i]).attr("data-src") ||
              $(imgs[i]).attr("srcset") ||
              "";
            const abs = absolutize(raw, "https://www.searspartsdirect.com");
            if (/^https?:\/\/s\.sears\.com\/is\/image\/Sears\//i.test(abs)) {
              img = abs;
              break;
            }
          }
        }

        // Если картинка всё же не найдена — оставим пусто (фронт покажет плейсхолдер)
        results.push({
          title: title.replace(/\s+/g, " ").trim(),
          link,
          image: img || null,
          source: "SearsPartsDirect",
        });
      });

      return results;
    },
  },

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
