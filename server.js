const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const tls = require("node:tls");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = (() => {
  const candidates = [
    path.join(__dirname, "public"),
    path.join(process.cwd(), "public"),
    path.join(__dirname, "..", "public"),
    "/var/task/public",
    __dirname,
    process.cwd(),
  ];
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, "index.html"))) {
        return path.resolve(dir);
      }
    } catch (_) {}
  }
  return path.join(__dirname, "public");
})();
const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const WEBHOOK_EVENTS_FILE = path.join(DATA_DIR, "webhook-events.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");

const baseProducts = [
  { id: "noir-neon", name: "Noir Neon", price: 99 },
  { id: "cyber-wave", name: "Cyber Wave", price: 99 },
  { id: "metro-midnight", name: "Metro Midnight", price: 99 },
  { id: "anime-surge", name: "Anime Surge", price: 99 },
  { id: "black-gold", name: "Black Gold", price: 99 },
  { id: "pixel-pop", name: "Pixel Pop", price: 99 },
  { id: "carbon-rush", name: "Carbon Rush", price: 99 },
  { id: "silver-static", name: "Silver Static", price: 99 },
];

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const USE_KV = Boolean(KV_URL && KV_TOKEN);

async function kvGet(key) {
  const response = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (data.result == null) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return data.result;
  }
}

async function kvSet(key, value) {
  const response = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: JSON.stringify(value),
  });
  if (!response.ok) {
    throw new Error(`KV set failed: ${response.status} ${await response.text()}`);
  }
}

async function loadStore(key, file, fallback) {
  if (USE_KV) {
    const value = await kvGet(key);
    return value == null ? fallback : value;
  }
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveStore(key, file, value) {
  if (USE_KV) {
    await kvSet(key, value);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function readProductOverrides() {
  return loadStore("products", PRODUCTS_FILE, {});
}

async function writeProductOverrides(data) {
  await saveStore("products", PRODUCTS_FILE, data);
}

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const DEFAULT_SETTINGS = {
  shippingFlat: 49,
  featuredProductId: "",
  productOrder: [],
};

// Reorder a product list to match the admin-saved order. Any products not in
// `order` (e.g. newly added base products) keep their original position at the
// end of the list so nothing ever disappears.
function applyAdminOrder(products, order) {
  if (!Array.isArray(order) || order.length === 0) return products.slice();
  const byId = new Map(products.map((p) => [p.id, p]));
  const seen = new Set();
  const out = [];
  for (const id of order) {
    const product = byId.get(id);
    if (product && !seen.has(id)) {
      out.push(product);
      seen.add(id);
    }
  }
  for (const product of products) {
    if (!seen.has(product.id)) out.push(product);
  }
  return out;
}

// Stable partition: in-stock products keep their order, sold-out products
// keep their relative order but move to the end of the list.
function pushOutOfStockToEnd(products) {
  const inStock = [];
  const outOfStock = [];
  for (const product of products) {
    if (product.stock > 0) inStock.push(product);
    else outOfStock.push(product);
  }
  return inStock.concat(outOfStock);
}

async function readSettings() {
  const stored = await loadStore("settings", SETTINGS_FILE, {});
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

async function writeSettings(data) {
  await saveStore("settings", SETTINGS_FILE, data);
}

// SKU shown in emails AND sent to Shiprocket. Always derived from the
// CURRENT product name (after admin overrides) so renaming a card to
// "Frank My Ocean" makes its SKU "frankmyocean.skin" everywhere.
function productSku(product) {
  const source = String(product?.name || product?.id || "").toLowerCase();
  const slug = source.replace(/[^a-z0-9]+/g, "");
  return `${slug || "product"}.skin`;
}

let _productsCache = null;
let _productsCacheAt = 0;
const PRODUCTS_CACHE_MS = 30_000;

function invalidateProductsCache() {
  _productsCache = null;
  _productsCacheAt = 0;
}

async function getProducts() {
  if (_productsCache && Date.now() - _productsCacheAt < PRODUCTS_CACHE_MS) {
    return _productsCache;
  }
  const overrides = await readProductOverrides();
  const merged = baseProducts.map((p) => {
    const o = overrides[p.id] || {};
    return {
      ...p,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : p.name,
      price: typeof o.price === "number" ? o.price : p.price,
      stock: typeof o.stock === "number" ? o.stock : 100,
      image: typeof o.image === "string" ? o.image : null,
      image_back: typeof o.image_back === "string" ? o.image_back : null,
      description: typeof o.description === "string" ? o.description : "",
      enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    };
  });
  // Apply the admin-saved display order so admin lists and storefront calls
  // both start from the same base sequence.
  const settings = await readSettings();
  const result = applyAdminOrder(merged, settings.productOrder);
  _productsCache = result;
  _productsCacheAt = Date.now();
  return result;
}

// Idempotently subtract purchased quantities from product stock. Marks the
// order with `stock_decremented: true` so we never double-deduct, even if
// both the verify call and the webhook fire for the same payment.
async function decrementStockForOrder(order) {
  if (!order || order.stock_decremented) return;
  const lines = Array.isArray(order.lines) ? order.lines : [];
  if (!lines.length) return;
  const overrides = await readProductOverrides();
  for (const line of lines) {
    const id = line && line.id;
    if (!id) continue;
    const qty = Math.max(0, Math.floor(Number(line.quantity || 0)));
    if (!qty) continue;
    const current = overrides[id] || {};
    const currentStock = typeof current.stock === "number" ? current.stock : 100;
    overrides[id] = { ...current, stock: Math.max(0, currentStock - qty) };
  }
  await writeProductOverrides(overrides);
  invalidateProductsCache();
  await updateOrder(order.id, { stock_decremented: true });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

const DEFAULT_CARD_BG =
  "linear-gradient(135deg, #050608, #ffb627 28%, #ff3c8a 58%, #25d9ff)";

function htmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function attrEscape(value) {
  return String(value == null ? "" : value).replace(/"/g, "&quot;");
}

function formatRupees(value) {
  return `Rs ${Number(value || 0).toLocaleString("en-IN")}`;
}

function renderProductCardHTML(product) {
  const out = !(product.stock > 0);
  const frontStyle = product.image
    ? `--skin-image: url('${product.image}');`
    : `--skin-bg: ${DEFAULT_CARD_BG};`;
  const backImage = product.image_back || product.image;
  const backStyle = backImage
    ? `--skin-image: url('${backImage}');`
    : `--skin-bg: ${DEFAULT_CARD_BG};`;
  const frontClass = product.image ? "face has-image" : "face";
  const backClass = backImage ? "face has-image" : "face";
  const backHasOwnImage = Boolean(product.image_back);
  const meta = product.description
    ? htmlEscape(product.description)
    : `${htmlEscape(product.category || "")} card skin · ${htmlEscape(product.finish || "Premium vinyl")}`;
  return `
        <article class="product-card${out ? " out-of-stock" : ""}">
          <div class="product-art">
            <div class="card-3d-wrapper">
              <div class="${frontClass} face--front" style="${attrEscape(frontStyle)}"></div>
              <div class="${backClass} face--back${backHasOwnImage ? " face--back-clean" : ""}" style="${attrEscape(backStyle)}"></div>
              ${out ? `<span class="stock-badge">Out of stock</span>` : ""}
            </div>
          </div>
          <div class="product-body">
            <h3>${htmlEscape(product.name)}</h3>
            <p class="product-meta">${meta}</p>
            <div class="product-footer">
              <span class="price">${formatRupees(product.price)}</span>
              <button class="add-button" type="button" data-add="${attrEscape(product.id)}"${out ? " disabled" : ""}>${out ? "Sold out" : "Add to cart"}</button>
            </div>
          </div>
        </article>`;
}

function buildInitialStateScript(products, settings) {
  const payload = {
    products: (products || []).filter((p) => p.enabled !== false),
    settings: settings || {},
  };
  // Escape </script and U+2028/2029 to keep the JSON safe inside a <script> tag.
  const safeJson = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script>(function(){try{var s=${safeJson};window.__INITIAL_PRODUCTS__=s.products;window.__INITIAL_SETTINGS__=s.settings;}catch(e){}}());</script>`;
}

function pickFeaturedProduct(products, settings) {
  const visible = products.filter((p) => p.enabled !== false);
  const id = settings && settings.featuredProductId;
  if (id) {
    const match = visible.find((p) => p.id === id);
    if (match) return match;
  }
  return visible[0] || null;
}

function renderHeroFaceStyle(image) {
  return image
    ? `--skin-image: url('${image}');`
    : `--skin-bg: ${DEFAULT_CARD_BG};`;
}

async function renderIndexHtml(rawHtml) {
  const products = await getProducts();
  const settings = await readSettings();
  // Storefront sees in-stock products first, sold-out products move to the end.
  const visible = pushOutOfStockToEnd(products.filter((p) => p.enabled !== false));
  const cards = visible.map(renderProductCardHTML).join("");
  let html = rawHtml.replace(
    /<section class="product-grid" id="productGrid"([^>]*)><\/section>/,
    `<section class="product-grid" id="productGrid"$1>${cards}\n      </section>`,
  );

  // Inject the featured product's image into the hero card (front + back) so
  // the first thing the visitor sees is the actual featured skin, not the
  // placeholder gradient.
  const featured = pickFeaturedProduct(products, settings);
  if (featured) {
    const frontImage = featured.image || "";
    const backImage = featured.image_back || featured.image || "";
    const frontStyle = renderHeroFaceStyle(frontImage);
    const backStyle = renderHeroFaceStyle(backImage);
    const frontClass = frontImage ? "face has-image face--front" : "face face--front";
    const backClass = (backImage ? "face has-image face--back" : "face face--back") +
      (featured.image_back ? " face--back-clean" : "");
    html = html.replace(
      /<div class="card-3d-wrapper hero-card" id="heroCard">[\s\S]*?<\/div>\s*<\/a>/,
      `<div class="card-3d-wrapper hero-card" id="heroCard">
              <div class="${frontClass}" style="${attrEscape(frontStyle)}"></div>
              <div class="${backClass}" style="${attrEscape(backStyle)}"></div>
            </div>
          </a>`,
    );
  }

  // Seed the same in-stock-first order on the client so the JS grid matches
  // the SSR'd grid byte-for-byte and never re-shuffles after hydration.
  const initialScript = buildInitialStateScript(pushOutOfStockToEnd(products), settings);
  html = html.replace(
    /<script src="\.\/store\.js"><\/script>/,
    `${initialScript}\n    <script src="./store.js"></script>`,
  );
  return html;
}

async function renderCheckoutHtml(rawHtml) {
  const products = await getProducts();
  const settings = await readSettings();
  const initialScript = buildInitialStateScript(pushOutOfStockToEnd(products), settings);
  return rawHtml.replace(
    /<script src="\.\/store\.js"><\/script>/,
    `${initialScript}\n    <script src="./store.js"></script>`,
  );
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const env = fs.readFileSync(filePath, "utf8");
  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";
  for (const cookie of header.split(";")) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sessionSecret() {
  return process.env.ADMIN_PASSWORD || "carddesign-fallback-secret-do-not-use";
}

function signSession(payload) {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function createSession() {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = String(expires);
  return `${payload}.${signSession(payload)}`;
}

function isAdminRequest(req) {
  const token = parseCookies(req).cds_admin_session;
  if (!token || token === "deleted") return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expires = Number(payload);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = signSession(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function cookieOptions(value, maxAge, req) {
  const proto = (req && (req.headers["x-forwarded-proto"] || "")).toString().split(",")[0].trim();
  const isHttps =
    proto === "https" ||
    process.env.NODE_ENV === "production" ||
    !!process.env.REPLIT_DEV_DOMAIN ||
    !!process.env.REPLIT_DEPLOYMENT;
  const sameSite = isHttps ? "None" : "Lax";
  const secure = isHttps ? "; Secure" : "";
  return `cds_admin_session=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
}
function safeCompare(value, expected) {
  const first = Buffer.from(String(value || ""));
  const second = Buffer.from(String(expected || ""));
  if (first.length !== second.length) return false;
  return crypto.timingSafeEqual(first, second);
}

async function readOrders() {
  return loadStore("orders", ORDERS_FILE, []);
}

async function writeOrders(orders) {
  await saveStore("orders", ORDERS_FILE, orders);
}

async function hasProcessedWebhook(id) {
  if (!id) return false;
  const events = await loadStore("webhook_events", WEBHOOK_EVENTS_FILE, []);
  return events.some((event) => event.id === id);
}

async function saveProcessedWebhook(id, source, event) {
  if (!id) return;
  const events = await loadStore("webhook_events", WEBHOOK_EVENTS_FILE, []);
  events.unshift({ id, source, event, processed_at: new Date().toISOString() });
  await saveStore("webhook_events", WEBHOOK_EVENTS_FILE, events.slice(0, 500));
}

async function saveOrder(order) {
  const orders = await readOrders();
  const existingIndex = orders.findIndex((item) => item.id === order.id);
  if (existingIndex >= 0) orders[existingIndex] = order;
  else orders.unshift(order);
  await writeOrders(orders);
  return order;
}

async function updateOrder(id, patch) {
  const orders = await readOrders();
  const order = orders.find((item) => item.id === id || item.razorpay_order_id === id);
  if (!order) return null;
  Object.assign(order, patch, { updated_at: new Date().toISOString() });
  await writeOrders(orders);
  return order;
}

function publicOrder(order) {
  return {
    id: order.id,
    razorpay_order_id: order.razorpay_order_id,
    razorpay_payment_id: order.razorpay_payment_id,
    shiprocket_order_id: order.shiprocket_order_id,
    awb_code: order.awb_code,
    status: order.status,
    payment_status: order.payment_status,
    shipping_status: order.shipping_status,
    customer: order.customer,
    lines: order.lines,
    subtotal: order.subtotal,
    shipping: order.shipping,
    total: order.total,
    email_status: order.email_status,
    shipping_email_status: order.shipping_email_status,
    shipping_email_sent_at: order.shipping_email_sent_at,
    shipping_email_error: order.shipping_email_error,
    shipping_error: order.shipping_error,
    email_error: order.email_error,
    created_at: order.created_at,
    updated_at: order.updated_at,
    error: order.error,
  };
}

function confirmationOrder(order) {
  // Customer-facing view: NEVER expose internal payment / shipping / email
  // engine statuses (captured, sent_smtp, ready_to_ship, etc.). Just say
  // whether the payment went through and the order is logged.
  const paid = ["paid", "ready_to_ship", "delivered", "paid_shipping_failed"].includes(order.status);
  const customerEmail = order.customer?.email || "";
  return {
    id: order.id,
    paid,
    lines: order.lines,
    subtotal: order.subtotal,
    shipping: order.shipping,
    total: order.total,
    customer_email: customerEmail,
    awb_code: order.awb_code || null,
    has_shipped: Boolean(order.awb_code),
  };
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve({ raw: body, json: body ? JSON.parse(body) : {} });
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

async function calculateOrder(items = []) {
  const catalog = await getProducts();
  const lines = items.map((item) => {
    const product = catalog.find((candidate) => candidate.id === item.id);
    const quantity = Number(item.quantity || 0);
    if (!product || quantity < 1) return null;
    if (product.stock <= 0 || quantity > product.stock) {
      throw new Error(`${product.name} is out of stock`);
    }
    return { ...product, quantity };
  });

  if (lines.some((line) => !line) || !lines.length) {
    throw new Error("Invalid cart items");
  }

  const grossSubtotal = lines.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const unitPrices = [];
  lines.forEach((item) => {
    for (let i = 0; i < item.quantity; i += 1) unitPrices.push(item.price);
  });
  unitPrices.sort((a, b) => a - b);
  const freeCount = Math.floor(unitPrices.length / 3);
  let discount = 0;
  for (let i = 0; i < freeCount; i += 1) discount += unitPrices[i];

  const subtotal = grossSubtotal - discount;
  const settings = await readSettings();
  const flat = Number.isFinite(settings.shippingFlat) ? settings.shippingFlat : DEFAULT_SETTINGS.shippingFlat;
  const shipping = subtotal >= 495 || subtotal === 0 ? 0 : flat;
  return { lines, grossSubtotal, discount, subtotal, shipping, total: subtotal + shipping };
}

async function shiprocketRequest(pathname, options = {}) {
  if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) {
    return { demo: true };
  }

  const login = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    }),
  });
  const auth = await login.json();
  if (!login.ok) throw new Error(auth.message || "Shiprocket auth failed");

  const response = await fetch(`https://apiv2.shiprocket.in/v1/external${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("Shiprocket error", response.status, "on", pathname, "->", JSON.stringify(data));
    const detail = data.errors ? ` (${JSON.stringify(data.errors)})` : "";
    throw new Error((data.message || "Shiprocket request failed") + detail);
  }
  return data;
}

async function sendEmail({ to, subject, html }) {
  if (!to) return { status: "missing_recipient" };
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.EMAIL_FROM) {
    await sendSmtpEmail({ to, subject, html });
    return { status: "sent_smtp" };
  }
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    return { status: "demo_not_sent" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Email send failed");
  return { status: "sent", provider_id: data.id };
}

function sendSmtpEmail({ to, subject, html }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const from = process.env.EMAIL_FROM;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const message = [
    `From: carddesign.skin <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => {
      const commands = [
        `EHLO carddesign.skin`,
        "AUTH LOGIN",
        Buffer.from(user).toString("base64"),
        Buffer.from(pass).toString("base64"),
        `MAIL FROM:<${from}>`,
        `RCPT TO:<${to}>`,
        "DATA",
        `${message.replace(/\r?\n\./g, "\r\n..")}\r\n.`,
        "QUIT",
      ];
      let index = 0;
      const sendNext = () => {
        if (index < commands.length) socket.write(`${commands[index++]}\r\n`);
      };

      socket.on("data", (chunk) => {
        const response = chunk.toString();
        if (/^[45]\d\d/m.test(response)) {
          socket.destroy();
          reject(new Error("SMTP send failed"));
          return;
        }
        if (response.includes("221")) resolve();
        else sendNext();
      });
      sendNext();
    });
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error("SMTP timed out"));
    });
    socket.on("error", reject);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatINR(amount) {
  const value = Number(amount || 0);
  return `&#8377;${value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatOrderDate(value) {
  try {
    const d = value ? new Date(value) : new Date();
    return d.toLocaleString("en-IN", {
      day: "numeric", month: "long", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: "Asia/Kolkata",
    });
  } catch { return ""; }
}

function buildOrderConfirmationEmail(order) {
  const c = order.customer || {};
  const placedOn = formatOrderDate(order.created_at);
  const itemRows = (order.lines || []).map((item) => `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #1f1f1f;color:#f5f0e6;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.4;">
        <div style="font-weight:600;color:#f5f0e6;">${escapeHtml(item.name)}</div>
        <div style="color:#8a8275;font-size:12px;margin-top:4px;letter-spacing:0.06em;text-transform:uppercase;">SKU&nbsp;&middot;&nbsp;${escapeHtml(productSku(item))}</div>
      </td>
      <td align="center" style="padding:14px 16px;border-bottom:1px solid #1f1f1f;color:#cfc7b3;font-family:Georgia,'Times New Roman',serif;font-size:15px;">${item.quantity}</td>
      <td align="right" style="padding:14px 16px;border-bottom:1px solid #1f1f1f;color:#f5f0e6;font-family:Georgia,'Times New Roman',serif;font-size:15px;font-weight:600;">${formatINR(item.price * item.quantity)}</td>
    </tr>
  `).join("");

  const addressLine = [c.address, c.city, c.state, c.pin].filter(Boolean).map(escapeHtml).join(", ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Order confirmed &middot; carddesign.skin</title>
</head>
<body style="margin:0;padding:0;background:#050505;font-family:Georgia,'Times New Roman',serif;color:#f5f0e6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your carddesign.skin order ${escapeHtml(order.id)} is confirmed. Total ${formatINR(order.total)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#050505;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#0a0a0a;border:1px solid #1a1a1a;">
      <tr><td style="padding:36px 40px 24px;text-align:center;border-bottom:1px solid #1a1a1a;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:11px;letter-spacing:0.42em;color:#c9a961;text-transform:uppercase;">carddesign.skin</div>
        <h1 style="margin:18px 0 8px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:28px;letter-spacing:0.04em;color:#f5f0e6;">Your order is confirmed</h1>
        <p style="margin:0;color:#8a8275;font-size:14px;letter-spacing:0.02em;">Thank you, ${escapeHtml((c.name || "").split(" ")[0] || "friend")} &mdash; we have received your order.</p>
      </td></tr>

      <tr><td style="padding:28px 40px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-size:11px;letter-spacing:0.32em;color:#8a8275;text-transform:uppercase;padding-bottom:6px;">Order ID</td>
            <td align="right" style="font-size:11px;letter-spacing:0.32em;color:#8a8275;text-transform:uppercase;padding-bottom:6px;">Placed on</td>
          </tr>
          <tr>
            <td style="font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#c9a961;font-weight:600;">${escapeHtml(order.id)}</td>
            <td align="right" style="font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#cfc7b3;">${escapeHtml(placedOn)}</td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:24px 40px 8px;">
        <div style="font-size:11px;letter-spacing:0.32em;color:#8a8275;text-transform:uppercase;margin-bottom:10px;">Items</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #1f1f1f;">
          ${itemRows}
        </table>
      </td></tr>

      <tr><td style="padding:8px 40px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:8px 0;color:#8a8275;font-size:14px;">Subtotal</td>
            <td align="right" style="padding:8px 0;color:#cfc7b3;font-size:14px;">${formatINR(order.subtotal)}</td>
          </tr>
          ${order.discount > 0 ? `<tr>
            <td style="padding:8px 0;color:#8a8275;font-size:14px;">Discount</td>
            <td align="right" style="padding:8px 0;color:#cfc7b3;font-size:14px;">&minus; ${formatINR(order.discount)}</td>
          </tr>` : ""}
          <tr>
            <td style="padding:8px 0;color:#8a8275;font-size:14px;">Shipping</td>
            <td align="right" style="padding:8px 0;color:#cfc7b3;font-size:14px;">${order.shipping ? formatINR(order.shipping) : "FREE"}</td>
          </tr>
          <tr><td colspan="2" style="border-top:1px solid #1f1f1f;padding-top:14px;"></td></tr>
          <tr>
            <td style="padding:6px 0 18px;color:#f5f0e6;font-size:16px;letter-spacing:0.04em;text-transform:uppercase;font-weight:600;">Total</td>
            <td align="right" style="padding:6px 0 18px;color:#c9a961;font-size:22px;font-weight:700;">${formatINR(order.total)}</td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:0 40px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#111;border:1px solid #1f1f1f;">
          <tr><td style="padding:20px 22px;">
            <div style="font-size:11px;letter-spacing:0.32em;color:#c9a961;text-transform:uppercase;margin-bottom:10px;">Shipping to</div>
            <div style="color:#f5f0e6;font-size:15px;font-weight:600;margin-bottom:4px;">${escapeHtml(c.name || "")}</div>
            <div style="color:#cfc7b3;font-size:14px;line-height:1.6;">${addressLine}</div>
            <div style="color:#8a8275;font-size:13px;margin-top:8px;">${escapeHtml(c.phone || "")} &middot; ${escapeHtml(c.email || "")}</div>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:0 40px 32px;">
        <div style="background:#0d0d0d;border-left:2px solid #c9a961;padding:14px 18px;color:#cfc7b3;font-size:13px;line-height:1.7;">
          We are crafting your card skins with care. You will receive a shipping update with tracking details as soon as your order leaves our studio &mdash; usually within 1&ndash;2 business days.
        </div>
      </td></tr>

      <tr><td style="padding:24px 40px 32px;border-top:1px solid #1a1a1a;text-align:center;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:11px;letter-spacing:0.42em;color:#c9a961;text-transform:uppercase;margin-bottom:8px;">carddesign.skin</div>
        <div style="color:#6b6557;font-size:12px;line-height:1.6;">Premium card skins, handcrafted in India.<br/>Need help? Reply to this email and we will get back to you.</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function buildShippingEmail(order) {
  const c = order.customer || {};
  const tracking = order.awb_code || "Will be shared shortly";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your order is on the way &middot; carddesign.skin</title>
</head>
<body style="margin:0;padding:0;background:#050505;font-family:Georgia,'Times New Roman',serif;color:#f5f0e6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#050505;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#0a0a0a;border:1px solid #1a1a1a;">
      <tr><td style="padding:36px 40px 24px;text-align:center;border-bottom:1px solid #1a1a1a;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:11px;letter-spacing:0.42em;color:#c9a961;text-transform:uppercase;">carddesign.skin</div>
        <h1 style="margin:18px 0 8px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:28px;letter-spacing:0.04em;color:#f5f0e6;">Your order is on the way</h1>
        <p style="margin:0;color:#8a8275;font-size:14px;">Order ${escapeHtml(order.id)}</p>
      </td></tr>

      <tr><td style="padding:28px 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#111;border:1px solid #1f1f1f;">
          <tr><td style="padding:20px 22px;">
            <div style="font-size:11px;letter-spacing:0.32em;color:#c9a961;text-transform:uppercase;margin-bottom:10px;">Tracking</div>
            <div style="color:#f5f0e6;font-size:18px;font-weight:600;letter-spacing:0.04em;margin-bottom:6px;">${escapeHtml(tracking)}</div>
            <div style="color:#8a8275;font-size:13px;">Shiprocket reference: ${escapeHtml(order.shiprocket_order_id || "Pending")}</div>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:0 40px 28px;">
        <div style="font-size:11px;letter-spacing:0.32em;color:#8a8275;text-transform:uppercase;margin-bottom:10px;">Shipping to</div>
        <div style="color:#f5f0e6;font-size:15px;font-weight:600;margin-bottom:4px;">${escapeHtml(c.name || "")}</div>
        <div style="color:#cfc7b3;font-size:14px;line-height:1.6;">${[c.address, c.city, c.state, c.pin].filter(Boolean).map(escapeHtml).join(", ")}</div>
      </td></tr>

      <tr><td style="padding:24px 40px 32px;border-top:1px solid #1a1a1a;text-align:center;">
        <div style="color:#6b6557;font-size:12px;line-height:1.6;">Thank you for choosing carddesign.skin.<br/>Reply to this email for any questions about your shipment.</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

async function sendConfirmationEmail(order) {
  return sendEmail({
    to: order.customer?.email,
    subject: `Your carddesign.skin order ${order.id} is confirmed`,
    html: buildOrderConfirmationEmail(order),
  });
}

async function sendShippingEmailForOrder(order, { force = false } = {}) {
  if (!order) throw new Error("Order not found");
  if (!order.awb_code && !force) {
    throw new Error("No AWB yet — Shiprocket has not assigned a tracking number");
  }
  if (order.shipping_email_status === "sent" || order.shipping_email_status === "sent_smtp") {
    if (!force) return { skipped: true, reason: "already_sent" };
  }
  const result = await sendEmail({
    to: order.customer?.email,
    subject: `Your carddesign.skin order ${order.id} is on the way`,
    html: buildShippingEmail(order),
  });
  await updateOrder(order.id, {
    shipping_email_status: result.status,
    shipping_email_sent_at: new Date().toISOString(),
  });
  return result;
}

async function fulfillPaidOrder(order, payment = {}) {
  if (!order) throw new Error("Paid order not found");
  const shiprocketOrder = await createShiprocketOrder({
    items: order.lines.map(({ id, quantity }) => ({ id, quantity })),
    customer: order.customer,
    payment: {
      razorpay_order_id: order.razorpay_order_id,
      razorpay_payment_id: payment.razorpay_payment_id || order.razorpay_payment_id,
    },
  });
  const updatedOrder = await updateOrder(order.id, {
    status: "ready_to_ship",
    shipping_status: shiprocketOrder.shipping_status || "created",
    shiprocket_order_id: shiprocketOrder.order_id || shiprocketOrder.shiprocket_order_id,
    awb_code: shiprocketOrder.awb_code,
  });
  await markConfirmationEmail(updatedOrder);
  // If Shiprocket already returned an AWB on creation (rare but possible),
  // fire the shipping email right away.
  if (updatedOrder.awb_code) {
    try {
      await sendShippingEmailForOrder(updatedOrder);
    } catch (e) {
      await updateOrder(updatedOrder.id, { shipping_email_error: e.message });
    }
  }
  return { updatedOrder, shiprocketOrder };
}

async function markConfirmationEmail(order) {
  try {
    const result = await sendConfirmationEmail(order);
    await updateOrder(order.id, { email_status: result.status });
  } catch (emailError) {
    await updateOrder(order.id, {
      email_status: "failed",
      email_error: emailError.message,
    });
  }
}

// Ask Shiprocket for the latest details on a Shiprocket order, then persist
// any AWB / shipping_status changes. Returns { updatedOrder, awb_added }.
async function refreshShiprocketOrder(order) {
  if (!order) throw new Error("Order not found");
  if (!order.shiprocket_order_id) {
    throw new Error("This order has no Shiprocket reference yet");
  }
  if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) {
    throw new Error("Shiprocket credentials are not configured");
  }
  const data = await shiprocketRequest(`/orders/show/${order.shiprocket_order_id}`);
  const sr = data.data || data;
  const shipment = Array.isArray(sr.shipments) ? sr.shipments[0] : sr.shipments || {};
  const awb = sr.awb_code || shipment?.awb || shipment?.awb_code || null;
  const status = sr.status || shipment?.status || order.shipping_status;
  const patch = {};
  if (awb && awb !== order.awb_code) patch.awb_code = awb;
  if (status && status !== order.shipping_status) patch.shipping_status = String(status);
  if (!Object.keys(patch).length) return { updatedOrder: order, awb_added: false };
  const updatedOrder = await updateOrder(order.id, patch);
  return { updatedOrder, awb_added: Boolean(awb && awb !== order.awb_code) };
}

// Background poller: every few minutes, scan unshipped orders for any that
// Shiprocket has now assigned an AWB to, and fire the "your order is on the
// way" email exactly once. Skipped silently in demo mode.
let _pollerStarted = false;
function startShiprocketPoller() {
  if (_pollerStarted) return;
  if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) return;
  _pollerStarted = true;
  const intervalMs = Number(process.env.SHIPROCKET_POLL_MS || 5 * 60 * 1000);
  const tick = async () => {
    try {
      const orders = await readOrders();
      const candidates = orders.filter((o) =>
        o.shiprocket_order_id &&
        !o.awb_code &&
        ["paid", "ready_to_ship", "paid_shipping_failed"].includes(o.status),
      );
      for (const order of candidates) {
        try {
          const { updatedOrder, awb_added } = await refreshShiprocketOrder(order);
          if (awb_added) {
            try {
              await sendShippingEmailForOrder(updatedOrder);
            } catch (e) {
              await updateOrder(updatedOrder.id, { shipping_email_error: e.message });
            }
          }
        } catch (e) {
          console.error("Shiprocket poll failed for", order.id, "->", e.message);
        }
      }
    } catch (e) {
      console.error("Shiprocket poller error:", e.message);
    }
  };
  setInterval(tick, intervalMs);
  // Run once shortly after boot too
  setTimeout(tick, 15_000);
}

function verifyRazorpayWebhook(rawBody, signature) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return safeCompare(signature, expected);
}

async function findOrderFromWebhookPayload(payload) {
  const payment = payload.payload?.payment?.entity;
  const orderEntity = payload.payload?.order?.entity;
  const razorpayOrderId = payment?.order_id || orderEntity?.id;
  if (!razorpayOrderId) return null;
  const orders = await readOrders();
  return orders.find((order) => order.razorpay_order_id === razorpayOrderId);
}

async function findShiprocketOrder(payload) {
  const candidates = [
    payload.order_id,
    payload.shiprocket_order_id,
    payload.sr_order_id,
    payload.awb,
    payload.awb_code,
    payload.current_tracking_status?.awb_code,
    payload.shipment?.awb_code,
    payload.shipment?.order_id,
  ].filter(Boolean).map(String);
  const orders = await readOrders();
  return orders.find((order) =>
    candidates.includes(String(order.shiprocket_order_id)) ||
    candidates.includes(String(order.awb_code)) ||
    candidates.includes(String(order.razorpay_order_id)) ||
    candidates.includes(String(order.id)),
  );
}

async function createRazorpayOrder(payload) {
  const order = await calculateOrder(payload.items);
  const amount = order.total * 100;
  const localOrderId = `cds_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const confirmationToken = crypto.randomBytes(32).toString("base64url");

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    const demoOrderId = `order_demo_${Date.now()}`;
    await saveOrder({
      id: localOrderId,
      razorpay_order_id: demoOrderId,
      status: "payment_pending",
      payment_status: "created_demo",
      shipping_status: "not_created",
      confirmation_token: confirmationToken,
      customer: payload.customer,
      ...order,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return {
      demo: true,
      id: demoOrderId,
      local_order_id: localOrderId,
      amount,
      currency: "INR",
      order,
    };
  }

  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency: "INR",
      receipt: localOrderId,
      notes: { customer_phone: payload.customer?.phone || "" },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.description || "Razorpay order failed");
  await saveOrder({
    id: localOrderId,
    razorpay_order_id: data.id,
    status: "payment_pending",
    payment_status: data.status || "created",
    shipping_status: "not_created",
    confirmation_token: confirmationToken,
    customer: payload.customer,
    ...order,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return { ...data, key: process.env.RAZORPAY_KEY_ID, local_order_id: localOrderId, order };
}

function verifyRazorpaySignature(payment) {
  if (!process.env.RAZORPAY_KEY_SECRET) return true;

  const payload = `${payment.razorpay_order_id}|${payment.razorpay_payment_id}`;
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(payload).digest("hex");
  return expected === payment.razorpay_signature;
}

async function createShiprocketOrder({ items, customer, payment }) {
  const order = await calculateOrder(items);
  const fullName = String(customer.name || "").trim();
  const nameParts = fullName.split(/\s+/);
  const firstName = nameParts.shift() || "Customer";
  const lastName = nameParts.join(" ") || ".";
  const body = {
    order_id: payment?.razorpay_order_id || `cds_${Date.now()}`,
    order_date: new Date().toISOString().slice(0, 10),
    pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION || "Primary",
    billing_customer_name: firstName,
    billing_last_name: lastName,
    billing_address: customer.address,
    billing_city: customer.city,
    billing_pincode: customer.pin,
    billing_state: customer.state,
    billing_country: "India",
    billing_email: customer.email,
    billing_phone: customer.phone,
    shipping_is_billing: true,
    order_items: order.lines.map((item) => ({
      name: item.name,
      sku: productSku(item),
      units: item.quantity,
      selling_price: item.price,
    })),
    payment_method: "Prepaid",
    sub_total: order.subtotal,
    length: 12,
    breadth: 9,
    height: 0.5,
    weight: 0.05,
  };

  const data = await shiprocketRequest("/orders/create/adhoc", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (data.demo) return { demo: true, shiprocket_order_id: `shiprocket_demo_${Date.now()}`, shipping_status: "created_demo" };
  return data;
}

async function handleApi(req, res, url) {
  try {
    const isUpload = req.method === "POST" && url.pathname === "/api/admin/products/upload";
    const body = req.method === "GET" ? { raw: "", json: {} } : await readBody(req, isUpload ? 6_000_000 : 1_000_000);
    const payload = body.json;

    if (req.method === "GET" && url.pathname === "/api/products") {
      const products = await getProducts();
      const settings = await readSettings();
      const visible = pushOutOfStockToEnd(products.filter((p) => p.enabled !== false));
      return json(res, 200, {
        products: visible,
        settings: {
          shippingFlat: settings.shippingFlat,
          featuredProductId: settings.featuredProductId || "",
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      if (!process.env.ADMIN_PASSWORD) {
        return json(res, 500, { error: "Admin password is not configured" });
      }
      if (!safeCompare(payload.password, process.env.ADMIN_PASSWORD)) {
        return json(res, 401, { error: "Wrong password" });
      }
      res.setHeader("Set-Cookie", cookieOptions(createSession(), Math.floor(SESSION_TTL_MS / 1000), req));
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      res.setHeader("Set-Cookie", cookieOptions("deleted", 0, req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/admin/") && !isAdminRequest(req)) {
      return json(res, 401, { error: "Admin login required" });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/orders") {
      const orders = await readOrders();
      return json(res, 200, { orders: orders.map(publicOrder) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/orders/refresh-shipping") {
      const id = String(payload.id || "");
      const orders = await readOrders();
      const order = orders.find((o) => o.id === id);
      if (!order) return json(res, 404, { error: "Order not found" });
      try {
        const { updatedOrder, awb_added } = await refreshShiprocketOrder(order);
        let emailResult = null;
        if (awb_added) {
          try {
            emailResult = await sendShippingEmailForOrder(updatedOrder);
          } catch (e) {
            await updateOrder(updatedOrder.id, { shipping_email_error: e.message });
            return json(res, 200, {
              order: publicOrder(await readOrders().then((os) => os.find((o) => o.id === id))),
              awb_added: true,
              shipping_email_error: e.message,
            });
          }
        }
        return json(res, 200, {
          order: publicOrder(await readOrders().then((os) => os.find((o) => o.id === id))),
          awb_added,
          email: emailResult,
        });
      } catch (error) {
        await updateOrder(order.id, { shipping_error: error.message });
        return json(res, 400, { error: error.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/admin/orders/send-shipping-email") {
      const id = String(payload.id || "");
      const force = Boolean(payload.force);
      const orders = await readOrders();
      const order = orders.find((o) => o.id === id);
      if (!order) return json(res, 404, { error: "Order not found" });
      try {
        const result = await sendShippingEmailForOrder(order, { force });
        const fresh = (await readOrders()).find((o) => o.id === id);
        return json(res, 200, { order: publicOrder(fresh), email: result });
      } catch (error) {
        await updateOrder(order.id, { shipping_email_error: error.message });
        return json(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/admin/products") {
      return json(res, 200, { products: await getProducts() });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/settings") {
      return json(res, 200, { settings: await readSettings() });
    }

    if (req.method === "PUT" && url.pathname === "/api/admin/settings") {
      const current = await readSettings();
      const next = { ...current };
      if (payload.shippingFlat !== undefined) {
        const value = Number(payload.shippingFlat);
        if (!Number.isFinite(value) || value < 0 || value > 100000) {
          return json(res, 400, { error: "Flat shipping must be a number between 0 and 100000" });
        }
        next.shippingFlat = Math.round(value);
      }
      if (payload.featuredProductId !== undefined) {
        const id = String(payload.featuredProductId || "").trim();
        if (id && !baseProducts.find((p) => p.id === id)) {
          return json(res, 400, { error: "Unknown featured product" });
        }
        next.featuredProductId = id;
      }
      if (payload.productOrder !== undefined) {
        if (!Array.isArray(payload.productOrder)) {
          return json(res, 400, { error: "productOrder must be an array" });
        }
        const validIds = new Set(baseProducts.map((p) => p.id));
        const seen = new Set();
        const cleaned = [];
        for (const raw of payload.productOrder) {
          const id = String(raw || "").trim();
          if (!validIds.has(id)) {
            return json(res, 400, { error: "Unknown product in order: " + id });
          }
          if (seen.has(id)) continue;
          seen.add(id);
          cleaned.push(id);
        }
        next.productOrder = cleaned;
      }
      await writeSettings(next);
      // The product list cache embeds the current order, so any settings
      // change must drop it.
      invalidateProductsCache();
      return json(res, 200, { settings: next });
    }

    if (req.method === "PUT" && url.pathname === "/api/admin/products") {
      const id = String(payload.id || "");
      const product = baseProducts.find((p) => p.id === id);
      if (!product) return json(res, 404, { error: "Product not found" });
      const overrides = await readProductOverrides();
      const current = overrides[id] || {};
      const next = { ...current };
      if (payload.name !== undefined) {
        const name = String(payload.name || "").trim();
        if (!name || name.length > 80) {
          return json(res, 400, { error: "Invalid name" });
        }
        next.name = name;
      }
      if (payload.price !== undefined) {
        const price = Number(payload.price);
        if (!Number.isFinite(price) || price < 0) {
          return json(res, 400, { error: "Invalid price" });
        }
        next.price = Math.round(price);
      }
      if (payload.stock !== undefined) {
        const stock = Number(payload.stock);
        if (!Number.isFinite(stock) || stock < 0) {
          return json(res, 400, { error: "Invalid stock" });
        }
        next.stock = Math.floor(stock);
      }
      if (payload.description !== undefined) {
        const description = String(payload.description || "").trim();
        if (description.length > 200) {
          return json(res, 400, { error: "Description too long (max 200 chars)" });
        }
        next.description = description;
      }
      if (payload.enabled !== undefined) {
        next.enabled = Boolean(payload.enabled);
      }
      overrides[id] = next;
      await writeProductOverrides(overrides);
      invalidateProductsCache();
      const products = await getProducts();
      return json(res, 200, { product: products.find((p) => p.id === id) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/products/upload") {
      const id = String(payload.id || "");
      const product = baseProducts.find((p) => p.id === id);
      if (!product) return json(res, 404, { error: "Product not found" });
      const dataUrl = String(payload.dataUrl || "");
      const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
      if (!match) return json(res, 400, { error: "Send a PNG, JPG, WEBP or GIF image" });
      const buffer = Buffer.from(match[2], "base64");
      if (buffer.length > 1_500_000) {
        return json(res, 400, { error: "Image must be under 1.5 MB. Compress or resize it first." });
      }
      const side = payload.side === "back" ? "back" : "front";
      const field = side === "back" ? "image_back" : "image";
      const overrides = await readProductOverrides();
      overrides[id] = { ...(overrides[id] || {}), [field]: dataUrl };
      await writeProductOverrides(overrides);
      invalidateProductsCache();
      const products = await getProducts();
      return json(res, 200, { product: products.find((p) => p.id === id) });
    }

    if (req.method === "DELETE" && url.pathname === "/api/admin/products/image") {
      const id = String(payload.id || "");
      const product = baseProducts.find((p) => p.id === id);
      if (!product) return json(res, 404, { error: "Product not found" });
      const side = payload.side === "back" ? "back" : "front";
      const field = side === "back" ? "image_back" : "image";
      const overrides = await readProductOverrides();
      if (overrides[id]) {
        const { [field]: _drop, ...rest } = overrides[id];
        overrides[id] = rest;
        await writeProductOverrides(overrides);
        invalidateProductsCache();
      }
      const products = await getProducts();
      return json(res, 200, { product: products.find((p) => p.id === id) });
    }

    if (req.method === "GET" && url.pathname === "/api/order/confirmation") {
      const id = url.searchParams.get("id");
      const token = url.searchParams.get("token");
      const orders = await readOrders();
      const order = orders.find((item) => item.id === id);
      if (!order || !order.confirmation_token || !token || !safeCompare(token, order.confirmation_token)) {
        return json(res, 404, { error: "Order not found" });
      }
      const paidStatuses = new Set(["paid", "ready_to_ship", "delivered", "paid_shipping_failed"]);
      if (!paidStatuses.has(order.status)) {
        return json(res, 404, { error: "Order not found" });
      }
      return json(res, 200, { order: confirmationOrder(order) });
    }

    if (req.method === "POST" && url.pathname === "/api/webhooks/razorpay") {
      const eventId = req.headers["x-razorpay-event-id"];
      if (!verifyRazorpayWebhook(body.raw, req.headers["x-razorpay-signature"])) {
        return json(res, 400, { error: "Invalid Razorpay webhook signature" });
      }
      if (await hasProcessedWebhook(eventId)) return json(res, 200, { ok: true, duplicate: true });

      const order = await findOrderFromWebhookPayload(payload);
      const payment = payload.payload?.payment?.entity || {};
      if (order && payload.event === "payment.captured") {
        const paidOrder = await updateOrder(order.id, {
          status: "paid",
          payment_status: "captured",
          razorpay_payment_id: payment.id,
        });
        try {
          await decrementStockForOrder(paidOrder);
        } catch (e) {
          console.error("Stock decrement failed for", paidOrder.id, "->", e.message);
        }
        if (paidOrder.shipping_status === "not_created" || paidOrder.shipping_status === "failed") {
          try {
            await fulfillPaidOrder(paidOrder, { razorpay_payment_id: payment.id });
          } catch (error) {
            await updateOrder(paidOrder.id, {
              status: "paid_shipping_failed",
              shipping_status: "failed",
              error: error.message,
            });
          }
        }
      } else if (order && payload.event === "payment.failed") {
        await updateOrder(order.id, {
          status: "payment_failed",
          payment_status: "failed",
          error: payment.error_description || "Payment failed",
        });
      } else if (order && payload.event === "payment.authorized") {
        await updateOrder(order.id, { payment_status: "authorized" });
      }

      await saveProcessedWebhook(eventId, "razorpay", payload.event);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/webhooks/shipping") {
      const token = req.headers["x-shiprocket-token"] || url.searchParams.get("token");
      if (process.env.SHIPROCKET_WEBHOOK_TOKEN && token !== process.env.SHIPROCKET_WEBHOOK_TOKEN) {
        return json(res, 401, { error: "Invalid webhook token" });
      }

      const order = await findShiprocketOrder(payload);
      if (order) {
        const shippingStatus =
          payload.current_status ||
          payload.shipment_status ||
          payload.status ||
          payload.current_tracking_status?.current_status ||
          "updated";
        const newAwb = payload.awb || payload.awb_code || payload.current_tracking_status?.awb_code || null;
        const updated = await updateOrder(order.id, {
          shipping_status: shippingStatus,
          status: String(shippingStatus).toLowerCase().includes("delivered") ? "delivered" : order.status,
          shiprocket_order_id: payload.order_id || payload.shiprocket_order_id || payload.sr_order_id || order.shiprocket_order_id,
          awb_code: newAwb || order.awb_code,
        });
        // First time we see an AWB → push the shipping email automatically
        if (newAwb && !order.awb_code) {
          try {
            await sendShippingEmailForOrder(updated);
          } catch (e) {
            await updateOrder(updated.id, { shipping_email_error: e.message });
          }
        }
      }
      await saveProcessedWebhook(payload.event_id || payload.id || `${Date.now()}`, "shiprocket", payload.event || payload.status || "shipment_update");
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/razorpay/order") {
      return json(res, 200, await createRazorpayOrder(payload));
    }

    if (req.method === "POST" && url.pathname === "/api/razorpay/verify") {
      if (!verifyRazorpaySignature(payload.payment || {})) {
        await updateOrder(payload.payment?.razorpay_order_id, {
          status: "payment_failed",
          payment_status: "signature_failed",
          error: "Payment signature verification failed",
        });
        return json(res, 400, { error: "Payment signature verification failed" });
      }
      await updateOrder(payload.payment.razorpay_order_id, {
        status: "paid",
        payment_status: "captured",
        razorpay_payment_id: payload.payment.razorpay_payment_id,
      });
      try {
        const orders = await readOrders();
        const paidOrder = orders.find((order) => order.razorpay_order_id === payload.payment.razorpay_order_id);
        try {
          await decrementStockForOrder(paidOrder);
        } catch (e) {
          console.error("Stock decrement failed for", paidOrder?.id, "->", e.message);
        }
        const { updatedOrder, shiprocketOrder } = await fulfillPaidOrder(paidOrder, payload.payment);
        return json(res, 200, {
          verified: true,
          order: publicOrder(updatedOrder),
          confirmation_token: updatedOrder.confirmation_token,
          ...shiprocketOrder,
        });
      } catch (error) {
        const updatedOrder = await updateOrder(payload.payment.razorpay_order_id, {
          status: "paid_shipping_failed",
          shipping_status: "failed",
          error: error.message,
        });
        try {
          const confirmationEmail = await sendEmail({
            to: updatedOrder.customer?.email,
            subject: `Order confirmed: ${updatedOrder.id}`,
            html: `<h1>Your carddesign.skin order is confirmed</h1><p>Order ID: <strong>${updatedOrder.id}</strong></p><p>We will follow up on shipping shortly.</p>`,
          });
          await updateOrder(updatedOrder.id, { email_status: confirmationEmail.status });
        } catch (emailError) {
          await updateOrder(updatedOrder.id, { email_status: "failed", email_error: emailError.message });
        }
        return json(res, 200, {
          verified: true,
          order: publicOrder(updatedOrder),
          confirmation_token: updatedOrder.confirmation_token,
          shipping_error: error.message,
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/shiprocket/serviceability") {
      const data = await shiprocketRequest(
        `/courier/serviceability/?pickup_postcode=${payload.pickup_postcode}&delivery_postcode=${payload.delivery_postcode}&cod=${payload.cod || 0}&weight=${payload.weight || 0.2}`,
      );
      if (data.demo) return json(res, 200, { demo: true, available: true, freight: 49 });
      const courier = data.data?.available_courier_companies?.[0];
      return json(res, 200, { available: Boolean(courier), freight: courier?.freight_charge || 0, courier });
    }

    return json(res, 404, { error: "API route not found" });
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
}

function serveNotFound(res) {
  const candidate = path.join(PUBLIC_DIR, "404.html");
  fs.readFile(candidate, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
}

function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const baseName = path.basename(filePath);
  const isPrivateFile =
    baseName.startsWith(".") ||
    requestedPath.startsWith("/data/") ||
    requestedPath.startsWith("/api/") ||
    requestedPath === "/server.js" ||
    requestedPath === "/package.json" ||
    requestedPath === "/package-lock.json" ||
    requestedPath === "/vercel.json" ||
    requestedPath === "/replit.md" ||
    requestedPath === "/replit.nix" ||
    requestedPath === "/README.md";

  if (isPrivateFile) {
    serveNotFound(res);
    return;
  }

  fs.readFile(filePath, async (error, content) => {
    if (error) {
      serveNotFound(res);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
    };

    // Server-side render product data into the storefront and checkout HTML so
    // there's no flash of an empty product grid / "loading bag" placeholder
    // before /api/products responds.
    const baseName = path.basename(filePath);
    let body = content;
    let isDynamicHtml = false;
    if (ext === ".html" && (baseName === "index.html" || baseName === "checkout.html")) {
      try {
        const raw = content.toString("utf8");
        const rendered =
          baseName === "index.html"
            ? await renderIndexHtml(raw)
            : await renderCheckoutHtml(raw);
        body = Buffer.from(rendered, "utf8");
        isDynamicHtml = true;
      } catch (_) {
        // Fall back to the raw file if SSR fails for any reason.
        body = content;
      }
    }

    if (process.env.NODE_ENV !== "production") {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
    } else if (isDynamicHtml) {
      // Page is rendered with live products/settings — keep it fresh.
      headers["Cache-Control"] = "no-store";
    } else if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) {
      // Long-lived cache for product/photo assets in production
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    } else if ([".css", ".js"].includes(ext)) {
      headers["Cache-Control"] = "public, max-age=3600";
    } else {
      headers["Cache-Control"] = "public, max-age=300";
    }
    res.writeHead(200, headers);
    res.end(body);
  });
}

function requestListener(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
}

if (require.main === module) {
  const HOST = process.env.HOST || "0.0.0.0";
  http.createServer(requestListener).listen(PORT, HOST, () => {
    console.log(`carddesign.skin running at http://${HOST}:${PORT}`);
    startShiprocketPoller();
  });
}

module.exports = requestListener;
module.exports.requestListener = requestListener;
module.exports.buildOrderConfirmationEmail = buildOrderConfirmationEmail;
module.exports.buildShippingEmail = buildShippingEmail;
