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

function mapRow(r){
  // TODO: adjust these field names to match your feed once we see it.
  const vendorSku = String(r.SKU || r.Item || r.ItemNumber || r.Sku || "").trim();
  const name      = String(r.Title || r.Name || r.Description || "").trim();
  const brand     = String(r.Brand || r.Manufacturer || "").trim();
  const category  = String(r.Category || r.Type || "").trim();
  const img       = String(r.ImageURL || r.Image || r["Image URL"] || "").trim();

  const qtyRaw = Number(r.Quantity || r.Qty || r.Available || r.InStock || 0);
  const qty    = Number.isFinite(qtyRaw) ? Math.max(qtyRaw - 2, 0) : 0; // safety buffer of 2

  const wholesale = Number(r.WholesalePrice || r.Cost || r.Price || 0);
  const price     = wholesale ? Math.round(wholesale * 1.35 * 100) / 100 : 0; // 35% markup

  return {
    // show YOUR sku (you can map vendor -> your sku later; for now reuse vendorSku)
    sku: vendorSku,
    name,
    brand,
    category,
    price,
    inStock: qty > 0,
    qty,
    // IMPORTANT: host your own images later; placeholder for now
    image: "" // e.g., replace with your hosted path once you upload images
  };
}

async function run(){
  const csvText = await getCSV(FEED_URL);
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });
  const out = rows.map(mapRow).filter(p => p.inStock);

  // Ensure folder exists
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/inventory.json", JSON.stringify(out, null, 2));
  console.log(`Wrote public/inventory.json with ${out.length} items`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
