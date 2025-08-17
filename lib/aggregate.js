import { fetchSears, fetchRepairClinic } from "./sources.js";

export async function aggregate(query) {
  if (!query) return [];

  const results = [];
  try { results.push(...await fetchSears(query)); } catch {}
  try { results.push(...await fetchRepairClinic(query)); } catch {}

  return results;
}
