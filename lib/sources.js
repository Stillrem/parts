import fetch from "node-fetch";
import cheerio from "cheerio";

export async function fetchSears(q) {
  const url = `https://www.searspartsdirect.com/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  const html = await res.text();
  const $ = cheerio.load(html);

  const parts = [];
  $(".parts-card").each((_, el) => {
    parts.push({
      title: $(el).find(".parts-title").text().trim(),
      partNumber: $(el).find(".part-number").text().trim(),
      price: $(el).find(".price").text().trim(),
      img: $(el).find("img").attr("src"),
      source: "SearsPartsDirect"
    });
  });
  return parts;
}

export async function fetchRepairClinic(q) {
  const url = `https://www.repairclinic.com/Search?query=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  const html = await res.text();
  const $ = cheerio.load(html);

  const parts = [];
  $(".product-grid .product-card").each((_, el) => {
    parts.push({
      title: $(el).find(".product-title").text().trim(),
      partNumber: $(el).find(".sku").text().trim(),
      price: $(el).find(".price").text().trim(),
      img: $(el).find("img").attr("src"),
      source: "RepairClinic"
    });
  });
  return parts;
}
