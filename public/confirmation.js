const confirmationPanel = document.querySelector("#confirmationPanel");
const params = new URLSearchParams(window.location.search);
const orderId = params.get("order");
const token = params.get("token");

function formatCurrency(value) {
  return `Rs ${Number(value || 0).toLocaleString("en-IN")}`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function loadConfirmation() {
  if (!orderId || !token) {
    confirmationPanel.innerHTML = `<p class="status-line">Missing or invalid order link.</p>`;
    return;
  }

  const response = await fetch(`/api/order/confirmation?id=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`);
  const data = await response.json();
  if (!response.ok) {
    confirmationPanel.innerHTML = `<p class="status-line">${escapeHtml(data.error || "Order not found")}</p>`;
    return;
  }

  const order = data.order;
  const itemsHtml = (order.lines || [])
    .map((item) => `<li><span>${escapeHtml(item.name)}</span><span>× ${escapeHtml(item.quantity)}</span></li>`)
    .join("");

  const trackingBlock = order.has_shipped
    ? `<div class="confirm-block">
        <p class="eyebrow">Tracking</p>
        <p class="confirm-line">AWB <strong>${escapeHtml(order.awb_code)}</strong></p>
        <p class="muted small">We've also emailed your tracking details.</p>
      </div>`
    : `<div class="confirm-block">
        <p class="eyebrow">What's next</p>
        <p class="confirm-line">We'll email your tracking link the moment your order ships.</p>
      </div>`;

  confirmationPanel.innerHTML = `
    <div class="confirm-hero">
      <p class="eyebrow">Payment successful</p>
      <h2 class="confirm-thanks">Thank you${order.customer_email ? `, we've emailed you a receipt at <strong>${escapeHtml(order.customer_email)}</strong>` : ""}.</h2>
      <p class="muted">Order reference: <strong>${escapeHtml(order.id)}</strong></p>
    </div>

    <div class="confirm-block">
      <p class="eyebrow">Your order</p>
      <ul class="confirm-items">${itemsHtml}</ul>
    </div>

    <div class="confirm-block confirm-totals">
      <div><span class="muted">Subtotal</span><span>${formatCurrency(order.subtotal)}</span></div>
      <div><span class="muted">Shipping</span><span>${order.shipping ? formatCurrency(order.shipping) : "Free"}</span></div>
      <div class="confirm-total-row"><strong>Total</strong><strong>${formatCurrency(order.total)}</strong></div>
    </div>

    ${trackingBlock}

    <a class="primary-action" href="./index.html">Continue shopping</a>
  `;
}

loadConfirmation();
