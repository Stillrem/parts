import { aggregate } from "../lib/aggregate.js";

export async function handler(event) {
  const q = event.queryStringParameters.q || "";

  if (q === "__diag") {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, env: process.env, ts: Date.now() })
    };
  }

  let results = [];
  try {
    results = await aggregate(q);
  } catch (e) {
    results = [];
  }

  // демо fallback
  if (!results.length) {
    results = [
      { title: "Demo Part 1", partNumber: "PN123", price: "$99.99", img: "https://via.placeholder.com/150", source: "Demo" },
      { title: "Demo Part 2", partNumber: "PN456", price: "$49.99", img: "https://via.placeholder.com/150", source: "Demo" }
    ];
  }

  return {
    statusCode: 200,
    body: JSON.stringify(results)
  };
}
