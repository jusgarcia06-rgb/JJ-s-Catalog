// scripts/sync.js  — no prices written to public/inventory.json
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import fs from "fs";

const FEED_URL = process.env.VENDOR_FEED_URL;

async function getCSV() {
  if (!FEED_URL) {
    // Fallback to local file if secret is missing
    return fs.readFileSync("data/catalog.csv", "utf-8");
  }
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return await res.text();
}

function toNumber(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function mapRow(r) {
  const stock = toNumber(r["Current Stock"]);
  return {
    sku: String(r["SKU"] || "").trim(),
    name: String(r["Product Name"] || "").trim(),
    brand: String(r["Brand"] || "").trim(),
    category: String(r["Category"] || "").trim(),
    inStock: stock > 0,
    qty: stock,
    image: String(r["Large Image URL"] || r["Thumb Image URL"] || "").trim()
  };
}

async function run() {
  const csvText = await getCSV();
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });
  const out = rows.map(mapRow).filter(p => p.inStock);

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/inventory.json", JSON.stringify(out, null, 2));
  console.log(`Wrote public/inventory.json with ${out.length} in-stock items (no prices)`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
