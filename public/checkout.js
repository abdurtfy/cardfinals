const summaryItems = document.querySelector("#summaryItems");
const subtotal = document.querySelector("#subtotal");
const discountRow = document.querySelector("#discountRow");
const discount = document.querySelector("#discount");
const shipping = document.querySelector("#shipping");
const total = document.querySelector("#total");
const checkoutForm = document.querySelector("#checkoutForm");
const checkoutStatus = document.querySelector("#checkoutStatus");

function renderSummary() {
  const lines = getCartLines();
  subtotal.textContent = formatCurrency(getGrossSubtotal());
  const discountValue = getBuy2Get1Discount();
  if (discountValue > 0) {
    discountRow.hidden = false;
    discount.textContent = `- ${formatCurrency(discountValue)}`;
  } else {
    discountRow.hidden = true;
  }
  shipping.textContent = formatCurrency(getShippingCost());
  total.textContent = formatCurrency(getTotal());

  summaryItems.innerHTML = lines.length
    ? lines
        .map(
          (item) => `
            <div class="bag-item">
              <div class="bag-thumb" style="${item.image ? `background:#111 center/cover url('${item.image}');` : `--skin-bg: ${item.bg};`}"></div>
              <div class="bag-item-info">
                <strong>${item.name}</strong>
                <span>x${item.quantity}</span>
              </div>
              <strong class="bag-item-price">${formatCurrency(item.price * item.quantity)}</strong>
            </div>
          `,
        )
        .join("")
    : `<p class="muted">Your bag is empty. Add products before checkout.</p>`;
}

function getCustomerPayload() {
  const formData = new FormData(checkoutForm);
  return Object.fromEntries(formData.entries());
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

checkoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const lines = getCartLines();
  if (!lines.length) {
    checkoutStatus.textContent = "Add at least one product before checkout.";
    return;
  }

  checkoutStatus.textContent = "Creating Razorpay order...";
  try {
    const customer = getCustomerPayload();
    const order = await postJson("/api/razorpay/order", {
      items: lines.map(({ id, quantity }) => ({ id, quantity })),
      customer,
    });

    if (!window.Razorpay || order.demo) {
      checkoutStatus.textContent = `Backend order created in demo mode. Add Razorpay keys to launch live payment. Order: ${order.id}`;
      return;
    }

    const razorpay = new window.Razorpay({
      key: order.key,
      amount: order.amount,
      currency: order.currency,
      name: "carddesign.skin",
      description: "Premium card skins",
      order_id: order.id,
      prefill: {
        name: customer.name,
        email: customer.email,
        contact: customer.phone,
      },
      handler: async (payment) => {
        checkoutStatus.textContent = "Verifying payment and creating Shiprocket order...";
        const verified = await postJson("/api/razorpay/verify", { payment });
        localStorage.removeItem("carddesign-cart");
        const finalId = verified.order?.id || order.local_order_id;
        const token = verified.confirmation_token || "";
        window.location.href = `./confirmation.html?order=${encodeURIComponent(finalId)}&token=${encodeURIComponent(token)}`;
      },
      theme: { color: "#ff3c8a" },
    });

    razorpay.open();
  } catch (error) {
    checkoutStatus.textContent = error.message;
  }
});

let _summaryRendered = false;
function renderSummaryOnce() {
  if (_summaryRendered) return;
  _summaryRendered = true;
  renderSummary();
}

// Products are seeded synchronously from `window.__INITIAL_PRODUCTS__`
// (server-rendered), so we render the bag immediately on first paint and only
// fall back to a "Loading…" placeholder if the catalog is genuinely empty
// while we wait for /api/products.
if (products && products.length) {
  renderSummaryOnce();
} else if (summaryItems) {
  summaryItems.innerHTML = `<p class="muted">Loading your bag…</p>`;
}

if (window.productsReady && typeof window.productsReady.then === "function") {
  window.productsReady.then(renderSummaryOnce);
}
setTimeout(renderSummaryOnce, 2500);
document.addEventListener("products:updated", () => {
  _summaryRendered = true;
  renderSummary();
});
