// scripts/sync.js — mirror images locally
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const FEED_URL = process.env.VENDOR_FEED_URL;

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
  if (/shop all|all|misc|other/.test(s)) return "UNISEX";
  return "UNISEX";
}

function loadOverrides() {
  try {
    const txt = fs.readFileSync("data/gender-overrides.json", "utf-8");
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

function applyOverrides(item, overrides) {
  if (item.sku) {
    const bySku = overrides.find(o => o.sku && o.sku.toLowerCase() === item.sku.toLowerCase());
    if (bySku?.gender) return bySku.gender;
  }
  return null;
}

async function getCSV() {
  if (!FEED_URL) return fs.readFileSync("data/catalog.csv", "utf-8");
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return await res.text();
}

// --- image helpers ---
function normalizeUrl(url) {
  if (!url) return "";
  let u = String(url).trim();
  if (!u) return "";
  if (u.startsWith("//")) u = "https:" + u;
  if (u.startsWith("http://")) u = "https://" + u.slice(7);
  return u;
}

function pickImageFuzzy(row) {
  const entries = Object.entries(row);
  const imageLike = entries
    .filter(([k, v]) => v && String(v).trim())
    .map(([k, v]) => {
      const norm = k.toLowerCase().replace(/[\s_]/g, "");
      return { key: k, norm, value: String(v).trim() };
    })
    .filter(({ norm }) => norm.includes("image") && norm.includes("url"));

  if (imageLike.length === 0) return "";
  const order = ["thumb", "small", "medium", "large", "primary", "main", "base"];
  for (const pref of order) {
    const hit = imageLike.find(x => x.norm.includes(pref));
    if (hit) return normalizeUrl(hit.value);
  }
  return normalizeUrl(imageLike[0].value);
}

async function downloadImage(url, sku) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const ext = path.extname(new URL(url).pathname).split("?")[0] || ".jpg";
    const filename = sku ? sku + ext : crypto.createHash("md5").update(url).digest("hex") + ext;
    const localPath = path.join("public/images", filename);
    fs.writeFileSync(localPath, Buffer.from(buf));
    return "images/" + filename;
  } catch (e) {
    console.warn("Image download failed for", url, e.message);
    return "";
  }
}

async function run() {
  const csvText = await getCSV();
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });

  const overrides = loadOverrides();
  fs.mkdirSync("public/images", { recursive: true });

  const out = [];
  for (const r of rows) {
    const stock = toNumber(r["Current Stock"]);
    if (stock <= 0) continue;

    const baseGender = normalizeGender(r["Gender"], r["Category"]);
    const item = {
      sku: String(r["SKU"] || "").trim(),
      name: String(r["Product Name"] || "").trim(),
      brand: String(r["Brand"] || "").trim(),
      category: String(r["Category"] || "").trim(),
      gender: baseGender,
      inStock: true,
      qty: stock,
      image: "",
    };

    const forced = applyOverrides(item, overrides);
    if (forced) item.gender = forced;

    const remoteImg = pickImageFuzzy(r);
    if (remoteImg) {
      const localImg = await downloadImage(remoteImg, item.sku);
      if (localImg) item.image = localImg;
    }

    out.push(item);
  }

  fs.writeFileSync("public/inventory.json", JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} items with local images into public/inventory.json`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
