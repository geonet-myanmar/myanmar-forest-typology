// The Analyze tab: statistics for the current area (atlas for admin units, live Earth Engine for drawn or uploaded
// areas), class composition, confidence distribution, the breakdown table + choropleth, and downloads.
import {api} from "./api.js";
import {$, $$, esc, fmt, fmtArea, download, slug, store, openModal} from "./util.js";
import {S, on, emit} from "./state.js";
import {map, setChoropleth} from "./map.js";
import {units, byLevel, LV, useAdmin} from "./aoi-admin.js";
import {atlas, emptyZone, addZone, summary, rollup, aboveShare, METRICS, NB, binOf} from "./forty.js";
import {stackBar, keptCurve} from "./charts.js";
import {setThreshold} from "./maplayer.js";

const RAMP = ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];
let token = 0, bdLevel = 3, bdMetric = "forest_pct", bdSort = {key: null, dir: -1}, choroOn = false, clipCache = new Map();
const pal = () => S.meta.palettes[S.palette];
const mode = () => $("#an-count").value;

export function initAnalyze() {
  $("#bdmetric").innerHTML = METRICS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  $("#an-count").value = store.get("count", "hard");
  $("#an-count").addEventListener("change", () => { store.set("count", mode()); render(); });
  $("#thr2").addEventListener("input", e => setThreshold(+e.target.value, "#thr2"));
  $("#bdmetric").addEventListener("change", e => { bdMetric = e.target.value; bdSort = {key: bdMetric, dir: -1}; renderBreakdown(); });
  $$("#bdlevel button").forEach(b => b.addEventListener("click", () => setLevel(+b.dataset.lv)));
  for (const id of ["#ly-choro", "#bd-map"]) $(id).addEventListener("change", e => setChoro(e.target.checked));
  $("#an-mm").addEventListener("click", () => useAdmin("MMR"));
  $("#dl-csv").onclick = summaryCsv;
  $("#dl-bdcsv").onclick = breakdownCsv;
  $("#dl-json").onclick = jsonOut;
  $$("[data-tif]").forEach(b => b.addEventListener("click", () => geotiff(b.dataset.tif)));
  on("aoi", load);
  on("threshold", () => { if (S.stats) render(); });
  on("palette", () => { if (S.stats) render(); });
  on("map:theme", renderChoro);
}

function setLevel(lv) {
  bdLevel = lv;
  $$("#bdlevel button").forEach(b => b.setAttribute("aria-pressed", +b.dataset.lv === lv));
  renderBreakdown();
}

/* ---------- loading ---------- */
async function load(a) {
  const my = ++token;
  S.stats = null;
  clipCache = new Map();
  setChoropleth(null);
  $("#ly-choro").disabled = true;
  $("#ly-choro").checked = false;
  $("#an-body").hidden = true;
  if (!a) return;
  const prog = $("#an-progress"), st = $("#an-status");
  prog.hidden = false;
  prog.classList.add("busy");
  let timer = null;
  try {
    let stats;
    if (a.spec.kind === "admin") {
      st.textContent = "Loading the township atlas…";
      const at = await atlas();
      const pc = a.spec.pcode, lv = units[pc].properties.level;
      const key = {1: "st_pcode", 2: "dt_pcode", 3: "pcode"}[lv];
      const zones = {};
      for (const f of byLevel[3]) if (lv === 0 || f.properties[key] === pc) zones[f.properties.pcode] = at.townships[f.properties.pcode];
      stats = {source: "atlas", algo_version: at.algo_version, created: at.created, aoi_km2: a.info.area_km2, zones};
    } else {
      const t0 = Date.now(), est = Math.max(3, Math.round(a.info.area_km2 / 1000 * 3.5 / 12 + 3));
      const tick = () => { st.textContent = `Computing at 10 m in Earth Engine… ${Math.round((Date.now() - t0) / 1000)} s (about ${est} s for ${fmtArea(a.info.area_km2)})`; };
      tick();
      timer = setInterval(tick, 1000);
      stats = await api("stats", {aoi: a.spec});
    }
    if (my !== token) return;
    stats.total = Object.values(stats.zones).reduce((acc, z) => addZone(acc, z), emptyZone());
    S.stats = stats;
    bdLevel = a.spec.kind === "admin" ? Math.min(3, units[a.spec.pcode].properties.level + 1) : 3;
    setLevel(bdLevel);
    $("#an-body").hidden = false;
    $("#ly-choro").disabled = false;
    setChoro(choroOn, false);
    st.textContent = stats.source === "atlas"
      ? `From the township atlas: ${Object.keys(stats.zones).length} township${Object.keys(stats.zones).length > 1 ? "s" : ""} summed, computed at 10 m on ${stats.created?.slice(0, 10) || "–"}.`
      : `Computed live at 10 m: ${stats.pieces} piece${stats.pieces > 1 ? "s" : ""} in ${fmt(stats.seconds, 1)} s.`;
    render();
    emit("stats", stats);
  } catch (e) {
    if (my !== token) return;
    st.innerHTML = `<span class="warnline">${esc(e.message)}</span>`;
  } finally {
    clearInterval(timer);
    if (my === token) { prog.hidden = true; prog.classList.remove("busy"); }
  }
}

/* ---------- rendering ---------- */
function render() {
  if (!S.stats) return;
  $("#thr2").value = S.threshold;
  $("#thr2").disabled = mode() === "soft";
  const z = S.stats.total, s = summary(z, mode(), S.threshold), soft = summary(z, "soft", 0);
  const nodata = Math.max(0, S.stats.aoi_km2 - z.data_km2);
  const t = S.threshold, rule = mode() === "soft" ? "score-weighted" : t > 0 ? `winning score ≥ ${fmt(t, 2)}` : "winning class";
  const tile = (lbl, v, area, sub, c) => `<div class="tile"><div class="tl">${c ? `<i class="sw" style="background:${c}"></i>` : ""}${esc(lbl)}</div>
    <div class="tv">${v}</div><div class="ts">${area}</div>${sub ? `<div class="tn">${sub}</div>` : ""}</div>`;
  $("#an-tiles").innerHTML =
    tile("Forest (classes 1–4)", pct(s.pct(s.forest)), fmtArea(s.forest),
         `score-weighted ${pct(soft.pct(soft.forest))} · summed score ≥ 0.5: ${pct(s.pct(z.f50))}`) +
    tile("Natural forest (1–2)", pct(s.pct(s.natural)), fmtArea(s.natural),
         `score-weighted ${pct(soft.pct(soft.natural))} · summed score ≥ 0.5: ${pct(s.pct(z.n50))}`) +
    tile("Tree crops & agroforestry", pct(s.pct(s.treecrops)), fmtArea(s.treecrops), `score-weighted ${pct(soft.pct(soft.treecrops))}`) +
    tile("Mapped land", fmtArea(z.data_km2), `of ${fmtArea(S.stats.aoi_km2)}`,
         nodata > 0.01 * S.stats.aoi_km2 ? `${fmtArea(nodata)} without data (sea, or outside the map)` : "% are shares of mapped land");

  const segs = S.meta.classes.map((c, i) => ({label: c.name, value: s.cls[i], color: pal()[i]}));
  if (s.uncertain > 0) segs.push({label: "Uncertain", value: s.uncertain, color: S.meta.uncertain_color, note: `winning score below ${fmt(t, 2)}`});
  stackBar($("#ch-comp"), {title: "Forest-type composition", sub: `Share of mapped land · each pixel counted by its ${rule}`, segments: segs});

  const rows = S.meta.classes.map((c, i) => ({name: c.name, color: pal()[i], km2: s.cls[i], soft: soft.cls[i], id: c.id}));
  const grp = (name, ids) => ({name, km2: ids.reduce((a, i) => a + s.cls[i - 1], 0), soft: ids.reduce((a, i) => a + soft.cls[i - 1], 0), group: true});
  const all = [...rows];
  if (s.uncertain > 0) all.push({name: "Uncertain", color: S.meta.uncertain_color, km2: s.uncertain, soft: null});
  all.push(grp("All forest (1–4)", [1, 2, 3, 4]), grp("Natural forest (1–2)", [1, 2]), grp("Planted + plantation (3–4)", [3, 4]));
  const showSoft = mode() === "hard";
  $("#an-table").innerHTML = `<thead><tr><th>Class</th><th class="num">km²</th><th class="num">% of land</th>${showSoft ? `<th class="num" title="Each pixel contributes its score for the class">Weighted km²</th>` : ""}</tr></thead><tbody>` +
    all.map(r => `<tr class="${r.group ? "grp" : ""}"><td>${r.color ? `<i class="sw" style="background:${r.color}"></i>` : ""}${esc(r.name)}</td>
      <td class="num">${fmt(r.km2, r.km2 < 10 ? 2 : 1)}</td><td class="num">${fmt(s.pct(r.km2), 1)}</td>${showSoft ? `<td class="num">${r.soft == null ? "–" : fmt(r.soft, r.soft < 10 ? 2 : 1)}</td>` : ""}</tr>`).join("") + "</tbody>";
  $("#an-tablenote").textContent = mode() === "hard"
    ? "km² counts whole pixels by their winning class (the publisher's rule)" + (t > 0 ? `, keeping only winning scores ≥ ${fmt(t, 2)}` : "") +
      ". Score-weighted km² sums each pixel's score, a smoother estimate that counts mixed pixels in part."
    : "Score-weighted: every pixel adds its six scores, so each class gets a fraction of mixed pixels. The threshold does not apply.";
  renderConf();
  renderBreakdown();
}

const pct = v => v == null ? "–" : fmt(v, v < 10 ? 1 : 0) + "%";

function renderConf() {
  if (!S.stats) return;
  const z = S.stats.total, first = 3;          // the winning score can't be below 1/6, so start at 0.15
  const xs = Array.from({length: NB - first}, (_, i) => (i + first) / NB);
  const series = [];
  S.meta.classes.forEach((c, i) => {
    const row = z.hist[i], all = row.reduce((a, v) => a + v, 0);
    if (all < 0.005 * z.data_km2) return;      // classes under 0.5% of the land would be noise here
    const km2 = xs.map(t => row.slice(binOf(t)).reduce((a, v) => a + v, 0));
    series.push({label: c.name, short: c.name.split(" ")[0] === "Naturally" ? "Nat. regen." : c.name.replace(" & agroforestry", "").replace(" forest", ""),
                 color: pal()[i], km2, pct: km2.map(v => 100 * v / all)});
  });
  const t = S.threshold;
  const sub = t > 0
    ? `At ${fmt(t, 2)}, ${series.map(sr => `${sr.short} keeps ${fmt(sr.pct[Math.max(0, binOf(t) - first)], 0)}%`).join(", ")}. The rest becomes “uncertain”.`
    : "How much of each class survives a confidence threshold. Steep early drops mean many hesitant pixels.";
  keptCurve($("#ch-conf"), {title: "Area kept as the threshold rises", sub, xs, series, threshold: t});
}

function setChoro(v, draw = true) {
  choroOn = v;
  $("#ly-choro").checked = $("#bd-map").checked = v;
  if (draw) renderChoro();
}

/* ---------- breakdown ---------- */
function unitName(pc) {
  if (pc === "outside") return {en: "Outside Myanmar", my: "", parent: ""};
  const p = units[pc]?.properties;
  if (!p) return {en: pc, my: "", parent: ""};
  return {en: p.name_en, my: p.name_my || "", parent: p.level === 3 ? `${p.dt}, ${p.sub || p.st}` : p.level === 2 ? (p.sub || p.st) : ""};
}

function breakdownRows() {
  const groups = rollup(S.stats.zones, bdLevel);
  return [...groups.entries()].map(([pc, z]) => {
    const s = summary(z, mode(), S.threshold);
    const vals = Object.fromEntries(METRICS.map(([k, , f]) => [k, f(s)]));
    return {pc, z, s, vals, name: unitName(pc)};
  }).filter(r => r.z.data_km2 >= sliverKm2());
}

/* Drawn and uploaded edges rarely match MIMU lines exactly, so they clip thin slivers off neighbouring units.
   Those stay in the totals but are left out of the breakdown. */
function sliverKm2() {
  return S.aoi.spec.kind === "admin" ? 1e-4 : Math.max(0.05, 0.0005 * S.stats.total.data_km2);
}

function sliverCount() {
  return [...rollup(S.stats.zones, bdLevel).values()].filter(z => z.data_km2 > 0 && z.data_km2 < sliverKm2()).length;
}

function renderBreakdown() {
  if (!S.stats) return;
  const rows = breakdownRows();
  const key = bdSort.key || bdMetric, dir = bdSort.dir;
  rows.sort((a, b) => key === "name" ? dir * a.name.en.localeCompare(b.name.en) : dir * ((a.vals[key] ?? -1) - (b.vals[key] ?? -1)));
  const short = l => l.replace(", % of land", " %").replace(", %", " %").replace(", km²", " km²").replace(" (below threshold)", "");
  const cols = [["name", "Unit"], [bdMetric, short(METRICS.find(m => m[0] === bdMetric)[1])], ["land_km2", "Land km²"]];
  if (bdMetric !== "forest_pct") cols.push(["forest_pct", "Forest %"]);
  const vmax = Math.max(...rows.map(r => r.vals[bdMetric] ?? 0), 1e-9);
  const isPct = METRICS.find(m => m[0] === bdMetric)[3] === "%";
  const custom = S.aoi.spec.kind !== "admin";
  $("#bdtable").innerHTML = `<thead><tr>${cols.map(([k, l], i) => `<th class="${i ? "num" : ""}" data-k="${k}" tabindex="0" aria-sort="${key === k ? (dir > 0 ? "ascending" : "descending") : "none"}">${esc(l)}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>` +
    rows.map(r => `<tr data-pc="${r.pc}" tabindex="0"><td><span class="nm">${esc(r.name.en)}</span> <span class="my">${esc(r.name.my)}</span>${r.name.parent ? `<br><span class="note">${esc(r.name.parent)}</span>` : ""}</td>
      <td class="num"><span class="cellbar"><span style="width:${(100 * (r.vals[bdMetric] ?? 0) / (isPct ? 100 : vmax)).toFixed(1)}%"></span></span>${fmt(r.vals[bdMetric], isPct ? 1 : 0)}</td>
      <td class="num">${fmt(r.vals.land_km2, 0)}</td>${bdMetric !== "forest_pct" ? `<td class="num">${fmt(r.vals.forest_pct, 1)}</td>` : ""}</tr>`).join("") + "</tbody>";
  $$("#bdtable th").forEach(th => {
    const go = () => { const k = th.dataset.k; bdSort = {key: k, dir: bdSort.key === k ? -bdSort.dir : (k === "name" ? 1 : -1)}; renderBreakdown(); };
    th.onclick = go;
    th.onkeydown = e => { if (e.key === "Enter") go(); };
  });
  $$("#bdtable tbody tr").forEach(tr => {
    const go = () => drill(tr.dataset.pc);
    tr.onclick = go;
    tr.onkeydown = e => { if (e.key === "Enter") go(); };
  });
  $("#bdnote").textContent = `${rows.length} ${LV[bdLevel].toLowerCase()}${rows.length === 1 ? "" : "s"}` +
    (custom ? " intersecting the area; figures cover only the part inside it." : ". Click a row or a unit on the map to open it.") +
    (custom && sliverCount() ? ` ${sliverCount()} edge sliver${sliverCount() > 1 ? "s" : ""} under ${fmtArea(sliverKm2())} left out (still in the totals).` : "");
  renderChoro(rows);
}

function drill(pc) {
  if (pc === "outside" || !units[pc]) return;
  if (S.aoi.spec.kind === "admin") { useAdmin(pc); return; }
  const f = clipCache.get(pc + ":" + bdLevel) || units[pc];
  if (f) map.fitBounds(L.geoJSON(f).getBounds(), {padding: [40, 40]});
}

function ramp(v, max) {
  const x = Math.max(0, Math.min(1, v / max)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
  const h = c => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16));
  const a = h(RAMP[i]), b = h(RAMP[i + 1]);
  return "#" + a.map((av, k) => Math.round(av + (b[k] - av) * f).toString(16).padStart(2, "0")).join("");
}

function zoneShape(pc) {
  const k = pc + ":" + bdLevel;
  if (clipCache.has(k)) return clipCache.get(k);
  let f = units[pc];
  if (f && S.aoi.spec.kind !== "admin" && S.aoi.display) {
    try {
      const cut = turf.intersect(turf.featureCollection([f, S.aoi.display.type === "Feature" ? S.aoi.display : turf.feature(S.aoi.display)]));
      f = cut ? {...cut, properties: f.properties} : null;
    } catch { /* keep the whole unit */ }
  }
  clipCache.set(k, f);
  return f;
}

function renderChoro(rows) {
  if (!S.stats || !choroOn) { setChoropleth(null); return; }
  rows = Array.isArray(rows) ? rows : breakdownRows();
  const m = METRICS.find(x => x[0] === bdMetric), isPct = m[3] === "%";
  const max = isPct ? Math.max(...rows.map(r => r.vals[bdMetric] ?? 0), 1) : Math.max(...rows.map(r => r.vals[bdMetric] ?? 0), 1e-9);
  const top = isPct ? Math.min(100, Math.ceil(max / 10) * 10) : max;
  const byPc = new Map(rows.map(r => [r.pc, r]));
  const feats = rows.filter(r => r.pc !== "outside").map(r => {
    const f = zoneShape(r.pc);
    return f ? {...f, properties: {...f.properties, _pc: r.pc}} : null;
  }).filter(Boolean);
  if (!feats.length) { setChoropleth(null); return; }
  setChoropleth({type: "FeatureCollection", features: feats}, {
    color: f => ramp(byPc.get(f.properties._pc).vals[bdMetric] ?? 0, top),
    tip: f => {
      const r = byPc.get(f.properties._pc);
      return `<b>${esc(r.name.en)}</b> <span class="my">${esc(r.name.my)}</span><br>${esc(m[1])}: <b>${fmt(r.vals[bdMetric], isPct ? 1 : 0)}</b><br>Land ${fmtArea(r.vals.land_km2)} · forest ${fmt(r.vals.forest_pct, 1)}%`;
    },
    onClick: f => drill(f.properties._pc),
    legend: `<b>${esc(m[1])}</b><div class="ramp" style="background:linear-gradient(90deg,${RAMP.join(",")})"></div>
      <div class="ends"><span>0</span><span>${fmt(top, isPct ? 0 : 0)}${isPct ? "%" : ""}</span></div>
      <div class="note">By ${LV[bdLevel].toLowerCase()} · ${mode() === "soft" ? "score-weighted" : S.threshold > 0 ? `score ≥ ${fmt(S.threshold, 2)}` : "winning class"}</div>`,
  });
}

/* ---------- downloads ---------- */
function stamp() {
  return {area: S.aoi.info.name, area_km2: S.aoi.info.area_km2, counting: mode() === "soft" ? "score-weighted" : "winning class",
          threshold: mode() === "soft" ? null : S.threshold, source: S.stats.source, algo_version: S.stats.algo_version,
          dataset: S.meta.collection, citation: S.meta.citation, license: "CC BY 4.0", boundaries: S.meta.mimu};
}
const csvCell = v => typeof v === "number" ? (Number.isFinite(v) ? +v.toFixed(6) : "") : `"${String(v ?? "").replace(/"/g, '""')}"`;

function summaryCsv() {
  const z = S.stats.total, s = summary(z, mode(), S.threshold), soft = summary(z, "soft", 0);
  const lines = [["class_id", "class", "km2", "pct_of_land", "score_weighted_km2"].join(",")];
  S.meta.classes.forEach((c, i) => lines.push([c.id, c.name, s.cls[i], s.pct(s.cls[i]), soft.cls[i]].map(csvCell).join(",")));
  if (s.uncertain > 0) lines.push(["", "Uncertain (below threshold)", s.uncertain, s.pct(s.uncertain), ""].map(csvCell).join(","));
  lines.push(["1-4", "All forest", s.forest, s.pct(s.forest), soft.forest].map(csvCell).join(","));
  lines.push(["1-2", "Natural forest", s.natural, s.pct(s.natural), soft.natural].map(csvCell).join(","));
  lines.push(["", "Mapped land", z.data_km2, 100, z.data_km2].map(csvCell).join(","));
  const meta = Object.entries(stamp()).map(([k, v]) => `# ${k}: ${v ?? ""}`);
  download([...meta, ...lines].join("\n"), `${slug(S.aoi.info.name)}_forty2020_summary.csv`, "text/csv");
}

function breakdownCsv() {
  const rows = breakdownRows();
  const head = ["pcode", "name_en", "name_my", "parent", ...S.meta.classes.map(c => c.key + "_km2"), "uncertain_km2",
                ...METRICS.map(m => m[0]), "forest_score_ge_0.5_km2", "natural_score_ge_0.5_km2"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([r.pc, r.name.en, r.name.my, r.name.parent, ...r.s.cls, r.s.uncertain, ...METRICS.map(m => r.vals[m[0]]),
                r.z.f50, r.z.n50].map(csvCell).join(","));
  }
  const meta = Object.entries({...stamp(), level: LV[bdLevel]}).map(([k, v]) => `# ${k}: ${v ?? ""}`);
  download("﻿" + [...meta, ...lines].join("\n"), `${slug(S.aoi.info.name)}_forty2020_by_${LV[bdLevel].toLowerCase().replace("/", "_")}.csv`, "text/csv");
}

function jsonOut() {
  const out = {...stamp(), classes: S.meta.classes.map(({id, key, name}) => ({id, key, name})),
               format: "hist[class 1-6][bin 0-19]: km2 whose winning class is that class with a winning score in [bin*0.05, (bin+1)*0.05); soft: score-weighted km2; f50/n50: km2 where summed forest / natural-forest score >= 0.5",
               total: S.stats.total, zones: S.stats.zones};
  download(JSON.stringify(out), `${slug(S.aoi.info.name)}_forty2020_stats.json`, "application/json");
}

async function geotiff(kind) {
  openModal(`<h3>Preparing GeoTIFF…</h3><p class="note">Requesting native 10 m download links from Earth Engine.</p>`);
  try {
    const r = await api("download", {aoi: S.aoi.spec, kind});
    const vrt = r.vrt ? `<div class="btnrow"><button class="btn" type="button" id="dlvrt">Download ${esc(r.name)}.vrt</button></div>` : "";
    const legend = kind === "class" ? `Values: ${S.meta.classes.map(c => `${c.id} ${c.name}`).join(", ")}; 0 = no data / outside the area.`
      : `Bands: ${r.bands.join(", ")}; values 0–250 (score × 250); 255 = no data / outside the area.`;
    openModal(`<h3>${esc(r.name)}</h3>
      <p class="note">${r.cols.toLocaleString()} × ${r.rows.toLocaleString()} px at ${r.scale} m, ${esc(r.crs)} (the dataset's own grid)${r.chunks.length > 1 ? ` in ${r.chunks.length} tiles. Put all tiles in one folder and open the .vrt in QGIS.` : "."} Links work for about two hours.</p>
      <p class="note">${esc(legend)} ${esc(r.note || "")}</p>
      <div class="dl-list">${r.chunks.map(c => `<a href="${c.url}" download="${esc(c.file)}">${esc(c.file)}</a>`).join("")}</div>${vrt}
      <p class="note">${esc(S.meta.attribution)}.</p>`);
    if (r.vrt) $("#dlvrt").onclick = () => download(r.vrt, r.name + ".vrt", "application/xml");
  } catch (e) {
    openModal(`<h3>Download failed</h3><div class="warnline">${esc(e.message)}</div>`);
  }
}

