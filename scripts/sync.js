// scripts/sync.js — robust image selection + gender normalization + optional overrides
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import fs from "fs";

const FEED_URL = process.env.VENDOR_FEED_URL;

// ---------- helpers ----------
function toNumber(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normalizeGender(rawGender, fallbackCategory) {
  const s = String(rawGender || fallbackCategory || "").trim().toLowerCase();

  if (/(^|\W)men('?s)?(\W|$)|\bmale\b|\bm\b/.test(s)) return "MENS";
  if (/(^|\W)women('?s)?(\W|$)|\bfemale\b|\bw\b|ladies/.test(s)) return "WOMENS";
  if (/\bunisex\b|\buni\b/.test(s)) return "UNISEX";
  if (/\bchild|\bkid|\bboy|\bgirl|\byouth|\bbaby|\bchildren/.test(s)) return "CHILDRENS";

  // catch-all vendor labels
  if (/shop all|all|misc|other/.test(s)) return "UNISEX";
  return "UNISEX";
}

function loadOverrides() {
  try {
    const txt = fs.readFileSync("data/gender-overrides.json", "utf-8");
    const arr = JSON.parse(txt);
    return arr.map(o => {
      if (o.name_regex) {
        const source = String(o.name_regex);
        const hasInlineCI = source.startsWith("(?i)");
        const pattern = hasInlineCI ? source.slice(4) : source;
        const flags = hasInlineCI ? "i" : "i";
        return { ...o, __regex: new RegExp(pattern, flags) };
      }
      return o;
    });
  } catch {
    return [];
  }
}

function applyOverrides(item, overrides) {
  if (item.sku) {
    const bySku = overrides.find(o => o.sku && String(o.sku).trim().toLowerCase() === item.sku.toLowerCase());
    if (bySku?.gender) return bySku.gender;
  }
  if (item.name) {
    const byName = overrides.find(o => o.__regex && o.__regex.test(item.name));
    if (byName?.gender) return byName.gender;
  }
  return null;
}

async function getCSV() {
  if (!FEED_URL) return fs.readFileSync("data/catalog.csv", "utf-8");
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return await res.text();
}

// Pick the first non-empty image among common vendor columns
function pickImage(r) {
  const candidates = [
    "Thumb Image URL",
    "Small Image URL",
    "Medium Image URL",
    "Large Image URL",
    "Image URL",
    "Primary Image URL",
    "Image",
    "image_url",
  ];

  let url = "";
  for (const key of candidates) {
    if (r[key] && String(r[key]).trim()) {
      url = String(r[key]).trim();
      break;
    }
  }
  if (!url) return "";

  // normalize protocol
  if (url.startsWith("//")) url = "https:" + url;
  if (url.startsWith("http://")) url = "https://" + url.slice(7);
  return url;
}

function mapRow(r, overrides) {
  const stock = toNumber(r["Current Stock"]);
  const baseGender = normalizeGender(r["Gender"], r["Category"]);

  const item = {
    sku: String(r["SKU"] || "").trim(), // not shown on site, but kept internally
    name: String(r["Product Name"] || "").trim(),
    brand: String(r["Brand"] || "").trim(),
    category: String(r["Category"] || "").trim(),
    gender: baseGender,
    inStock: stock > 0,
    qty: stock,
    image: pickImage(r),
  };

  const forced = applyOverrides(item, overrides);
  if (forced) item.gender = forced;

  return item;
}

// ---------- main ----------
async function run() {
  const csvText = await getCSV();
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });

  const overrides = loadOverrides();
  const out = rows.map(r => mapRow(r, overrides)).filter(p => p.inStock);

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/inventory.json", JSON.stringify(out, null, 2));
  console.log(
    `Wrote public/inventory.json with ${out.length} in-stock items (robust image selection, gender normalized, overrides=${overrides.length})`
  );
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
