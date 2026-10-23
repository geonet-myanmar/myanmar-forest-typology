// The current area of interest: server validation, summary card, header chip, GeoJSON / KML export.
import {api} from "./api.js";
import {$, esc, fmt, fmtArea, download, slug, toast, store} from "./util.js";
import {S, emit, writeHash} from "./state.js";
import {setAoiShape, map} from "./map.js";

const LEVEL = {0: "Union", 1: "State/Region", 2: "District", 3: "Township"};

/* spec: {kind:"admin", pcode} | {kind:"geojson", geometry, name}; display: GeoJSON for the map. */
export async function setAoi(spec, {display = null, fit = true, source = "", info = null} = {}) {
  if (!info) {
    try {
      info = await api("aoi", {aoi: spec});
    } catch (e) {
      toast(e.message, "err", 8000);
      throw e;
    }
  }
  const geo = display || (info.geometry ? {type: "Feature", properties: {}, geometry: info.geometry} : null);
  const clean = spec.kind === "geojson" ? {...spec, geometry: info.geometry, name: info.name} : spec;
  S.aoi = {spec: clean, info, display: geo, source};
  setAoiShape(geo, fit);
  renderCard();
  renderChip();
  if (spec.kind === "geojson") store.set("customAoi", {spec: clean, source});
  else store.del("customAoi");
  writeHash();
  emit("aoi", S.aoi);
  for (const w of info.warnings || []) toast(w, "", 8000);
  return S.aoi;
}

export function clearAoi() {
  S.aoi = null;
  setAoiShape(null);
  renderCard();
  renderChip();
  writeHash();
  emit("aoi", null);
}

function renderChip() {
  const c = $("#aoichip");
  if (!S.aoi) { c.hidden = true; return; }
  const i = S.aoi.info;
  c.hidden = false;
  c.innerHTML = `${esc(i.name)}${i.name_my ? ` <span class="my">${esc(i.name_my)}</span>` : ""} · ${fmtArea(i.area_km2)}`;
}

function renderCard() {
  const el = $("#aoicard");
  if (!S.aoi) { el.hidden = true; el.innerHTML = ""; return; }
  const i = S.aoi.info, sp = S.aoi.spec;
  const kind = sp.kind === "admin" ? `MIMU ${LEVEL[i.level]} · ${esc(i.pcode)}` : esc(S.aoi.source || "Custom area");
  el.innerHTML = `
    <div class="eyebrow">Area of interest</div>
    <div class="name">${esc(i.name)}${i.name_my ? ` <span class="my">${esc(i.name_my)}</span>` : ""}</div>
    <dl>
      <div><dt>Area</dt><dd>${fmtArea(i.area_km2)}</dd></div>
      <div><dt>Source</dt><dd style="font-weight:500">${kind}</dd></div>
      <div><dt>Vertices</dt><dd>${fmt(i.vertices)}</dd></div>
      ${i.inside_pct < 99.9 ? `<div><dt>Inside Myanmar</dt><dd>${fmt(i.inside_pct, 1)}%</dd></div>` : ""}
    </dl>
    ${(i.warnings || []).map(w => `<div class="warnline">${esc(w)}</div>`).join("")}
    <div class="btnrow">
      <button class="btn" type="button" data-act="zoom">Zoom to</button>
      <button class="btn" type="button" data-act="geojson">GeoJSON</button>
      <button class="btn" type="button" data-act="kml">KML</button>
      <button class="btn" type="button" data-act="clear">Clear</button>
    </div>`;
  el.hidden = false;
  el.querySelector("[data-act=zoom]").onclick = () => setAoiShape(S.aoi.display, true);
  el.querySelector("[data-act=geojson]").onclick = () => exportAoi("geojson");
  el.querySelector("[data-act=kml]").onclick = () => exportAoi("kml");
  el.querySelector("[data-act=clear]").onclick = clearAoi;
}

async function fullGeometry() {
  if (S.aoi.spec.kind === "admin") {   // export the full-resolution MIMU polygon, not the display copy
    const f = await api("admin/" + encodeURIComponent(S.aoi.spec.pcode));
    return f.geometry;
  }
  return S.aoi.spec.geometry;
}

async function exportAoi(kind) {
  const i = S.aoi.info, g = await fullGeometry(), name = slug(i.name);
  const props = {name: i.name, name_my: i.name_my || "", area_km2: i.area_km2, pcode: i.pcode || "",
                 source: S.aoi.spec.kind === "admin" ? "MIMU PCode v9.4" : (S.aoi.source || "custom")};
  if (kind === "geojson") {
    download(JSON.stringify({type: "FeatureCollection", features: [{type: "Feature", properties: props, geometry: g}]}),
             name + ".geojson", "application/geo+json");
    return;
  }
  const ring = r => r.map(([x, y]) => `${+x.toFixed(7)},${+y.toFixed(7)}`).join(" ");
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const pm = polys.map(p => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(p[0])}</coordinates></LinearRing></outerBoundaryIs>` +
    p.slice(1).map(h => `<innerBoundaryIs><LinearRing><coordinates>${ring(h)}</coordinates></LinearRing></innerBoundaryIs>`).join("") + "</Polygon>").join("");
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(i.name)}</name>
<Style id="aoi"><LineStyle><color>ff00b4ff</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
<Placemark><name>${esc(i.name)}</name><description>${esc(props.source)}, ${fmt(i.area_km2, 1)} km2</description><styleUrl>#aoi</styleUrl>
<MultiGeometry>${pm}</MultiGeometry></Placemark></Document></kml>`;
  download(kml, name + ".kml", "application/vnd.google-earth.kml+xml");
}

$("#aoichip").addEventListener("click", () => emit("tab", "area"));

export function aoiBounds() {
  return S.aoi?.display ? L.geoJSON(S.aoi.display).getBounds() : null;
}
export {map};
