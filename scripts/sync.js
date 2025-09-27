// scripts/sync.js — mirror images locally with concurrency + dynamic BigCommerce referer
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const FEED_URL = process.env.VENDOR_FEED_URL;
const OUT_DIR = "public/images";
const CONCURRENCY = 8;
const REQ_TIMEOUT_MS = 15000;
const LOG_EVERY = 50;

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
  if (/shop all|all|misc|other/.test(s)) return "UNISEX";
  return "UNISEX";
}
async function getCSV() {
  if (!FEED_URL) return fs.readFileSync("data/catalog.csv", "utf-8");
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return await res.text();
}

// ---------- image column detection ----------
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

// ---------- request helpers ----------
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}
function chooseExt(url, contentType) {
  const byCT =
    contentType?.includes("webp") ? ".webp" :
    contentType?.includes("png")  ? ".png"  :
    contentType?.includes("gif")  ? ".gif"  : ".jpg";
  try {
    const u = new URL(url);
    const fromPath = path.extname(u.pathname).split("?")[0];
    return fromPath || byCT;
  } catch { return byCT; }
}
function safeBaseName(url, sku) {
  return (sku && sku.trim() ? sku.trim().replace(/[^\w.-]+/g, "_") : crypto.createHash("md5").update(url).digest("hex"));
}

// Build header profiles for a given URL (includes dynamic BigCommerce referer if applicable)
function buildHeaderProfilesFor(url) {
  const uaChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const uaSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

  const profiles = [];

  // If this is a BigCommerce CDN URL with store hash, use the default store domain referer
  try {
    const u = new URL(url);
    // path like /s-5cd7q6eg53/products/...
    const m = u.pathname.match(/\/(s-[a-z0-9]+)\//i);
    if (u.hostname.includes("bigcommerce.com") && m) {
      const storeHash = m[1]; // e.g. s-5cd7q6eg53
      const storeReferer = `https://${storeHash}.mybigcommerce.com/`;
      profiles.push({
        name: "bc-store-referer",
        headers: {
          "User-Agent": uaChrome,
          "Referer": storeReferer,
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      });
    }
  } catch { /* noop */ }

  // Generic e-com referers and no-referer
  profiles.push(
    {
      name: "nandansons",
      headers: {
        "User-Agent": uaChrome,
        "Referer": "https://www.nandansons.com/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    },
    {
      name: "generic-ecom",
      headers: {
        "User-Agent": uaSafari,
        "Referer": "https://store.example/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    },
    {
      name: "no-referer",
      headers: {
        "User-Agent": uaChrome,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    },
  );
  return profiles;
}

async function tryFetchImage(url) {
  const profiles = buildHeaderProfilesFor(url);
  for (const prof of profiles) {
    try {
      const res = await withTimeout(fetch(url, { headers: prof.headers, redirect: "follow" }), REQ_TIMEOUT_MS);
      if (!res.ok) continue;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("image")) continue;
      const buf = Buffer.from(await withTimeout(res.arrayBuffer(), REQ_TIMEOUT_MS));
      if (buf.length < 256) continue;
      return { ok: true, buf, contentType: ct, profile: prof.name };
    } catch {
      // try next profile
    }
  }
  return { ok: false };
}

// ---------- main ----------
async function run() {
  fs.mkdirSync("public", { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const csvText = await getCSV();
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });

  const items = [];
  for (const r of rows) {
    const stock = toNumber(r["Current Stock"]);
    if (stock <= 0) continue;

    items.push({
      sku: String(r["SKU"] || "").trim(),
      name: String(r["Product Name"] || "").trim(),
      brand: String(r["Brand"] || "").trim(),
      category: String(r["Category"] || "").trim(),
      gender: normalizeGender(r["Gender"], r["Category"]),
      qty: stock,
      inStock: true,
      remoteImage: pickImageFuzzy(r),
      image: "",
    });
  }

  let attempted = 0, saved = 0, reused = 0, processed = 0;

  const queue = [...items];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const it = queue.shift();
      if (!it) break;

      const remote = it.remoteImage;
      if (remote) {
        const ext = chooseExt(remote);
        const file = safeBaseName(remote, it.sku) + ext;
        const abs = path.join(OUT_DIR, file);
        const rel = "images/" + file;

        if (fs.existsSync(abs) && fs.statSync(abs).size > 256) {
          it.image = rel;
          reused++;
        } else {
          attempted++;
          const res = await tryFetchImage(remote);
          if (res.ok) {
            fs.writeFileSync(abs, res.buf);
            it.image = rel;
            saved++;
          }
        }
      }

      processed++;
      if (processed % LOG_EVERY === 0) {
        console.log(`Progress: ${processed}/${items.length} | saved=${saved}, reused=${reused}, attempted=${attempted}`);
      }
    }
  });
  await Promise.all(workers);

  const out = items.map(({ remoteImage, ...keep }) => keep);
  fs.writeFileSync("public/inventory.json", JSON.stringify(out, null, 2));
  console.log(`Done. Items=${out.length}. Images: attempted=${attempted}, saved=${saved}, reused=${reused}.`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
