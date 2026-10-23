// The Leaflet map: basemaps, the Earth Engine ForTy layer, the AOI outline + outside mask, the breakdown
// choropleth, legends, and map clicks.
import {api} from "./api.js";
import {$, esc, fmt, toast} from "./util.js";
import {S, on, emit} from "./state.js";

export const isDark = () => {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

export const map = L.map("map", {zoomSnap: 0.5, zoomDelta: 0.5, minZoom: 4, maxZoom: 19, attributionControl: true})
  .setView([19.4, 96.3], 6);
for (const [name, z] of [["base", 150], ["ft", 250], ["choro", 330], ["adm", 410], ["aoi", 420], ["lab", 450]]) {
  map.createPane(name).style.zIndex = z;
}
map.getPane("lab").style.pointerEvents = "none";
map.attributionControl.setPrefix(false);
map.attributionControl.getContainer().addEventListener("click", e => {
  if (e.target.tagName !== "A") e.currentTarget.classList.toggle("open");
});
L.control.scale({imperial: false, position: "bottomleft"}).addTo(map);

/* ---------- basemaps & labels (Esri: keyless; CARTO now watermarks tiles without an API key) ---------- */
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/{svc}/MapServer/tile/{z}/{y}/{x}";
const CANVAS_ATTR = "Basemap: Esri, HERE, Garmin, © OpenStreetMap contributors";
const BASES = {
  imagery: () => L.tileLayer(ESRI, {svc: "World_Imagery", pane: "base", maxZoom: 19, attribution: "Basemap: Esri, Maxar, Earthstar Geographics"}),
  light: () => L.tileLayer(ESRI, {svc: "Canvas/World_Light_Gray_Base", pane: "base", maxNativeZoom: 16, maxZoom: 19, attribution: CANVAS_ATTR}),
  dark: () => L.tileLayer(ESRI, {svc: "Canvas/World_Dark_Gray_Base", pane: "base", maxNativeZoom: 16, maxZoom: 19, attribution: CANVAS_ATTR}),
};
let base = null, labels = null;
export function setBasemap(name) {
  base?.remove();
  base = BASES[name] ? BASES[name]().addTo(map) : null;
}
export function setLabels(onoff) {
  labels?.remove();
  labels = onoff ? L.tileLayer(ESRI, {svc: "Reference/World_Boundaries_and_Places", pane: "lab", maxZoom: 19,
    attribution: "Labels: Esri"}).addTo(map) : null;
}

/* ---------- the ForTy layer ---------- */
const FT_ATTR = 'Forest types: <a href="https://developers.google.com/earth-engine/datasets/catalog/projects_nature-trace_assets_forest_typology_forest_typology_2020_v1_0_collection">ForTy 2020 v1.0 (Google)</a>, CC BY 4.0';
let ftLayer = null, ftVisible = true, ftToken = 0, lastSpec = null;

/* The spec the API turns into an Earth Engine layer, from the Map tab's state. */
export function layerSpec() {
  const clip = S.clip && S.aoi ? {clip: true} : {};
  if (S.layer === "score") return {type: "score", target: S.scoreTarget, min: S.scoreMin, ...clip};
  if (S.layer === "confidence") return {type: "confidence", measure: S.confMeasure, ...clip};
  return {type: "class", palette: S.palette, classes: S.classes, threshold: S.threshold, uncertain: S.uncertain, ...clip};
}

export async function refreshLayer(force = false) {
  const spec = layerSpec();
  const key = JSON.stringify(spec) + (spec.clip ? S.aoi.info.key || S.aoi.spec.pcode : "");
  if (!force && key === lastSpec && ftLayer) { ftLayer.setOpacity(ftVisible ? S.opacity : 0); return; }
  lastSpec = key;
  const token = ++ftToken;
  let r;
  try {
    r = await api("layer", {layer: spec, aoi: spec.clip ? S.aoi.spec : undefined});
  } catch (e) {
    toast(e.message, "err", 8000);
    return;
  }
  if (token !== ftToken) return;
  const old = ftLayer;
  ftLayer = L.tileLayer(r.url, {pane: "ft", maxZoom: 19, maxNativeZoom: 18, attribution: FT_ATTR, opacity: 0, keepBuffer: 3});
  let last = 0;
  ftLayer.on("tileerror", () => {          // expired map ID: fetch a fresh one, at most once a minute
    if (Date.now() - last < 60e3) return;
    last = Date.now();
    refreshLayer(true);
  });
  const reveal = () => {
    if (ftLayer._shown) return;
    ftLayer._shown = true;
    ftLayer.setOpacity(ftVisible ? S.opacity : 0);
    if (old) { old.setOpacity(0); setTimeout(() => map.removeLayer(old), 300); }
  };
  ftLayer.once("load", reveal);
  setTimeout(reveal, 1500);
  ftLayer.addTo(map);
  renderLegend(r.legend);
  emit("layer", r.legend);
}

export function setForTyVisible(v) {
  ftVisible = v;
  ftLayer?.setOpacity(v ? S.opacity : 0);
  $("#legend").hidden = !v || !$("#legend").innerHTML;
}
export function setOpacity(o) {
  S.opacity = o;
  ftLayer?.setOpacity(ftVisible ? o : 0);
}

function renderLegend(lg) {
  const el = $("#legend");
  if (!lg) { el.hidden = true; el.innerHTML = ""; return; }
  let h = `<b>${esc(lg.title)}</b>`;
  if (lg.kind === "categorical") {
    h += lg.items.map(([c, n]) => `<div class="row"><span class="sw" style="background:${c}"></span>${esc(n)}</div>`).join("");
  } else {
    h += `<div class="ramp" style="background:linear-gradient(90deg,${lg.colors.join(",")})"></div>
      <div class="ends"><span>${fmt(lg.min, 2)}${lg.low ? " " + esc(lg.low) : ""}</span><span>${fmt(lg.max, 2)}${lg.high ? " " + esc(lg.high) : ""}</span></div>`;
  }
  if (lg.masked) h += `<div class="note">Transparent: ${esc(lg.masked)}</div>`;
  el.innerHTML = h;
  el.hidden = !ftVisible;
}

/* ---------- AOI outline and outside mask ---------- */
let aoiGroup = null, dimOn = true, aoiGeo = null;
export function setAoiShape(geojson, fit = true) {
  aoiGroup?.remove();
  aoiGroup = null;
  aoiGeo = geojson;
  if (!geojson) return;
  aoiGroup = L.layerGroup().addTo(map);
  const polys = [];
  turf.flattenEach(geojson, f => { if (f.geometry?.type === "Polygon") polys.push(f.geometry.coordinates); });
  if (dimOn) {
    const world = [[-89, -360], [-89, 360], [89, 360], [89, -360]];
    const holes = polys.map(p => p[0].map(([x, y]) => [y, x]));
    L.polygon([world, ...holes], {pane: "aoi", stroke: false, fillColor: "#0b0f0d", fillOpacity: 0.45, interactive: false}).addTo(aoiGroup);
  }
  const style = [{color: "#0b0f0d", weight: 4.5, opacity: 0.55}, {color: "#ffffff", weight: 2, opacity: 0.95}];
  for (const st of style) L.geoJSON(geojson, {pane: "aoi", interactive: false, style: {...st, fill: false}}).addTo(aoiGroup);
  if (fit) map.fitBounds(L.geoJSON(geojson).getBounds(), {padding: [40, 40], maxZoom: 15});
}
export function setDim(v) { dimOn = v; if (aoiGeo) setAoiShape(aoiGeo, false); }

/* ---------- breakdown choropleth ---------- */
let choro = null;
export function setChoropleth(fc, {color, tip, onClick, legend} = {}) {
  choro?.remove();
  choro = null;
  const lg = $("#chorolegend");
  if (!fc) { lg.hidden = true; return; }
  choro = L.geoJSON(fc, {
    pane: "choro",
    style: f => ({color: isDark() ? "#0e1412" : "#ffffff", weight: 0.8, fillColor: color(f), fillOpacity: 0.85}),
    onEachFeature: (f, l) => {
      l.bindTooltip(() => tip(f), {sticky: true});
      l.on("mouseover", () => l.setStyle({weight: 2.2, color: isDark() ? "#eef3ef" : "#15201b"}));
      l.on("mouseout", () => l.setStyle({weight: 0.8, color: isDark() ? "#0e1412" : "#ffffff"}));
      if (onClick) l.on("click", ev => { L.DomEvent.stop(ev); onClick(f); });
    },
  }).addTo(map);
  lg.innerHTML = legend;
  lg.hidden = false;
}

/* ---------- clicks ---------- */
map.on("click", e => emit("map:click", e.latlng));

export function onTheme() {
  if (labels) setLabels(true);
  emit("map:theme");
}
on("aoi", () => { if (S.clip) refreshLayer(); });
