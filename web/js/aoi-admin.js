// MIMU administrative units (PCode v9.4): State/Region -> District -> Township cascade, English/Myanmar search,
// picking on the map, and the boundary overlay. Display geometry is the simplified TopoJSON; statistics come from
// the precomputed township atlas (full-resolution polygons, 10 m), so admin areas need no server round trip.
import {$, esc, fmtArea, normMy, debounce} from "./util.js";
import {S, on} from "./state.js";
import {map, isDark} from "./map.js";
import {setAoi} from "./aoi.js";

export const LV = {0: "Union", 1: "State/Region", 2: "District", 3: "Township"};
export const units = {};            // pcode -> GeoJSON feature (properties + level)
export const byLevel = {1: [], 2: [], 3: []};
let myanmar = null;

export async function initAdmin() {
  const topo = await (await fetch("data/admin.topo.json")).json();
  for (const lv of [0, 1, 2, 3]) {
    const fc = topojson.feature(topo, topo.objects["adm" + lv]);
    for (const f of fc.features) {
      f.properties.level = lv;
      f.properties._q = (f.properties.name_en || "").toLowerCase() + " | " + normMy(f.properties.name_my);
      units[f.properties.pcode] = f;
      if (lv) byLevel[lv].push(f);
      else myanmar = f;
    }
  }
  for (const lv of [1, 2, 3]) byLevel[lv].sort((a, b) => a.properties.name_en.localeCompare(b.properties.name_en));
  fill($("#sel-st"), byLevel[1], "Choose a State or Region");
  wire();
}

export const myanmarFeature = () => myanmar;

function label(f) {
  const p = f.properties;
  return `${p.name_en}${p.level === 1 && p.type ? " " + p.type : ""} · ${p.name_my}`;
}

function fill(sel, list, placeholder) {
  sel.innerHTML = `<option value="">${esc(placeholder)}</option>` +
    list.map(f => `<option value="${f.properties.pcode}">${esc(label(f))}</option>`).join("");
}

function selected() {
  return $("#sel-ts").value || $("#sel-dt").value || $("#sel-st").value || "";
}

function syncUse() {
  const p = selected();
  $("#adminuse").disabled = !p;
  $("#adminuse").textContent = p ? `Use ${units[p].properties.name_en} ${LV[units[p].properties.level]}` : "Use this area";
  if (pickLayer) showPick();
}

function setCascade(pcode) {
  const f = units[pcode];
  if (!f) return;
  const p = f.properties;
  const st = p.level === 1 ? p.pcode : p.st_pcode;
  $("#sel-st").value = st;
  onState(false);
  if (p.level >= 2) {
    $("#sel-dt").value = p.level === 2 ? p.pcode : p.dt_pcode;
    onDistrict(false);
  }
  if (p.level === 3) $("#sel-ts").value = p.pcode;
  syncUse();
}

function onState(sync = true) {
  const st = $("#sel-st").value;
  const dts = byLevel[2].filter(f => f.properties.st_pcode === st);
  fill($("#sel-dt"), dts, st ? "Whole State/Region, or choose a District" : "Choose a State/Region first");
  $("#sel-dt").disabled = !st;
  fill($("#sel-ts"), [], "Choose a District first");
  $("#sel-ts").disabled = true;
  if (sync) syncUse();
}

function onDistrict(sync = true) {
  const dt = $("#sel-dt").value;
  const tss = byLevel[3].filter(f => f.properties.dt_pcode === dt);
  fill($("#sel-ts"), tss, dt ? "Whole District, or choose a Township" : "Choose a District first");
  $("#sel-ts").disabled = !dt;
  if (sync) syncUse();
}

/* The same name the server gives an admin AOI, built locally from the TopoJSON properties. */
export function adminInfo(pcode) {
  const p = units[pcode].properties, parent = p.level === 3 ? p.dt : p.st || "";
  return {kind: "admin", key: "adm:" + pcode, pcode, level: p.level, name_my: p.name_my || "", area_km2: p.area_km2,
          name: p.level === 0 ? "Myanmar" : `${p.name_en} ${p.level === 1 ? (p.type || LV[1]) : LV[p.level]}${parent ? ", " + (p.sub || parent) : ""}`,
          bbox: turf.bbox(units[pcode]), inside_pct: 100, vertices: null, warnings: []};
}

export async function useAdmin(pcode, fit = true) {
  const f = units[pcode];
  if (!f) return;
  if (pcode !== "MMR") setCascade(pcode);
  await setAoi({kind: "admin", pcode}, {display: f, fit, source: "MIMU", info: adminInfo(pcode)});
}

function search(q) {
  const ul = $("#adminresults");
  const n = normMy(q.trim());
  if (n.length < 2) { ul.hidden = true; return; }
  const hits = [];
  for (const lv of [3, 2, 1]) for (const f of byLevel[lv]) if (f.properties._q.includes(n)) hits.push(f);
  hits.sort((a, b) => (a.properties._q.startsWith(n) ? 0 : 1) - (b.properties._q.startsWith(n) ? 0 : 1));
  ul.innerHTML = hits.slice(0, 30).map(f => {
    const p = f.properties, parent = p.level === 3 ? `${p.dt}, ${p.sub || p.st}` : p.level === 2 ? (p.sub || p.st) : "";
    return `<li role="option" tabindex="0" data-p="${p.pcode}"><span><b>${esc(p.name_en)}</b> <span class="my">${esc(p.name_my)}</span>
      ${parent ? `<br><span class="note">${esc(parent)}</span>` : ""}</span><span class="lv">${LV[p.level]}<br>${fmtArea(p.area_km2)}</span></li>`;
  }).join("") || `<li>No match</li>`;
  ul.hidden = false;
}

/* ---- boundary overlay and picking ---- */
let outline = null, pickLayer = null;
function outlineStyle(f) {
  const lv = f.properties.level, c = isDark() ? "#e8ece9" : "#15201b";
  return {color: c, weight: lv === 1 ? 2.2 : lv === 2 ? 1.3 : 0.7, opacity: lv === 3 ? 0.55 : 0.8, fill: false};
}
export function setAdminOutline(onoff) {
  outline?.remove();
  outline = null;
  if (!onoff) return;
  const feats = [...byLevel[3], ...byLevel[2], ...byLevel[1]];
  outline = L.geoJSON({type: "FeatureCollection", features: feats}, {pane: "adm", interactive: false, style: outlineStyle}).addTo(map);
}

/* Drill down: States/Regions, then the chosen one's Districts, then that District's Townships. */
function pickSet() {
  const st = $("#sel-st").value, dt = $("#sel-dt").value;
  if (dt) return [3, byLevel[3].filter(f => f.properties.dt_pcode === dt)];
  if (st) return [2, byLevel[2].filter(f => f.properties.st_pcode === st)];
  return [1, byLevel[1]];
}

function showPick() {
  pickLayer?.remove();
  const [lv, feats] = pickSet();
  pickLayer = L.geoJSON({type: "FeatureCollection", features: feats}, {
    pane: "adm",
    style: () => ({color: "#2a78d6", weight: 1.2, fillColor: "#2a78d6", fillOpacity: 0.04}),
    onEachFeature: (f, l) => {
      l.bindTooltip(`<b>${esc(f.properties.name_en)}</b> <span class="my">${esc(f.properties.name_my)}</span><br>${LV[lv]} · ${fmtArea(f.properties.area_km2)}`, {sticky: true});
      l.on("mouseover", () => l.setStyle({fillOpacity: 0.22, weight: 2}));
      l.on("mouseout", () => l.setStyle({fillOpacity: 0.04, weight: 1.2}));
      l.on("click", ev => { L.DomEvent.stop(ev); useAdmin(f.properties.pcode, true); });
    },
  }).addTo(map);
}

function wire() {
  $("#sel-st").addEventListener("change", () => onState());
  $("#sel-dt").addEventListener("change", () => onDistrict());
  $("#sel-ts").addEventListener("change", syncUse);
  $("#adminuse").addEventListener("click", () => useAdmin(selected()));
  $("#adminmm").addEventListener("click", () => useAdmin("MMR"));
  $("#adminsearch").addEventListener("input", debounce(e => search(e.target.value), 120));
  $("#adminresults").addEventListener("click", e => {
    const li = e.target.closest("li[data-p]");
    if (!li) return;
    $("#adminresults").hidden = true;
    $("#adminsearch").value = "";
    useAdmin(li.dataset.p);
  });
  $("#adminresults").addEventListener("keydown", e => { if (e.key === "Enter") e.target.closest("li[data-p]")?.click(); });
  $("#adminpick").addEventListener("change", e => {
    if (e.target.checked) showPick();
    else { pickLayer?.remove(); pickLayer = null; }
  });
  on("aoi", () => { if (pickLayer) showPick(); });
  on("theme", () => { if (outline) outline.setStyle(outlineStyle); });
}
