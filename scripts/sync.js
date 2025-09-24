// scripts/sync.js — builds public/inventory.json with normalized gender
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import fs from "fs";

const FEED_URL = process.env.VENDOR_FEED_URL;

// --- helpers ---
function toNumber(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normalizeGender(rawGender, fallbackCategory) {
  const s = String(rawGender || fallbackCategory || "").trim().toLowerCase();

  // Direct matches & common variants
  if (/(^|\W)men('?s)?(\W|$)|\bmale\b|\bm\b/.test(s)) return "MENS";
  if (/(^|\W)women('?s)?(\W|$)|\bfemale\b|\bw\b|ladies/.test(s)) return "WOMENS";
  if (/\bunisex\b|\buni\b/.test(s)) return "UNISEX";
  if (/\bchild|\bkid|\bboy|\bgirl|\byouth|\bbaby|\bchildren/.test(s)) return "CHILDRENS";

  // Some vendor “catch-all” labels (e.g., "shop all", "all", "misc")
  if (/shop all|all|misc|other/.test(s)) return "UNISEX";

  // Default to UNISEX if unknown (so products aren’t hidden)
  return "UNISEX";
}

async function getCSV() {
  if (!FEED_URL) {
    // Fallback to local file if secret missing
    return fs.readFileSync("data/catalog.csv", "utf-8");
  }
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return await res.text();
}

function mapRow(r) {
  const stock = toNumber(r["Current Stock"]);
  const gender = normalizeGender(r["Gender"], r["Category"]);

  return {
    sku: String(r["SKU"] || "").trim(),
    name: String(r["Product Name"] || "").trim(),
    brand: String(r["Brand"] || "").trim(),
    // Keep original category text if you want, but filtering will use `gender`
    category: String(r["Category"] || "").trim(),
    gender,            // <-- normalized gender we’ll filter on
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
  console.log(`Wrote public/inventory.json with ${out.length} in-stock items (gender normalized)`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
