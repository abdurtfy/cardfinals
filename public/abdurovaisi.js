const ordersList = document.querySelector("#ordersList");
const orderCount = document.querySelector("#orderCount");
const refreshOrders = document.querySelector("#refreshOrders");
const logoutButton = document.querySelector("#logoutButton");
const catalogList = document.querySelector("#catalogList");
const imagesList = document.querySelector("#imagesList");
const shippingSettings = document.querySelector("#shippingSettings");
const tabs = document.querySelectorAll(".admin-tab");
const sections = document.querySelectorAll(".admin-section");

function formatCurrency(value) {
  return `Rs ${Number(value || 0).toLocaleString("en-IN")}`;
}

function formatDate(value) {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function activateTab(name) {
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  sections.forEach((section) => {
    section.hidden = section.dataset.section !== name;
  });
  if (name === "shipping") loadShippingSettings();
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

function statusTone(value) {
  const v = String(value || "").toLowerCase();
  if (["paid", "delivered", "shipped", "sent", "completed", "success"].some((k) => v.includes(k))) return "ok";
  if (["fail", "error", "cancel", "refund"].some((k) => v.includes(k))) return "bad";
  if (!v || ["pending", "not_created", "unknown"].includes(v)) return "wait";
  return "info";
}

function badge(label, value) {
  const tone = statusTone(value);
  const display = value || "pending";
  return `<span class="order-badge tone-${tone}"><em>${label}</em>${display}</span>`;
}

function classifyOrder(order) {
  const orderStatus = String(order.status || "").toLowerCase();
  const shippingStatus = String(order.shipping_status || "").toLowerCase();
  const paymentStatus = String(order.payment_status || "").toLowerCase();
  if (
    orderStatus.includes("fail") ||
    orderStatus.includes("cancel") ||
    orderStatus.includes("refund") ||
    shippingStatus === "failed" ||
    paymentStatus.includes("fail")
  ) return "failed";
  if (shippingStatus.includes("delivered") || orderStatus === "delivered") return "shipped";
  if (shippingStatus.includes("shipped") || orderStatus === "shipped") return "shipped";
  if (shippingStatus === "ready_to_ship" || orderStatus === "ready_to_ship") return "ready";
  if (orderStatus === "paid") return "paid";
  return "other";
}

let _allOrders = [];
let _orderFilter = "all";
// Pending per-order feedback messages, displayed once the matching order
// article is rendered. Lets us re-render orders after an admin action while
// keeping the success/error message visible.
const _pendingFeedback = new Map();

function renderOrders(orders) {
  _allOrders = orders;
  const counts = { all: orders.length, paid: 0, ready: 0, shipped: 0, failed: 0 };
  orders.forEach((o) => {
    const c = classifyOrder(o);
    if (counts[c] !== undefined) counts[c] += 1;
  });
  document.querySelectorAll("#orderFilters .filter-count").forEach((el) => {
    const key = el.dataset.count;
    el.textContent = String(counts[key] || 0);
  });

  const filtered = _orderFilter === "all"
    ? orders
    : orders.filter((o) => classifyOrder(o) === _orderFilter);

  orderCount.textContent = `${filtered.length} ${filtered.length === 1 ? "order" : "orders"}${_orderFilter !== "all" ? ` · ${_orderFilter}` : ""}`;
  // Drop feedback for orders that aren't in the current view anymore
  for (const id of [..._pendingFeedback.keys()]) {
    if (!filtered.some((o) => o.id === id)) _pendingFeedback.delete(id);
  }

  ordersList.innerHTML = filtered.length
    ? filtered
        .map((order) => {
          const cityLine = [order.customer?.city, order.customer?.state, order.customer?.pin]
            .filter(Boolean)
            .join(", ");
          const contactLine = [order.customer?.email, order.customer?.phone].filter(Boolean).join(" · ");
          return `
            <article class="admin-order">
              <header class="order-top">
                <div class="order-id">
                  <span class="order-num">#${order.id}</span>
                  <span class="order-date">${formatDate(order.created_at)}</span>
                </div>
                <div class="order-total">${formatCurrency(order.total)}</div>
              </header>

              <div class="order-badges">
                ${badge("Order", order.status)}
                ${badge("Payment", order.payment_status)}
                ${badge("Shipping", order.shipping_status)}
              </div>

              <div class="order-customer">
                <p class="order-name">${order.customer?.name || "Not provided"}</p>
                ${contactLine ? `<p class="muted">${contactLine}</p>` : ""}
                <p class="muted">${order.customer?.address || "Not provided"}${cityLine ? ` · ${cityLine}` : ""}</p>
              </div>

              ${
                (order.lines || []).length
                  ? `<div class="admin-items">
                      ${(order.lines || [])
                        .map((item) => `<span>${item.name} × ${item.quantity}</span>`)
                        .join("")}
                    </div>`
                  : ""
              }

              <details class="order-details">
                <summary>Technical details</summary>
                <dl class="order-meta">
                  <dt>Razorpay</dt><dd>${order.razorpay_order_id || "pending"}</dd>
                  <dt>Shiprocket</dt><dd>${order.shiprocket_order_id || "pending"}</dd>
                  <dt>AWB</dt><dd>${order.awb_code || "pending"}</dd>
                  <dt>Confirmation email</dt><dd>${order.email_status || "pending"}</dd>
                  <dt>Shipping email</dt><dd>${order.shipping_email_status || "pending"}${order.shipping_email_sent_at ? ` · ${formatDate(order.shipping_email_sent_at)}` : ""}</dd>
                </dl>
              </details>

              ${order.shiprocket_order_id ? `
                <div class="order-actions">
                  <button class="secondary-action" type="button" data-refresh-shipping="${order.id}">
                    ${order.awb_code ? "Refresh from Shiprocket" : "Check for AWB now"}
                  </button>
                  ${order.awb_code ? `<button class="secondary-action" type="button" data-send-shipping="${order.id}">
                    ${(order.shipping_email_status === "sent" || order.shipping_email_status === "sent_smtp") ? "Resend shipping email" : "Send shipping email"}
                  </button>` : ""}
                </div>
              ` : ""}

              ${order.shipping_error ? `<p class="order-alert"><strong>Shipping:</strong> ${order.shipping_error}</p>` : ""}
              ${order.shipping_email_error ? `<p class="order-alert"><strong>Shipping email:</strong> ${order.shipping_email_error}</p>` : ""}
              ${order.email_error ? `<p class="order-alert"><strong>Confirmation email:</strong> ${order.email_error}</p>` : ""}
              ${order.error ? `<p class="order-alert">${order.error}</p>` : ""}
              <p class="order-note" data-action-feedback="${order.id}" hidden></p>
            </article>
          `;
        })
        .join("")
    : `<p class="muted">No orders yet. Create one from checkout and it will appear here.</p>`;

  // Hydrate any pending feedback messages onto the freshly rendered articles
  _pendingFeedback.forEach((entry, id) => {
    const target = ordersList.querySelector(`[data-action-feedback="${id}"]`);
    if (!target) return;
    target.hidden = false;
    target.textContent = entry.text;
    target.classList.toggle("order-alert", entry.tone === "error");
    target.classList.toggle("order-note", entry.tone !== "error");
  });
}

function setOrderFeedback(id, text, tone = "ok") {
  _pendingFeedback.set(id, { text, tone });
  const target = ordersList.querySelector(`[data-action-feedback="${id}"]`);
  if (target) {
    target.hidden = false;
    target.textContent = text;
    target.classList.toggle("order-alert", tone === "error");
    target.classList.toggle("order-note", tone !== "error");
  }
}

function patchOrderInList(updated) {
  if (!updated || !updated.id) return;
  const idx = _allOrders.findIndex((o) => o.id === updated.id);
  if (idx === -1) return;
  _allOrders[idx] = { ..._allOrders[idx], ...updated };
  renderOrders(_allOrders);
}

async function loadOrders() {
  ordersList.innerHTML = `<p class="muted">Loading orders...</p>`;
  try {
    const response = await fetch("/api/admin/orders");
    const data = await response.json();
    if (response.status === 401) {
      window.location.href = "./abdurovaisi-login.html";
      return;
    }
    if (!response.ok) throw new Error(data.error || "Could not load orders");
    renderOrders(data.orders);
  } catch (error) {
    ordersList.innerHTML = `<p class="status-line">${error.message}</p>`;
  }
}

logoutButton.addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST" });
  window.location.href = "./abdurovaisi-login.html";
});

function renderCatalog(items) {
  // The Settings tab's featured-product picker depends on the latest product
  // list, so any catalog refresh should make us refetch settings the next time
  // that tab is opened.
  _shippingLoaded = false;
  catalogList.innerHTML = items
    .map(
      (p) => `
        <div class="catalog-row" data-id="${p.id}">
          <button class="drag-handle" type="button" data-drag-handle aria-label="Drag to reorder" title="Drag to reorder">⠿</button>
          <div class="catalog-name">
            <strong>${p.name}</strong>
            <span class="stock-tag ${p.stock > 0 ? "in" : "out"}">${p.stock > 0 ? "Available" : "Out of stock"}</span>
            <span class="stock-tag ${p.enabled === false ? "out" : "in"}" data-visibility-tag>${p.enabled === false ? "Hidden" : "Visible"}</span>
          </div>
          <div>
            <label>Price (Rs)</label>
            <input type="number" min="0" step="1" data-field="price" value="${p.price}" />
          </div>
          <div>
            <label>Stock</label>
            <input type="number" min="0" step="1" data-field="stock" value="${p.stock}" />
          </div>
          <button class="secondary-action" type="button" data-toggle="${p.id}" data-enabled="${p.enabled !== false}">${p.enabled === false ? "Show on site" : "Hide from site"}</button>
          <button class="secondary-action" type="button" data-save="${p.id}">Save</button>
        </div>
      `,
    )
    .join("");
}

// --- Drag-to-reorder for the Stock tab catalog ---
//
// Rows are not draggable by default — the user must press on the dedicated
// handle to start a drag. This keeps the price/stock inputs fully clickable
// for text editing without accidentally initiating a drag.
let _dragRow = null;

function getCatalogOrder() {
  return Array.from(catalogList.querySelectorAll(".catalog-row[data-id]"))
    .map((row) => row.getAttribute("data-id"));
}

async function persistCatalogOrder() {
  const order = getCatalogOrder();
  try {
    const response = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productOrder: order }),
    });
    if (response.status === 401) {
      window.location.href = "./abdurovaisi-login.html";
      return;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save order");
    // Keep the Images tab and Settings picker aligned with the new sequence.
    const productsResponse = await fetch("/api/admin/products");
    if (productsResponse.ok) {
      const productsData = await productsResponse.json();
      renderImages(productsData.products);
    }
  } catch (error) {
    // If the save fails, restore from the server so the UI matches reality.
    loadCatalog();
    alert("Could not save the new order: " + error.message);
  }
}

// Find the catalog row the cursor is hovering over (or just past) so we know
// where to drop the dragged row. Returns null when the cursor is below the
// last row, in which case the dragged row is appended at the end.
function getDropTargetAfter(y) {
  const rows = Array.from(
    catalogList.querySelectorAll(".catalog-row[data-id]:not(.dragging)"),
  );
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (y < box.top + box.height / 2) return row;
  }
  return null;
}

catalogList.addEventListener("mousedown", (event) => {
  const handle = event.target.closest("[data-drag-handle]");
  if (!handle) return;
  const row = handle.closest(".catalog-row");
  if (row) row.setAttribute("draggable", "true");
});

catalogList.addEventListener("mouseup", () => {
  catalogList.querySelectorAll('.catalog-row[draggable="true"]').forEach((row) => {
    row.removeAttribute("draggable");
  });
});

catalogList.addEventListener("dragstart", (event) => {
  const row = event.target.closest(".catalog-row[draggable='true']");
  if (!row) return;
  _dragRow = row;
  row.classList.add("dragging");
  // Some browsers require dataTransfer to be set for drag to fire.
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.getAttribute("data-id") || "");
  }
});

catalogList.addEventListener("dragover", (event) => {
  if (!_dragRow) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const after = getDropTargetAfter(event.clientY);
  if (after == null) {
    catalogList.appendChild(_dragRow);
  } else if (after !== _dragRow.nextSibling) {
    catalogList.insertBefore(_dragRow, after);
  }
});

catalogList.addEventListener("drop", (event) => {
  if (_dragRow) event.preventDefault();
});

catalogList.addEventListener("dragend", () => {
  if (!_dragRow) return;
  _dragRow.classList.remove("dragging");
  _dragRow.removeAttribute("draggable");
  _dragRow = null;
  persistCatalogOrder();
});

function sidePreviewStyle(image) {
  return image
    ? `background:#111 center/cover url('${image}');`
    : `--skin-bg: linear-gradient(135deg, #1f2937, #111827);`;
}

function sideBlock(p, side) {
  const image = side === "back" ? p.image_back : p.image;
  const label = side === "back" ? "Back" : "Front";
  return `
    <div class="image-side" data-side="${side}">
      <div class="image-preview" data-preview style="${sidePreviewStyle(image)}"></div>
      <p class="image-side-label">${label}</p>
      <div class="image-side-actions">
        <label class="secondary-action upload-label">
          ${image ? "Replace" : "Upload"}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-upload="${p.id}" data-side="${side}" hidden />
        </label>
        ${image ? `<button class="secondary-action" type="button" data-remove-image="${p.id}" data-side="${side}">Remove</button>` : ""}
      </div>
    </div>
  `;
}

function renderImages(items) {
  imagesList.innerHTML = items
    .map(
      (p) => `
        <div class="image-row" data-id="${p.id}">
          <div class="image-sides">
            ${sideBlock(p, "front")}
            ${sideBlock(p, "back")}
          </div>
          <div class="image-info">
            <label>Name</label>
            <input type="text" data-field="name" maxlength="80" value="${(p.name || "").replace(/"/g, "&quot;")}" />
            <label>Description</label>
            <input type="text" data-field="description" maxlength="200" placeholder="${p.category} card skin · ${p.finish || ""}" value="${(p.description || "").replace(/"/g, "&quot;")}" />
            <button class="secondary-action" type="button" data-save-text="${p.id}">Save text</button>
          </div>
        </div>
      `,
    )
    .join("");
}

async function loadCatalog() {
  try {
    const response = await fetch("/api/admin/products");
    if (response.status === 401) {
      window.location.href = "./abdurovaisi-login.html";
      return;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load products");
    renderCatalog(data.products);
    renderImages(data.products);
  } catch (error) {
    catalogList.innerHTML = `<p class="status-line">${error.message}</p>`;
    imagesList.innerHTML = `<p class="status-line">${error.message}</p>`;
  }
}

catalogList.addEventListener("click", async (event) => {
  const toggleBtn = event.target.closest("[data-toggle]");
  if (toggleBtn) {
    const row = toggleBtn.closest(".catalog-row");
    const id = toggleBtn.dataset.toggle;
    const currentlyEnabled = toggleBtn.dataset.enabled === "true";
    const nextEnabled = !currentlyEnabled;
    toggleBtn.disabled = true;
    const originalText = toggleBtn.textContent;
    toggleBtn.textContent = nextEnabled ? "Showing..." : "Hiding...";
    try {
      const response = await fetch("/api/admin/products", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled: nextEnabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update");
      const isEnabled = data.product.enabled !== false;
      toggleBtn.dataset.enabled = String(isEnabled);
      toggleBtn.textContent = isEnabled ? "Hide from site" : "Show on site";
      const tag = row.querySelector("[data-visibility-tag]");
      if (tag) {
        tag.className = `stock-tag ${isEnabled ? "in" : "out"}`;
        tag.textContent = isEnabled ? "Visible" : "Hidden";
      }
    } catch (error) {
      toggleBtn.textContent = originalText;
      alert(error.message);
    } finally {
      toggleBtn.disabled = false;
    }
    return;
  }

  const button = event.target.closest("[data-save]");
  if (!button) return;
  const row = button.closest(".catalog-row");
  const id = button.dataset.save;
  const price = Number(row.querySelector('[data-field="price"]').value);
  const stock = Number(row.querySelector('[data-field="stock"]').value);
  button.disabled = true;
  button.textContent = "Saving...";
  try {
    const response = await fetch("/api/admin/products", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, price, stock }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save");
    button.textContent = "Saved";
    setTimeout(() => {
      button.textContent = "Save";
      button.disabled = false;
    }, 900);
    const tag = row.querySelector(".stock-tag");
    if (tag) {
      tag.className = `stock-tag ${data.product.stock > 0 ? "in" : "out"}`;
      tag.textContent = data.product.stock > 0 ? "Available" : "Out of stock";
    }
  } catch (error) {
    button.textContent = "Retry";
    button.disabled = false;
    alert(error.message);
  }
});

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

// Compress + convert any image upload to WebP in the browser before sending it.
// Keeps quality high (0.85) but typically shrinks photos 5-10x and ensures the
// storefront loads fast even when admins upload huge originals.
async function compressImageToWebP(file, maxDim = 1400, quality = 0.85) {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not decode image"));
    i.src = dataUrl;
  });
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    if (width >= height) {
      height = Math.round((maxDim / width) * height);
      width = maxDim;
    } else {
      width = Math.round((maxDim / height) * width);
      height = maxDim;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  // Try WebP first; fall back to JPEG if browser doesn't support it.
  let out = canvas.toDataURL("image/webp", quality);
  if (!out.startsWith("data:image/webp")) {
    out = canvas.toDataURL("image/jpeg", quality);
  }
  return out;
}

imagesList.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-upload]");
  if (!input || !input.files || !input.files[0]) return;
  const id = input.dataset.upload;
  const side = input.dataset.side === "back" ? "back" : "front";
  const file = input.files[0];
  if (file.size > 20_000_000) {
    alert("Image must be under 20 MB before compression");
    input.value = "";
    return;
  }
  const sideEl = input.closest(".image-side");
  const label = input.closest(".upload-label");
  const original = label.firstChild.textContent;
  label.firstChild.textContent = " Compressing...";
  try {
    const dataUrl = await compressImageToWebP(file);
    label.firstChild.textContent = " Uploading...";
    const response = await fetch("/api/admin/products/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, dataUrl, side }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed");
    const newImage = side === "back" ? data.product.image_back : data.product.image;
    sideEl.querySelector("[data-preview]").style.cssText = `background:#111 center/cover url('${newImage}');`;
    label.firstChild.textContent = " Replace";
    if (!sideEl.querySelector("[data-remove-image]")) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "secondary-action";
      removeBtn.type = "button";
      removeBtn.dataset.removeImage = id;
      removeBtn.dataset.side = side;
      removeBtn.textContent = "Remove";
      sideEl.querySelector(".image-side-actions").appendChild(removeBtn);
    }
  } catch (error) {
    alert(error.message);
    label.firstChild.textContent = original;
  } finally {
    input.value = "";
  }
});

imagesList.addEventListener("click", async (event) => {
  const saveText = event.target.closest("[data-save-text]");
  if (saveText) {
    const row = saveText.closest(".image-row");
    const id = saveText.dataset.saveText;
    const name = row.querySelector('[data-field="name"]').value.trim();
    const description = row.querySelector('[data-field="description"]').value.trim();
    if (!name) {
      alert("Name cannot be empty");
      return;
    }
    saveText.disabled = true;
    saveText.textContent = "Saving...";
    try {
      const response = await fetch("/api/admin/products", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name, description }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save");
      saveText.textContent = "Saved";
      setTimeout(() => {
        saveText.textContent = "Save text";
        saveText.disabled = false;
      }, 900);
      const stockRow = catalogList.querySelector(`.catalog-row[data-id="${id}"] .catalog-name strong`);
      if (stockRow) stockRow.textContent = data.product.name;
    } catch (error) {
      saveText.textContent = "Retry";
      saveText.disabled = false;
      alert(error.message);
    }
    return;
  }

  const button = event.target.closest("[data-remove-image]");
  if (!button) return;
  const id = button.dataset.removeImage;
  const side = button.dataset.side === "back" ? "back" : "front";
  if (!confirm(`Remove the ${side} image?`)) return;
  button.disabled = true;
  try {
    const response = await fetch("/api/admin/products/image", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, side }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not remove");
    const sideEl = button.closest(".image-side");
    sideEl.querySelector("[data-preview]").style.cssText = `--skin-bg: linear-gradient(135deg, #1f2937, #111827);`;
    const uploadLabel = sideEl.querySelector(".upload-label");
    if (uploadLabel) uploadLabel.firstChild.textContent = "Upload";
    button.remove();
  } catch (error) {
    button.disabled = false;
    alert(error.message);
  }
});

refreshOrders.addEventListener("click", loadOrders);

ordersList.addEventListener("click", async (event) => {
  const refreshBtn = event.target.closest("[data-refresh-shipping]");
  const sendBtn = event.target.closest("[data-send-shipping]");
  if (!refreshBtn && !sendBtn) return;

  // Make absolutely sure the click never bubbles up into anything that could
  // navigate the page (the user reported it looked like a refresh).
  event.preventDefault();
  event.stopPropagation();

  const button = refreshBtn || sendBtn;
  const id = refreshBtn ? refreshBtn.dataset.refreshShipping : sendBtn.dataset.sendShipping;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = refreshBtn ? "Checking..." : "Sending...";
  setOrderFeedback(id, refreshBtn ? "Asking Shiprocket..." : "Sending email...", "ok");

  try {
    let response;
    if (refreshBtn) {
      response = await fetch("/api/admin/orders/refresh-shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } else {
      const force = sendBtn.textContent.trim().toLowerCase().startsWith("resend");
      response = await fetch("/api/admin/orders/send-shipping-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, force }),
      });
    }
    if (response.status === 401) {
      window.location.href = "./abdurovaisi-login.html";
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Action failed");

    let message = "";
    let tone = "ok";
    if (refreshBtn) {
      if (data.awb_added) {
        message = data.shipping_email_error
          ? `AWB ${data.order?.awb_code || ""} synced. Shipping email failed: ${data.shipping_email_error}`
          : `AWB ${data.order?.awb_code || ""} synced. Shipping email sent automatically.`;
        tone = data.shipping_email_error ? "error" : "ok";
      } else if (data.order?.awb_code) {
        message = `Shiprocket synced. AWB ${data.order.awb_code} (no change).`;
      } else {
        message = "Shiprocket synced. No AWB assigned yet — try again later.";
      }
    } else if (data.email?.skipped) {
      message = "Shipping email already sent. Click Resend to send another copy.";
    } else if (data.email?.status === "demo_not_sent" || data.email?.status === "missing_recipient") {
      message = `Email not sent (${data.email.status}). Check your email provider settings.`;
      tone = "error";
    } else {
      message = "Shipping email sent.";
    }

    // Patch only this one order in the local list and re-render. The pending
    // feedback survives the re-render via _pendingFeedback.
    setOrderFeedback(id, message, tone);
    if (data.order) patchOrderInList(data.order);
  } catch (error) {
    setOrderFeedback(id, error.message || "Action failed", "error");
    button.disabled = false;
    button.textContent = originalText;
  }
});

document.querySelector("#orderFilters")?.addEventListener("click", (event) => {
  const button = event.target.closest(".order-filter");
  if (!button) return;
  _orderFilter = button.dataset.filter || "all";
  document.querySelectorAll("#orderFilters .order-filter").forEach((b) => {
    b.classList.toggle("active", b === button);
  });
  renderOrders(_allOrders);
});

let _shippingLoaded = false;
let _cachedProducts = [];

async function loadShippingSettings(force) {
  if (_shippingLoaded && !force) return;
  shippingSettings.innerHTML = `<p class="muted">Loading site settings...</p>`;
  try {
    const [settingsRes, productsRes] = await Promise.all([
      fetch("/api/admin/settings"),
      fetch("/api/admin/products"),
    ]);
    if (settingsRes.status === 401 || productsRes.status === 401) {
      window.location.href = "./abdurovaisi-login.html";
      return;
    }
    const settingsData = await settingsRes.json();
    if (!settingsRes.ok) throw new Error(settingsData.error || "Could not load settings");
    const productsData = await productsRes.json();
    if (!productsRes.ok) throw new Error(productsData.error || "Could not load products");
    _cachedProducts = productsData.products || [];
    renderShippingSettings(settingsData.settings || {}, _cachedProducts);
    _shippingLoaded = true;
  } catch (error) {
    shippingSettings.innerHTML = `<p class="status-line">${error.message}</p>`;
  }
}

function renderShippingSettings(settings, productsForPicker) {
  const flat = Number.isFinite(Number(settings.shippingFlat)) ? Number(settings.shippingFlat) : 49;
  const featuredId = typeof settings.featuredProductId === "string" ? settings.featuredProductId : "";
  const items = Array.isArray(productsForPicker) ? productsForPicker : [];
  const options = [
    `<option value="">First visible product (default)</option>`,
    ...items.map((p) => {
      const safeName = String(p.name || p.id).replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const hidden = p.enabled === false ? " (hidden)" : "";
      const noImg = !p.image && !p.image_back ? " — no image yet" : "";
      const selected = p.id === featuredId ? " selected" : "";
      return `<option value="${p.id}"${selected}>${safeName}${hidden}${noImg}</option>`;
    }),
  ].join("");

  shippingSettings.innerHTML = `
    <div class="catalog-row" data-featured-row>
      <div class="catalog-name">
        <strong>Featured hero product</strong>
        <span class="muted">Decides which card appears in the homepage hero. Defaults to the first visible product if not set.</span>
      </div>
      <div>
        <label>Product</label>
        <select id="featuredProductSelect">${options}</select>
      </div>
      <button class="secondary-action" type="button" id="saveFeaturedBtn">Save</button>
    </div>
    <div class="catalog-row" data-shipping-row>
      <div class="catalog-name">
        <strong>Flat shipping</strong>
        <span class="muted">Applied to every order under Rs 495.</span>
      </div>
      <div>
        <label>Rate (Rs)</label>
        <input type="number" min="0" step="1" id="shippingFlatInput" value="${flat}" />
      </div>
      <button class="secondary-action" type="button" id="saveShippingBtn">Save</button>
    </div>
    <p class="status-line" id="shippingStatus"></p>
  `;
}

shippingSettings.addEventListener("click", async (event) => {
  const shippingBtn = event.target.closest("#saveShippingBtn");
  const featuredBtn = event.target.closest("#saveFeaturedBtn");
  if (!shippingBtn && !featuredBtn) return;
  const status = document.querySelector("#shippingStatus");
  status.textContent = "";

  if (shippingBtn) {
    const input = document.querySelector("#shippingFlatInput");
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0) {
      status.textContent = "Enter a valid amount.";
      return;
    }
    shippingBtn.disabled = true;
    shippingBtn.textContent = "Saving...";
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingFlat: value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save");
      shippingBtn.textContent = "Saved";
      status.textContent = `Flat shipping is now ${formatCurrency(data.settings.shippingFlat)}.`;
      setTimeout(() => {
        shippingBtn.textContent = "Save";
        shippingBtn.disabled = false;
      }, 900);
    } catch (error) {
      status.textContent = error.message;
      shippingBtn.textContent = "Retry";
      shippingBtn.disabled = false;
    }
    return;
  }

  if (featuredBtn) {
    const select = document.querySelector("#featuredProductSelect");
    const value = select ? select.value : "";
    featuredBtn.disabled = true;
    featuredBtn.textContent = "Saving...";
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featuredProductId: value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save");
      featuredBtn.textContent = "Saved";
      const chosen = (_cachedProducts || []).find((p) => p.id === value);
      status.textContent = chosen
        ? `Hero now features "${chosen.name || chosen.id}".`
        : "Hero now uses the first visible product.";
      setTimeout(() => {
        featuredBtn.textContent = "Save";
        featuredBtn.disabled = false;
      }, 900);
    } catch (error) {
      status.textContent = error.message;
      featuredBtn.textContent = "Retry";
      featuredBtn.disabled = false;
    }
  }
});

// Boot: verify session before revealing dashboard. If unauthenticated,
// redirect to the login page WITHOUT flashing the dashboard contents.
async function bootAdmin() {
  try {
    const response = await fetch("/api/admin/products");
    if (response.status === 401) {
      window.location.replace("./abdurovaisi-login.html");
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Could not load products");
    }
    const data = await response.json();
    renderCatalog(data.products);
    renderImages(data.products);
    document.body.classList.add("is-loaded");
    loadOrders();
  } catch (error) {
    catalogList.innerHTML = `<p class="status-line">${error.message}</p>`;
    imagesList.innerHTML = `<p class="status-line">${error.message}</p>`;
    document.body.classList.add("is-loaded");
  }
}
bootAdmin();
// Failsafe so the loader never sticks if something explodes
setTimeout(() => document.body.classList.add("is-loaded"), 4000);
