// Postmark. The page logic. The fence rule lives in fence.mjs and is only called from here.
import { CARDS, HERE, unlock, distanceTo } from "./fence.mjs";
import { postcardLines, formatDate, formatTime, formatCoords, formatNumber } from "./postcard.mjs";

const $ = (id) => document.getElementById(id);

const els = {
  geoStatus: $("geo-status"),
  cards: $("cards"),
  camera: $("camera"),
  cameraTitle: $("camera-title"),
  cameraStatus: $("camera-status"),
  video: $("video"),
  shutter: $("shutter"),
  closeCamera: $("close-camera"),
  result: $("result"),
  image: $("postcard-image"),
  send: $("send"),
  backForm: $("back-form"),
  backLine: $("back-line"),
  discard: $("discard"),
  resultStatus: $("result-status"),
  saved: $("saved"),
  savedEmpty: $("saved-empty"),
};

const state = {
  position: null, // { lat, lng, accuracy }
  geoAvailable: "geolocation" in navigator,
  activeCard: null,
  stream: null,
  postcard: null, // { card, number, date, coords, blob, url }
  savedUrls: [],
};

// The page's own link, printed on every postmark.
const PAGE_LINK = (() => {
  const u = new URL(location.href);
  u.hash = "";
  u.search = "";
  return u.href.replace(/index\.html$/, "");
})();

/* ---------- Cards ---------- */

function isOpen(card) {
  return unlock(card, state.position);
}

function distanceLabel(card) {
  if (card.anywhere) return "Opens anywhere";
  if (!state.position) return state.geoAvailable ? "Finding position" : "Position not known";
  const d = Math.round(distanceTo(card, state.position));
  const shown = d >= 10000 ? `${(d / 1000).toFixed(0)} km` : `${d.toLocaleString("en-GB")} m`;
  return isOpen(card) ? `Open, ${shown} away` : `${shown} away`;
}

function renderCards() {
  const frag = document.createDocumentFragment();
  for (const card of CARDS) {
    const open = isOpen(card);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "card";
    btn.dataset.name = card.name;
    btn.dataset.open = String(open);
    btn.setAttribute("aria-disabled", String(!open));
    const num = card.anywhere ? "Here" : formatNumber(card.number);
    const dist = distanceLabel(card);
    btn.setAttribute(
      "aria-label",
      `${card.name}. ${card.anywhere ? "The Here card." : num + "."} ${dist}. ${open ? "Open the camera." : "Closed. Stand within 150 metres to open it."}`
    );
    btn.innerHTML = `<span class="num"></span><span class="name"></span><span class="dist"></span>`;
    btn.querySelector(".num").textContent = num;
    btn.querySelector(".name").textContent = card.name;
    btn.querySelector(".dist").textContent = dist;
    li.append(btn);
    frag.append(li);
  }
  els.cards.replaceChildren(frag);
}

els.cards.addEventListener("click", (event) => {
  const btn = event.target.closest("button.card");
  if (!btn) return;
  const card = CARDS.find((c) => c.name === btn.dataset.name);
  if (!card) return;
  if (!isOpen(card)) {
    els.geoStatus.textContent = `${card.name} is closed. Stand within 150 metres of it to open it.`;
    return;
  }
  openCamera(card);
});

/* ---------- Position ---------- */

function startGeolocation() {
  if (!state.geoAvailable) {
    els.geoStatus.textContent = "This browser does not share a position. Only the Here card can open.";
    renderCards();
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => {
      state.position = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      const acc = Math.round(pos.coords.accuracy);
      els.geoStatus.textContent = `Position found, to within ${acc} m.`;
      renderCards();
      updateShutter();
    },
    (err) => {
      state.position = null;
      els.geoStatus.textContent =
        err.code === err.PERMISSION_DENIED
          ? "Position is off. Only the Here card can open. Allow location to open the landmarks."
          : "Position is not available right now. Only the Here card can open.";
      renderCards();
      updateShutter();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

/* ---------- Camera ---------- */

function cameraReady() {
  return Boolean(state.stream) && els.video.readyState >= 2 && els.video.videoWidth > 0;
}

function updateShutter() {
  const card = state.activeCard;
  if (!card) {
    els.shutter.disabled = true;
    return;
  }
  const open = isOpen(card);
  els.shutter.disabled = !(open && cameraReady());
  if (!open) {
    els.cameraStatus.textContent = `You are outside the ${card.name} fence. The shutter opens within 150 metres.`;
  } else if (!cameraReady()) {
    els.cameraStatus.textContent = state.stream ? "Starting the camera." : els.cameraStatus.textContent;
  } else {
    els.cameraStatus.textContent = `You are at ${card.name}. The shutter is open.`;
  }
}

async function openCamera(card) {
  stopCamera();
  state.activeCard = card;
  els.cameraTitle.textContent = `Camera: ${card.name}`;
  els.camera.hidden = false;
  els.cameraStatus.textContent = "Asking for the camera.";
  updateShutter();
  els.camera.scrollIntoView({ block: "start" });

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    els.cameraStatus.textContent = "This browser has no live camera here. The page needs a secure address (https or localhost).";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1440 },
      },
    });
    if (state.activeCard !== card) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    state.stream = stream;
    els.video.srcObject = stream;
    await els.video.play().catch(() => {});
    updateShutter();
    els.shutter.focus();
  } catch (err) {
    els.cameraStatus.textContent =
      err && err.name === "NotAllowedError"
        ? "The camera is off. Allow the camera to take the photo."
        : "The camera could not start.";
    updateShutter();
  }
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  els.video.srcObject = null;
}

function closeCamera() {
  stopCamera();
  state.activeCard = null;
  els.camera.hidden = true;
  updateShutter();
}

els.video.addEventListener("loadeddata", updateShutter);
els.video.addEventListener("playing", updateShutter);
els.closeCamera.addEventListener("click", closeCamera);

els.shutter.addEventListener("click", async () => {
  const card = state.activeCard;
  if (!card || !isOpen(card) || !cameraReady()) {
    updateShutter();
    return;
  }
  els.shutter.disabled = true;
  const date = new Date();
  const coords = state.position ? { lat: state.position.lat, lng: state.position.lng } : null;
  const number = card.anywhere ? await hereNumber() : card.number;
  const frame = grabFrame(els.video);
  closeCamera();
  try {
    const blob = await composePostcard(frame, card, number, date, coords);
    showPostcard({ card, number, date, coords, blob });
  } catch {
    els.geoStatus.textContent = "The postcard could not be made. Try again.";
  }
});

// The Here card is not one of the ten, so its number counts the landmarks collected so far.
async function hereNumber() {
  try {
    const all = await dbAll();
    const names = new Set(all.filter((c) => c.name !== HERE.name).map((c) => c.name));
    return Math.max(1, Math.min(10, names.size));
  } catch {
    return 1;
  }
}

function grabFrame(video) {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  return c;
}

/* ---------- Postcard composition ---------- */

// One warm paper design. These are print colours for the postcard image, not page colours.
const PAPER = {
  sheet: "#f3e9d6",
  edge: "#e6d6b8",
  ink: "#2b2118",
  stamp: "rgba(140, 40, 32, 0.86)",
};

function fontStack(kind) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(kind).trim();
  return v || (kind === "--font-mono" ? "ui-monospace, Menlo, monospace" : "Helvetica, Arial, sans-serif");
}

function fitText(ctx, text, maxWidth, size, family, weight = "") {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`.trim();
  while (s > 10 && ctx.measureText(text).width > maxWidth) {
    s -= 1;
    ctx.font = `${weight} ${s}px ${family}`.trim();
  }
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

function arcText(ctx, text, cx, cy, r, centreAngle, top) {
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0);
  let angle = centreAngle - (top ? 1 : -1) * (total / r) / 2;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  chars.forEach((ch, i) => {
    const half = widths[i] / 2 / r;
    angle += top ? half : -half;
    ctx.save();
    ctx.translate(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    ctx.rotate(angle + (top ? Math.PI / 2 : -Math.PI / 2));
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    angle += top ? half : -half;
  });
  ctx.restore();
}

function drawPostmark(ctx, cx, cy, r, card, number, date, coords) {
  const mono = fontStack("--font-mono");
  const sans = fontStack("--font-sans");
  ctx.save();
  ctx.strokeStyle = PAPER.stamp;
  ctx.fillStyle = PAPER.stamp;

  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();

  const ring = r * 0.86;
  ctx.font = `700 ${Math.round(r * 0.13)}px ${sans}`;
  let name = card.name.toUpperCase();
  while (name.length > 3 && ctx.measureText(name).width > Math.PI * ring * 0.9) name = name.slice(0, -1);
  arcText(ctx, name, cx, cy, ring, -Math.PI / 2, true);
  ctx.font = `600 ${Math.round(r * 0.11)}px ${mono}`;
  arcText(ctx, formatNumber(number).toUpperCase(), cx, cy, ring, Math.PI / 2, false);

  const inner = r * 0.72 * 2 * 0.9;
  const lh = r * 0.135;
  const lines = [
    { t: formatDate(date), size: r * 0.12, f: mono, w: "700" },
    { t: formatTime(date), size: r * 0.12, f: mono, w: "700" },
    { t: formatCoords(coords).split(", ")[0] || "", size: r * 0.085, f: mono, w: "" },
    { t: formatCoords(coords).split(", ")[1] || "", size: r * 0.085, f: mono, w: "" },
    { t: "Collect your own at", size: r * 0.075, f: sans, w: "" },
    { t: PAGE_LINK, size: r * 0.07, f: mono, w: "" },
  ];
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const startY = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => {
    const y = startY + i * lh;
    const halfChord = Math.sqrt(Math.max(0, (r * 0.7) ** 2 - (y - cy) ** 2));
    const t = fitText(ctx, l.t, Math.min(inner, halfChord * 2 * 0.94), Math.round(l.size), l.f, l.w);
    ctx.fillText(t, cx, y);
  });
  ctx.restore();
}

async function composePostcard(frame, card, number, date, coords) {
  const W = 1800;
  const H = 1200;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");

  ctx.fillStyle = PAPER.sheet;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = PAPER.edge;
  ctx.lineWidth = 6;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  // The photo, cropped to fill its window.
  const px = 70, py = 70, pw = W - 140, ph = H - 300;
  const scale = Math.max(pw / frame.width, ph / frame.height);
  const sw = pw / scale, sh = ph / scale;
  const sx = (frame.width - sw) / 2, sy = (frame.height - sh) / 2;
  ctx.drawImage(frame, sx, sy, sw, sh, px, py, pw, ph);
  ctx.strokeStyle = PAPER.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, pw, ph);

  // The landmark name, set in type.
  const sans = fontStack("--font-sans");
  const mono = fontStack("--font-mono");
  ctx.fillStyle = PAPER.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const title = fitText(ctx, card.name, W - 140 - 520, 96, sans, "700");
  ctx.fillText(title, px, H - 110);
  ctx.font = `500 30px ${mono}`;
  ctx.fillText(`LONDON  ·  ${formatNumber(number).toUpperCase()}`, px, H - 62);

  // The round postmark, overlapping the photo's lower right corner.
  drawPostmark(ctx, W - 300, H - 290, 220, card, number, date, coords);

  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
  );
}

/* ---------- Result: share, back line, save ---------- */

function fileName(card, date) {
  const slug = card.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `postmark-${slug}-${formatDate(date)}.png`;
}

function showPostcard(pc) {
  if (state.postcard && state.postcard.url) URL.revokeObjectURL(state.postcard.url);
  pc.url = URL.createObjectURL(pc.blob);
  state.postcard = pc;
  els.image.src = pc.url;
  els.image.alt = `Postcard of ${pc.card.name}. ${postcardLines(pc.card.name, pc.number, pc.date, pc.coords).join(", ")}.`;
  const file = new File([pc.blob], fileName(pc.card, pc.date), { type: "image/png" });
  const canShare = navigator.canShare && navigator.share && navigator.canShare({ files: [file] });
  els.send.textContent = canShare ? "Share postcard" : "Download postcard";
  els.backLine.value = "";
  els.resultStatus.textContent = "";
  els.result.hidden = false;
  els.result.scrollIntoView({ block: "start" });
  els.send.focus();
}

els.send.addEventListener("click", async () => {
  const pc = state.postcard;
  if (!pc) return;
  const file = new File([pc.blob], fileName(pc.card, pc.date), { type: "image/png" });
  if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: `Postmark: ${pc.card.name}`,
        text: `${pc.card.name}, ${formatNumber(pc.number)}. Collect your own at ${PAGE_LINK}`,
      });
      els.resultStatus.textContent = "Shared.";
    } catch (err) {
      if (!err || err.name !== "AbortError") els.resultStatus.textContent = "Sharing did not finish.";
    }
    return;
  }
  const a = document.createElement("a");
  a.href = pc.url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  els.resultStatus.textContent = "The postcard image is downloading.";
});

els.backForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pc = state.postcard;
  if (!pc) return;
  const line = els.backLine.value.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  try {
    await dbAdd({
      name: pc.card.name,
      number: pc.number,
      date: pc.date.toISOString(),
      coords: pc.coords,
      line,
      blob: pc.blob,
    });
    els.resultStatus.textContent = "Saved on this device.";
    clearResult();
    await renderSaved();
  } catch {
    els.resultStatus.textContent = "The card could not be saved on this device.";
  }
});

function clearResult() {
  if (state.postcard && state.postcard.url) URL.revokeObjectURL(state.postcard.url);
  state.postcard = null;
  els.image.removeAttribute("src");
  els.result.hidden = true;
}

els.discard.addEventListener("click", clearResult);

/* ---------- IndexedDB ---------- */

const DB_NAME = "postmark";
const STORE = "cards";
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("no indexedDB"));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const dbAdd = (record) => tx("readwrite", (s) => s.add(record));
const dbAll = () => tx("readonly", (s) => s.getAll());

async function renderSaved() {
  state.savedUrls.forEach((u) => URL.revokeObjectURL(u));
  state.savedUrls = [];
  let all = [];
  try {
    all = await dbAll();
  } catch {
    els.savedEmpty.textContent = "Saved cards are not available in this browser.";
    els.savedEmpty.hidden = false;
    return;
  }
  all.sort((a, b) => (a.date < b.date ? 1 : -1));
  els.savedEmpty.hidden = all.length > 0;
  const frag = document.createDocumentFragment();
  for (const rec of all) {
    const li = document.createElement("li");
    const img = document.createElement("img");
    const url = URL.createObjectURL(rec.blob);
    state.savedUrls.push(url);
    img.src = url;
    img.alt = "";
    img.width = 72;
    const when = new Date(rec.date);
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("strong");
    name.textContent = rec.name;
    const date = document.createElement("span");
    date.textContent = `${formatDate(when)} ${formatTime(when)}`;
    meta.append(name, date);
    if (rec.line) {
      const back = document.createElement("span");
      back.textContent = rec.line;
      meta.append(back);
    }
    li.append(img, meta);
    frag.append(li);
  }
  els.saved.replaceChildren(frag);
}

/* ---------- Start ---------- */

renderCards();
startGeolocation();
renderSaved();
