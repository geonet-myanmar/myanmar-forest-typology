// Boot: metadata, map, modules, tabs, theme, and restoring the last view.
import {api} from "./api.js";
import {$, $$, toast, store} from "./util.js";
import {S, on, emit, readHash, writeHash} from "./state.js";
import {setBasemap, setLabels, setDim, setForTyVisible, onTheme, refreshLayer} from "./map.js";
import {setAoi} from "./aoi.js";
import {initAdmin, useAdmin, setAdminOutline} from "./aoi-admin.js";
import {initDraw} from "./aoi-draw.js";
import {initUpload} from "./aoi-upload.js";
import {initMapTab} from "./maplayer.js";
import {initAnalyze} from "./analyze.js";
import {saveMapImage} from "./export.js";
import {renderAbout} from "./about.js";

/* ---------- theme ---------- */
const THEMES = ["auto", "light", "dark"];
function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  const b = $("#themebtn");
  b.textContent = t === "dark" ? "☾" : t === "light" ? "☀" : "◐";
  b.title = `Theme: ${t === "auto" ? "follow system" : t}`;
  store.set("theme", t);
  onTheme();
}
$("#themebtn").addEventListener("click", () => {
  const cur = store.get("theme", "auto");
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);

/* ---------- tabs ---------- */
const tabs = $$("#tabs button");
let prevTab = null;
export function openTab(name) {
  if (!tabs.some(b => b.dataset.tab === name)) name = "area";
  S.tab = name;
  tabs.forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
  $$(".tab").forEach(t => { t.hidden = t.id !== "tab-" + name; });
  if (S.tab !== prevTab) $(".tabbody").scrollTop = 0;     // each tab opens at its top, not the last tab's scroll
  prevTab = S.tab;
  writeHash();
  emit("tab", name);
}
tabs.forEach((b, i) => {
  b.addEventListener("click", () => openTab(b.dataset.tab));
  b.addEventListener("keydown", e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    n.focus();
    openTab(n.dataset.tab);
  });
});
on("tab", t => { if (t !== S.tab) openTab(t); });

/* ---------- area mode switch ---------- */
$$("#aoimode button").forEach(b => b.addEventListener("click", () => {
  $$("#aoimode button").forEach(x => x.setAttribute("aria-pressed", x === b));
  for (const m of ["admin", "draw", "upload"]) $("#mode-" + m).hidden = m !== b.dataset.mode;
}));

/* Tabs that need an area show a hint until one is chosen; a newly chosen area opens Analyze. */
let booting = true;
on("aoi", a => {
  $$("[data-needaoi]").forEach(e => { e.hidden = !!a; });
  $$("[data-hasaoi]").forEach(e => { e.hidden = !a; });
  if (a && !booting && S.tab === "area") openTab("analyze");
});

/* ---------- layer panel ---------- */
function wireLayers() {
  const bm = $("#basemap");
  bm.value = store.get("basemap", "imagery");
  setBasemap(bm.value);
  bm.addEventListener("change", () => { setBasemap(bm.value); store.set("basemap", bm.value); });
  const chk = (id, fn, def) => {
    const el = $(id);
    el.checked = store.get(id, def);
    fn(el.checked);
    el.addEventListener("change", () => { fn(el.checked); store.set(id, el.checked); });
  };
  chk("#ly-forty", setForTyVisible, true);
  chk("#ly-labels", setLabels, true);
  chk("#ly-admin", setAdminOutline, false);
  chk("#ly-dim", setDim, true);
  if (innerWidth < 700) $("#layers").open = false;
}

/* ---------- boot ---------- */
async function boot() {
  applyTheme(store.get("theme", "auto"));
  try {
    S.meta = await api("meta");
  } catch (e) {
    toast(e.message, "err", 0);
    return;
  }
  const h = readHash();
  await initAdmin();
  wireLayers();
  initDraw();
  initUpload();
  initMapTab(h);
  initAnalyze();
  $("#img-save").addEventListener("click", saveMapImage);
  renderAbout();
  refreshLayer();
  try {
    if (h.aoi) await useAdmin(h.aoi);
    else {
      const c = store.get("customAoi");
      if (c?.spec) await setAoi(c.spec, {source: c.source});
    }
  } catch { /* the toast explains */ }
  openTab(h.tab || "area");
  if (!S.aoi) emit("aoi", null);
  booting = false;
}
boot();
addEventListener("hashchange", () => {
  const h = readHash();
  if (h.tab && h.tab !== S.tab) openTab(h.tab);
});
