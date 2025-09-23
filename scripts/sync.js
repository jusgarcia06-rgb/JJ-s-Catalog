// scripts/sync.js
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import fs from "fs";

const FEED_URL = process.env.VENDOR_FEED_URL;
if (!FEED_URL) {
  console.error("Missing VENDOR_FEED_URL secret");
  process.exit(1);
}

async function getCSV(url){
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return await res.text();
}

function toNumber(v) {
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function mapRow(r){
  const stock = toNumber(r["Current Stock"]);
  const wholesale = toNumber(r["Product Price"]);
  const price = wholesale ? Math.round(wholesale * 1.35 * 100) / 100 : 0; // markup

  return {
    sku: String(r["SKU"] || "").trim(),
    name: String(r["Product Name"] || "").trim(),
    brand: String(r["Brand"] || "").trim(),
    category: String(r["Category"] || "").trim(),
    price,
    inStock: stock > 0,
    qty: stock,
    image: String(r["Large Image URL"] || r["Thumb Image URL"] || "").trim()
  };
}

async function run(){
  const csvText = await getCSV(FEED_URL);
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });

  const out = rows.map(mapRow).filter(p => p.inStock);

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/inventory.json", JSON.stringify(out, null, 2));
  console.log(`Wrote public/inventory.json with ${out.length} items`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
