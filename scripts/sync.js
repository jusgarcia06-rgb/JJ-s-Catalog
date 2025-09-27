// scripts/sync.js — mirrors vendor images locally (with referer/user-agent retries)
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const FEED_URL = process.env.VENDOR_FEED_URL;

// ---- utils ----
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

async function getCSV() {
  if (!FEED_URL) return fs.readFileSync("data/catalog.csv", "utf-8");
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return await res.text();
}

// ---- image picking (fuzzy) ----
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
    .map(([k, v]) => ({ key: k, norm: k.toLowerCase().replace(/[\s_]/g, ""), value: String(v).trim() }))
    .filter(({ norm }) => norm.includes("image") && norm.includes("url"));

  if (imageLike.length === 0) return "";

  const order = ["thumb", "small", "medium", "large", "primary", "main", "base"];
  for (const pref of order) {
    const hit = imageLike.find(x => x.norm.includes(pref));
    if (hit) return normalizeUrl(hit.value);
  }
  return normalizeUrl(imageLike[0].value);
}

// ---- robust image download with referer/user-agent retries ----
const HEADER_PROFILES = [
  // Pretend we came from the store (BigCommerce often requires a referer)
  {
    name: "nandansons",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Referer": "https://www.nandansons.com/",
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  },
  // Generic ecommerce referer (some stores validate domain loosely)
  {
    name: "generic-ecom",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "Referer": "https://store.example/",
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  },
  // No referer (as last resort)
  {
    name: "no-referer",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  },
];

async function tryFetchImage(url) {
  for (const prof of HEADER_PROFILES) {
    try {
      const res = await fetch(url, { headers: prof.headers, redirect: "follow" });
      if (!res.ok) {
        // continue to next profile
        continue;
      }
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("image")) {
        // sometimes BigCommerce returns HTML challenge; skip
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 256) continue; // avoid empty pixels/blocked gifs
      return { ok: true, buf, contentType: ct, profile: prof.name };
    } catch {
      // try next profile
    }
  }
  return { ok: false };
}

function chooseExt(url, contentType) {
  const byCT =
    contentType?.includes("webp")
      ? ".webp"
      : contentType?.includes("png")
      ? ".png"
      : contentType?.includes("gif")
      ? ".gif"
      : ".jpg";
  try {
    const u = new URL(url);
    const fromPath = path.extname(u.pathname).split("?")[0];
    return fromPath || byCT;
  } catch {
    return byCT;
  }
}

async function downloadImageToLocal(url, sku) {
  const res = await tryFetchImage(url);
  if (!res.ok) return "";

  const ext = chooseExt(url, res.contentType);
  const filename =
    (sku && sku.trim() ? sku.trim().replace(/[^\w.-]+/g, "_") : crypto.createHash("md5").update(url).digest("hex")) +
    ext;

  const outDir = "public/images";
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, res.buf);
  return "images/" + filename;
}

// ---- main ----
async function run() {
  const csvText = await getCSV();
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });

  const out = [];
  let attempted = 0,
    saved = 0;

  for (const r of rows) {
    const stock = toNumber(r["Current Stock"]);
    if (stock <= 0) continue;

    const item = {
      sku: String(r["SKU"] || "").trim(),
      name: String(r["Product Name"] || "").trim(),
      brand: String(r["Brand"] || "").trim(),
      category: String(r["Category"] || "").trim(),
      gender: normalizeGender(r["Gender"], r["Category"]),
      inStock: true,
      qty: stock,
      image: "",
    };

    const remote = pickImageFuzzy(r);
    if (remote) {
      attempted++;
      const localRel = await downloadImageToLocal(remote, item.sku);
      if (localRel) {
        item.image = localRel;
        saved++;
      }
    }
    out.push(item);
  }

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/inventory.json", JSON.stringify(out, null, 2));
  console.log(`Items written: ${out.length}. Images attempted: ${attempted}, saved locally: ${saved}.`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
