// Small shared helpers: DOM, formatting, downloads, tooltip, modal, toast, concurrency.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

export function fmt(v, d = 0) {
  if (v == null || Number.isNaN(v)) return "–";
  return Number(v).toLocaleString("en-US", {minimumFractionDigits: d, maximumFractionDigits: d});
}

export function fmtArea(km2) {
  if (km2 == null) return "–";
  if (km2 < 1) return fmt(km2 * 100, 1) + " ha";
  return fmt(km2, km2 < 100 ? 1 : 0) + " km²";
}

export const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function slug(s) {
  return String(s || "area").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "area";
}

export function download(data, name, type = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data], {type});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

/* Per-viewer conveniences only; storage may be unavailable (private window). */
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem("mmft:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mmft:" + k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem("mmft:" + k); } catch { /* ignore */ } },
};

/* Run fn over items with at most n in flight; onEach(result, item, index) as each finishes. */
export async function pool(items, n, fn, onEach, signal) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const i = next++;
      out[i] = await fn(items[i], i);
      onEach?.(out[i], items[i], i);
    }
  }
  await Promise.all(Array.from({length: Math.min(n, items.length)}, worker));
  return out;
}

/* ---- tooltip ---- */
const tip = () => $("#tip");
export function showTip(e, html) { const t = tip(); t.innerHTML = html; t.hidden = false; moveTip(e); }
export function moveTip(e) {
  const t = tip(), x = e.clientX + 14, y = e.clientY + 14;
  t.style.left = Math.min(x, innerWidth - t.offsetWidth - 8) + "px";
  t.style.top = Math.min(y, innerHeight - t.offsetHeight - 8) + "px";
}
export function hideTip() { tip().hidden = true; }
document.addEventListener("mousemove", e => { if (!tip().hidden) moveTip(e); });

/* ---- toast on the map ---- */
let toastTimer;
export function toast(msg, kind = "", ms = 4200) {
  const t = $("#maptoast");
  t.textContent = msg;
  t.className = "maptoast" + (kind ? " " + kind : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---- modal ---- */
export function openModal(html) {
  $("#modalbody").innerHTML = html;
  $("#modal").hidden = false;
  $("#modalclose").focus();
}
export function closeModal() { $("#modal").hidden = true; }
$("#modalclose")?.addEventListener("click", closeModal);
$("#modal")?.addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });

/* Myanmar text: NFC and one spelling of ဦ, so search matches MIMU names. */
export function normMy(s) {
  return String(s || "").normalize("NFC").replace(/ဦ/g, "ဦ").toLowerCase();
}
