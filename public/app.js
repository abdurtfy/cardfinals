const productGrid = document.querySelector("#productGrid");

function syncHeroCard() {
  const hero = document.querySelector("#heroCard");
  if (!hero || !products || !products.length) return;
  const featuredId = window.storeSettings && window.storeSettings.featuredProductId;
  const featured =
    (featuredId && products.find((p) => p.id === featuredId)) || products[0];
  const front = hero.querySelector(".face--front");
  const back = hero.querySelector(".face--back");
  if (!front || !back) return;
  const applyFace = (face, bgImg) => {
    if (bgImg) {
      face.style.cssText = `--skin-image: url('${bgImg}');`;
      face.classList.add("has-image");
    } else {
      face.style.cssText = `--skin-bg: ${featured.bg};`;
      face.classList.remove("has-image");
    }
  };
  applyFace(front, featured.image || "");
  applyFace(back, featured.image_back || featured.image || "");
}

function renderProducts() {
  productGrid.innerHTML = products
    .map((product) => {
      const out = product.stock <= 0;
      const frontStyle = product.image
        ? `--skin-image: url('${product.image}');`
        : `--skin-bg: ${product.bg};`;
      const backImage = product.image_back || product.image;
      const backStyle = backImage
        ? `--skin-image: url('${backImage}');`
        : `--skin-bg: ${product.bg};`;
      const frontClass = product.image ? "face has-image" : "face";
      const backClass = backImage ? "face has-image" : "face";
      const backHasOwnImage = Boolean(product.image_back);
      return `
        <article class="product-card${out ? " out-of-stock" : ""}">
          <div class="product-art">
            <div class="card-3d-wrapper">
              <div class="${frontClass} face--front" style="${frontStyle}"></div>
              <div class="${backClass} face--back${backHasOwnImage ? " face--back-clean" : ""}" style="${backStyle}"></div>
              ${out ? `<span class="stock-badge">Out of stock</span>` : ""}
            </div>
          </div>
          <div class="product-body">
            <h3>${product.name}</h3>
            <p class="product-meta">${product.description ? product.description : `${product.category} card skin · ${product.finish}`}</p>
            <div class="product-footer">
              <span class="price">${formatCurrency(product.price)}</span>
              <button class="add-button" type="button" data-add="${product.id}"${out ? " disabled" : ""}>${out ? "Sold out" : "Add to cart"}</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
  syncHeroCard();
  setup3DPhysics();
}

let cardStates = [];
let physicsRunning = false;

function setup3DPhysics() {
  cardStates = [];
  const wrappers = document.querySelectorAll(".card-3d-wrapper");
  wrappers.forEach((el, i) => {
    const state = {
      el,
      targetX: 0,
      targetY: 0,
      currentX: 0,
      currentY: 0,
      isDragging: false,
      lastMouseX: 0,
      lastMouseY: 0,
      offset: i * 0.7,
    };
    const start = (e) => {
      state.isDragging = true;
      const p = e.touches ? e.touches[0] : e;
      state.lastMouseX = p.clientX;
      state.lastMouseY = p.clientY;
    };
    const move = (e) => {
      if (!state.isDragging) return;
      const p = e.touches ? e.touches[0] : e;
      state.targetY += (p.clientX - state.lastMouseX) * 0.8;
      state.targetX -= (p.clientY - state.lastMouseY) * 0.8;
      state.lastMouseX = p.clientX;
      state.lastMouseY = p.clientY;
    };
    const stop = () => {
      state.isDragging = false;
    };
    el.addEventListener("mousedown", start);
    el.addEventListener("touchstart", start, { passive: true });
    cardStates.push(state);
  });

  if (!physicsRunning) {
    physicsRunning = true;
    window.addEventListener("mousemove", (e) => {
      cardStates.forEach((s) => {
        if (s.isDragging) {
          s.targetY += (e.clientX - s.lastMouseX) * 0.8;
          s.targetX -= (e.clientY - s.lastMouseY) * 0.8;
          s.lastMouseX = e.clientX;
          s.lastMouseY = e.clientY;
        }
      });
    });
    window.addEventListener("touchmove", (e) => {
      const p = e.touches[0];
      if (!p) return;
      cardStates.forEach((s) => {
        if (s.isDragging) {
          s.targetY += (p.clientX - s.lastMouseX) * 0.8;
          s.targetX -= (p.clientY - s.lastMouseY) * 0.8;
          s.lastMouseX = p.clientX;
          s.lastMouseY = p.clientY;
        }
      });
    }, { passive: true });
    const stopAll = () => cardStates.forEach((s) => (s.isDragging = false));
    window.addEventListener("mouseup", stopAll);
    window.addEventListener("touchend", stopAll);

    let globalTime = 0;
    function update() {
      globalTime += 0.015;
      cardStates.forEach((s) => {
        if (!s.isDragging) {
          s.targetX += (Math.sin(globalTime * 2 + s.offset) * 10 - (s.targetX % 360)) * 0.05;
          s.targetY += (Math.cos(globalTime + s.offset) * 15 - (s.targetY % 360)) * 0.05;
        }
        s.currentX += (s.targetX - s.currentX) * 0.1;
        s.currentY += (s.targetY - s.currentY) * 0.1;
        s.el.style.transform = `rotateX(${s.currentX}deg) rotateY(${s.currentY}deg)`;
      });
      requestAnimationFrame(update);
    }
    update();
  }
}

document.addEventListener("products:updated", renderProducts);

// Reveal the page immediately — the hero has its own static gradient so
// there's nothing to wait for. The product grid is rendered server-side from
// `window.__INITIAL_PRODUCTS__`, so on first paint we just need to attach the
// 3D physics and sync the hero card to those existing cards. Live data still
// triggers a re-render via the "products:updated" event below.
document.body.classList.add("is-loaded");

if (products && products.length) {
  syncHeroCard();
  setup3DPhysics();
}

// Scroll fade-ins
const fadeObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        fadeObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
);
document.querySelectorAll("[data-fade]").forEach((el) => fadeObserver.observe(el));
