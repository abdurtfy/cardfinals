// Catalog is rendered server-side and seeded synchronously into
// `window.__INITIAL_PRODUCTS__` so the page never shows an empty grid or a
// "loading" placeholder. We still refresh from /api/products in the background
// to pick up any admin edits made after the HTML was generated.
const DEFAULT_BG = "linear-gradient(135deg, #050608, #ffb627 28%, #ff3c8a 58%, #25d9ff)";

function _normalizeProduct(live) {
  return {
    id: live.id,
    name: typeof live.name === "string" ? live.name : "",
    category: typeof live.category === "string" ? live.category : "",
    finish: typeof live.finish === "string" ? live.finish : "Premium vinyl",
    price: typeof live.price === "number" ? live.price : 0,
    stock: typeof live.stock === "number" ? live.stock : 0,
    image: typeof live.image === "string" ? live.image : null,
    image_back: typeof live.image_back === "string" ? live.image_back : null,
    description: typeof live.description === "string" ? live.description : "",
    bg: DEFAULT_BG,
  };
}

const products = Array.isArray(window.__INITIAL_PRODUCTS__)
  ? window.__INITIAL_PRODUCTS__.map(_normalizeProduct)
  : [];

let cart = JSON.parse(localStorage.getItem("carddesign-cart") || "{}");

window.productsReady = new Promise((resolve) => {
  window._resolveProductsReady = resolve;
});

window.storeSettings = { shippingFlat: 49, featuredProductId: "" };
if (window.__INITIAL_SETTINGS__) {
  if (Number.isFinite(Number(window.__INITIAL_SETTINGS__.shippingFlat))) {
    window.storeSettings.shippingFlat = Number(window.__INITIAL_SETTINGS__.shippingFlat);
  }
  if (typeof window.__INITIAL_SETTINGS__.featuredProductId === "string") {
    window.storeSettings.featuredProductId = window.__INITIAL_SETTINGS__.featuredProductId;
  }
}

// If the server already gave us products, treat the catalog as ready right
// away so checkout/render code paths run synchronously on first paint.
if (products.length) {
  window._resolveProductsReady();
}

async function loadLiveProducts() {
  try {
    const response = await fetch("/api/products");
    if (!response.ok) {
      window._resolveProductsReady();
      return;
    }
    const data = await response.json();
    if (data.settings) {
      if (Number.isFinite(Number(data.settings.shippingFlat))) {
        window.storeSettings.shippingFlat = Number(data.settings.shippingFlat);
      }
      if (typeof data.settings.featuredProductId === "string") {
        window.storeSettings.featuredProductId = data.settings.featuredProductId;
      }
    }
    products.length = 0;
    (data.products || []).forEach((live) => {
      products.push(_normalizeProduct(live));
    });
    document.dispatchEvent(new CustomEvent("products:updated"));
    renderSharedCart();
    window._resolveProductsReady();
  } catch {
    window._resolveProductsReady();
  }
}
loadLiveProducts();
setTimeout(() => window._resolveProductsReady(), 2500);

function formatCurrency(value) {
  return `Rs ${value.toLocaleString("en-IN")}`;
}

function saveCart() {
  localStorage.setItem("carddesign-cart", JSON.stringify(cart));
}

function getCartLines() {
  return Object.entries(cart)
    .map(([id, quantity]) => {
      const product = products.find((item) => item.id === id);
      return product ? { ...product, quantity } : null;
    })
    .filter(Boolean);
}

function getGrossSubtotal() {
  return getCartLines().reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function getBuy2Get1Discount() {
  const lines = getCartLines();
  const unitPrices = [];
  lines.forEach((item) => {
    for (let i = 0; i < item.quantity; i += 1) unitPrices.push(item.price);
  });
  unitPrices.sort((a, b) => a - b);
  const freeCount = Math.floor(unitPrices.length / 3);
  let discount = 0;
  for (let i = 0; i < freeCount; i += 1) discount += unitPrices[i];
  return discount;
}

function getSubtotal() {
  return getGrossSubtotal() - getBuy2Get1Discount();
}

function getShippingCost() {
  const subtotal = getSubtotal();
  const flat = Number.isFinite(window.storeSettings.shippingFlat)
    ? window.storeSettings.shippingFlat
    : 49;
  return subtotal >= 495 || subtotal === 0 ? 0 : flat;
}

function getTotal() {
  return getSubtotal() + getShippingCost();
}

function showToast(message) {
  let toast = document.querySelector("#cartToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "cartToast";
    toast.className = "cart-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove("show");
  void toast.offsetWidth;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 1800);
}

function addToCart(id) {
  const product = products.find((item) => item.id === id);
  if (!product) return;
  if (product.stock <= 0) {
    showToast(`${product.name} is out of stock`);
    return;
  }
  const current = cart[id] || 0;
  if (current + 1 > product.stock) {
    showToast(`Only ${product.stock} of ${product.name} available`);
    return;
  }
  cart[id] = current + 1;
  saveCart();
  renderSharedCart();
  showToast(`Added ${product.name} to cart`);
}

function decreaseCart(id) {
  if (!cart[id]) return;
  cart[id] -= 1;
  if (cart[id] <= 0) delete cart[id];
  saveCart();
  renderSharedCart();
}

function renderSharedCart() {
  const lines = getCartLines();
  const itemCount = lines.reduce((sum, item) => sum + item.quantity, 0);
  const cartCount = document.querySelector("#cartCount");
  const drawerTotal = document.querySelector("#drawerTotal");
  const drawerSubtotal = document.querySelector("#drawerSubtotal");
  const drawerShipping = document.querySelector("#drawerShipping");
  const drawerDiscountRow = document.querySelector("#drawerDiscountRow");
  const drawerDiscount = document.querySelector("#drawerDiscount");
  const cartPromoMsg = document.querySelector("#cartPromoMsg");
  const cartShipMsg = document.querySelector("#cartShipMsg");
  const cartItems = document.querySelector("#cartItems");

  const discountValue = getBuy2Get1Discount();
  const subtotal = getSubtotal();
  const shippingCost = getShippingCost();

  if (cartCount) cartCount.textContent = itemCount;
  if (drawerSubtotal) drawerSubtotal.textContent = formatCurrency(getGrossSubtotal());
  if (drawerShipping) {
    if (itemCount === 0) {
      drawerShipping.textContent = "—";
    } else {
      drawerShipping.textContent = shippingCost === 0 ? "Free" : formatCurrency(shippingCost);
    }
  }
  if (drawerDiscountRow && drawerDiscount) {
    if (discountValue > 0) {
      drawerDiscountRow.hidden = false;
      drawerDiscount.textContent = `- ${formatCurrency(discountValue)}`;
    } else {
      drawerDiscountRow.hidden = true;
    }
  }
  if (drawerTotal) drawerTotal.textContent = formatCurrency(getTotal());

  if (cartPromoMsg) {
    const remainder = itemCount % 3;
    if (itemCount === 0) {
      cartPromoMsg.textContent = "Buy 2 get 1 free on every 3rd item.";
    } else if (remainder === 0) {
      cartPromoMsg.textContent = `Buy 2 get 1 free applied${discountValue > 0 ? ` (${formatCurrency(discountValue)} off)` : ""}.`;
    } else {
      const need = 3 - remainder;
      cartPromoMsg.textContent = `Add ${need} more item${need === 1 ? "" : "s"} to get 1 free.`;
    }
  }

  if (cartShipMsg) {
    if (subtotal === 0) {
      cartShipMsg.textContent = "Free shipping over Rs 495.";
    } else if (shippingCost === 0) {
      cartShipMsg.textContent = "Free shipping unlocked.";
    } else {
      const left = 495 - subtotal;
      cartShipMsg.textContent = `Add ${formatCurrency(left)} more for free shipping.`;
    }
  }
  if (cartItems) {
    cartItems.innerHTML = lines.length
      ? lines
          .map(
            (item) => `
              <div class="cart-item">
                <div class="cart-thumb" style="${item.image ? `background:#111 center/cover url('${item.image}');` : `--skin-bg: ${item.bg};`}"></div>
                <div>
                  <strong>${item.name}</strong>
                  <span>${formatCurrency(item.price)} · ${item.finish}</span>
                </div>
                <div class="qty-controls" aria-label="${item.name} quantity controls">
                  <button type="button" data-decrease="${item.id}">-</button>
                  <strong>${item.quantity}</strong>
                  <button type="button" data-add="${item.id}">+</button>
                </div>
              </div>
            `,
          )
          .join("")
      : `<p class="muted">Your cart is empty.</p>`;
  }
}

function setupCartDrawer() {
  const cartButton = document.querySelector("#cartButton");
  const closeCartButton = document.querySelector("#closeCartButton");
  const cartDrawer = document.querySelector("#cartDrawer");

  if (!cartDrawer) return;

  cartButton?.addEventListener("click", () => {
    cartDrawer.classList.add("open");
    cartDrawer.setAttribute("aria-hidden", "false");
  });

  closeCartButton?.addEventListener("click", () => {
    cartDrawer.classList.remove("open");
    cartDrawer.setAttribute("aria-hidden", "true");
  });

  cartDrawer.addEventListener("click", (event) => {
    if (event.target === cartDrawer) {
      cartDrawer.classList.remove("open");
      cartDrawer.setAttribute("aria-hidden", "true");
    }
  });
}

function flyToCart(productId, sourceEl) {
  const cartButton = document.querySelector(".cart-button");
  if (!cartButton || !sourceEl) return;

  const product = products.find((p) => p.id === productId);
  const sourceRect = sourceEl.getBoundingClientRect();
  const targetRect = cartButton.getBoundingClientRect();
  if (!sourceRect.width || !sourceRect.height) return;

  // Build a clean flat thumbnail of the product (no nested 3D faces, no overlays)
  const flyer = document.createElement("div");
  flyer.className = "fly-to-cart";
  if (product && product.image) {
    flyer.style.backgroundImage = `url('${product.image}')`;
    flyer.style.backgroundSize = "cover";
    flyer.style.backgroundPosition = "center";
    flyer.style.backgroundColor = "#111";
  } else if (product && product.bg) {
    flyer.style.background = product.bg;
  } else {
    flyer.style.background = "#111";
  }
  flyer.style.left = sourceRect.left + "px";
  flyer.style.top = sourceRect.top + "px";
  flyer.style.width = sourceRect.width + "px";
  flyer.style.height = sourceRect.height + "px";
  flyer.style.transform = "translate(0, 0) scale(1) rotate(0deg)";
  flyer.style.opacity = "1";

  document.body.appendChild(flyer);

  const dx =
    targetRect.left + targetRect.width / 2 - (sourceRect.left + sourceRect.width / 2);
  const dy =
    targetRect.top + targetRect.height / 2 - (sourceRect.top + sourceRect.height / 2);

  // Double-rAF to guarantee the browser sees the start state before the change
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flyer.style.transform = `translate(${dx}px, ${dy}px) scale(0.08) rotate(15deg)`;
      flyer.style.opacity = "0.25";
    });
  });

  const cleanup = () => {
    if (!flyer.isConnected) return;
    flyer.remove();
    cartButton.classList.remove("cart-bump");
    void cartButton.offsetWidth;
    cartButton.classList.add("cart-bump");
    setTimeout(() => cartButton.classList.remove("cart-bump"), 500);

    // Spawn the +1 badge that pops out of the cart icon
    const badge = document.createElement("span");
    badge.className = "cart-plus-badge";
    badge.textContent = "+1";
    badge.setAttribute("aria-hidden", "true");
    cartButton.appendChild(badge);
    badge.addEventListener("animationend", () => badge.remove(), { once: true });
    setTimeout(() => badge.isConnected && badge.remove(), 1200);
  };
  flyer.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, 1000); // failsafe
}

document.addEventListener("click", (event) => {
  const addButton = event.target.closest("[data-add]");
  const decreaseButton = event.target.closest("[data-decrease]");

  if (addButton) {
    const id = addButton.dataset.add;
    const productCard = addButton.closest(".product-card");
    const art = productCard?.querySelector(".product-art");
    if (art) flyToCart(id, art);
    addToCart(id);
  }
  if (decreaseButton) decreaseCart(decreaseButton.dataset.decrease);
});

setupCartDrawer();
renderSharedCart();
