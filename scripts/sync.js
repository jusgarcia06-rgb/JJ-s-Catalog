// scripts/sync.js — mirror images locally with proxy fallbacks
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const FEED_URL = process.env.VENDOR_FEED_URL;

// ---------- utilities ----------
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

// ---------- pick an image column (fuzzy) ----------
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

// ---------- robust download: direct -> direct(no query) -> proxyA -> proxyB ----------
const HEADER_PROFILES = [
  {
    name: "nandansons",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Referer": "https://www.nandansons.com/",
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  },
  {
    name: "generic-ecom",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "Referer": "https://store.example/",
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  },
  {
    name: "no-referer",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  },
];

function stripQuery(u) {
  try {
    const url = new URL(u);
    url.search = "";
    return url.toString();
  } catch {
    return u;
  }
}
function proxyUrls(u) {
  const clean = normalizeUrl(u);
  if (!clean) return [];
  const bare = clean.replace(/^https?:\/\//i, "");
  return [
    `https://images.weserv.nl/?url=${encodeURIComponent(bare)}&output=webp`, // proxy A
    `https://wsrv.nl/?url=${encodeURIComponent(bare)}&output=webp`,          // proxy B (alias)
  ];
}

async function fetchImageWithProfiles(url) {
  for (const prof of HEADER_PROFILES) {
    try {
      const res = await fetch(url, { headers: prof.headers, redirect: "follow" });
      if (!res.ok) continue;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("image")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 256) continue;
      return { ok: true, buf, contentType: ct, tried: prof.name };
    } catch {
      // try next
    }
  }
  return { ok: false };
}

async function tryDownloadAny(url) {
  // 1) direct
  let res = await fetchImageWithProfiles(url);
  if (res.ok) return res;

  // 2) direct without query
  const noQuery = stripQuery(url);
  if (noQuery !== url) {
    res = await fetchImageWithProfiles(noQuery);
    if (res.ok) return res;
  }

  // 3) proxies
  for (const pu of proxyUrls(url)) {
    try {
      const r = await fetch(pu, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        redirect: "follow",
      });
      if (!r.ok) continue;
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("image")) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 256) continue;
      return { ok: true, buf, contentType: ct, tried: "proxy" };
    } catch {
      // try next proxy
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
  const result = await tryDownloadAny(url);
  if (!result.ok) return "";

  const ext = chooseExt(url, result.contentType);
  const safeSku = (sku || "").trim().replace(/[^\w.-]+/g, "_");
  const filename =
    (safeSku ? safeSku : crypto.createHash("md5").update(url).digest("hex")) + (ext || ".jpg");

  const outDir = "public/images";
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, filename), result.buf);
  return "images/" + filename;
}

// ---------- main ----------
async function run() {
  const csvText = await getCSV();
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });

  const out = [];
  let attempted = 0, saved = 0;

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
      if (localRel) { item.image = localRel; saved++; }
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
