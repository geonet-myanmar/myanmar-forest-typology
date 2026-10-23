// Uploading an area: GeoJSON (with a legacy "crs"), KML, KMZ, zipped Shapefile, a loose .shp/.dbf/.prj set, GPX.
// Everything is parsed in the browser; only the final polygon goes to the server.
import {$, esc, fmt, fmtArea, toast} from "./util.js";
import {setAoi} from "./aoi.js";

proj4.defs([
  ["EPSG:32646", "+proj=utm +zone=46 +datum=WGS84 +units=m +no_defs"],
  ["EPSG:32647", "+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs"],
  ["EPSG:23946", "+proj=utm +zone=46 +a=6377276.345 +rf=300.8017 +towgs84=217,823,299,0,0,0,0 +units=m +no_defs"],
  ["EPSG:23947", "+proj=utm +zone=47 +a=6377276.345 +rf=300.8017 +towgs84=217,823,299,0,0,0,0 +units=m +no_defs"],
  ["EPSG:24047", "+proj=utm +zone=47 +a=6377276.345 +rf=300.8017 +towgs84=210,814,289,0,0,0,0 +units=m +no_defs"],
]);
const CRS_CHOICES = [["EPSG:32646", "WGS 84 / UTM zone 46N"], ["EPSG:32647", "WGS 84 / UTM zone 47N"],
  ["EPSG:23946", "Indian 1954 / UTM zone 46N"], ["EPSG:23947", "Indian 1954 / UTM zone 47N"],
  ["EPSG:24047", "Indian 1975 / UTM zone 47N"], ["EPSG:3857", "Web Mercator"]];
const MAX_BYTES = 80e6;
const ext = f => f.name.toLowerCase().split(".").pop();
const stem = f => f.name.replace(/\.[^.]+$/, "");

export function initUpload() {
  const drop = $("#drop"), input = $("#fileinput");
  input.addEventListener("change", () => { handle([...input.files]); input.value = ""; });
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => handle([...e.dataTransfer.files]));
}

let uploadSeq = 0;      // a newer file wins: an older upload that resolves late must not overwrite its panel

async function handle(files) {
  if (!files.length) return;
  uploadSeq++;
  const step = $("#uploadstep");
  step.innerHTML = `<p class="note">Reading ${esc(files.map(f => f.name).join(", "))}…</p>`;
  try {
    if (files.reduce((s, f) => s + f.size, 0) > MAX_BYTES) throw new Error("Files over 80 MB are not supported. Clip or simplify first.");
    const {fc, name} = await parse(files);
    await review(flatten2d(fc), name);
  } catch (e) {
    step.innerHTML = `<div class="warnline">${esc(e.message)}</div>`;
  }
}

/* ---------- parsing ---------- */
async function parse(files) {
  const by = {};
  for (const f of files) (by[ext(f)] ||= []).push(f);
  if (by.shp) return {fc: await looseShapefile(by), name: stem(by.shp[0])};
  if (by.zip) return {fc: await zipped(by.zip[0]), name: stem(by.zip[0])};
  if (by.kmz) return {fc: await kmz(by.kmz[0]), name: stem(by.kmz[0])};
  if (by.kml) return {fc: xml(await by.kml[0].text(), "kml"), name: stem(by.kml[0])};
  if (by.gpx) return {fc: xml(await by.gpx[0].text(), "gpx"), name: stem(by.gpx[0])};
  const js = by.geojson?.[0] || by.json?.[0];
  if (js) return {fc: geojson(await js.text()), name: stem(js)};
  if (by.dbf || by.prj || by.shx) throw new Error("A Shapefile needs its .shp too: select .shp, .shx, .dbf and .prj together, or upload them zipped.");
  throw new Error("Unsupported file. Use GeoJSON, KML, KMZ, a zipped Shapefile or GPX.");
}

function xml(text, kind) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(`The ${kind.toUpperCase()} file is not valid XML.`);
  return kind === "kml" ? toGeoJSON.kml(doc) : toGeoJSON.gpx(doc);
}

async function kmz(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const kmls = Object.values(zip.files).filter(f => !f.dir && f.name.toLowerCase().endsWith(".kml"));
  if (!kmls.length) throw new Error("The KMZ has no .kml inside.");
  const main = kmls.find(f => /(^|\/)doc\.kml$/i.test(f.name)) || kmls[0];
  return xml(await main.async("string"), "kml");
}

async function zipped(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).map(n => n.toLowerCase());
  if (names.some(n => n.endsWith(".shp"))) {
    const out = await shp(buf);                       // reprojects from .prj
    const list = Array.isArray(out) ? out : [out];
    return {type: "FeatureCollection", features: list.flatMap(fc => fc.features.map(f => ({...f, properties: {...f.properties, _layer: fc.fileName || ""}})))};
  }
  const kml = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith(".kml"));
  if (kml) return xml(await kml.async("string"), "kml");
  const gj = Object.values(zip.files).find(f => /\.(geo)?json$/i.test(f.name));
  if (gj) return geojson(await gj.async("string"));
  throw new Error("The ZIP has no Shapefile, KML or GeoJSON inside.");
}

async function looseShapefile(by) {
  if (!by.dbf) throw new Error("Also select the .dbf (attributes) with the .shp.");
  const prj = by.prj ? await by.prj[0].text() : undefined;
  const cpg = by.cpg ? await by.cpg[0].text() : undefined;
  const geoms = await shp.parseShp(await by.shp[0].arrayBuffer(), prj);
  const props = await shp.parseDbf(await by.dbf[0].arrayBuffer(), cpg);
  const fc = await shp.combine([geoms, props]);
  if (!prj) fc._noPrj = true;
  return fc;
}

function geojson(text) {
  let g;
  try { g = JSON.parse(text); } catch { throw new Error("The file is not valid JSON."); }
  let fc;
  if (g.type === "FeatureCollection") fc = g;
  else if (g.type === "Feature") fc = {type: "FeatureCollection", features: [g]};
  else if (g.type && g.coordinates || g.type === "GeometryCollection") fc = {type: "FeatureCollection", features: [{type: "Feature", properties: {}, geometry: g}]};
  else throw new Error("No GeoJSON geometry found.");
  const name = g.crs?.properties?.name || "";
  const m = /EPSG::?(\d+)/i.exec(name);
  if (m && !["4326", "4979"].includes(m[1]) && !/CRS84/i.test(name)) {
    const code = "EPSG:" + m[1];
    if (!proj4.defs(code)) throw new Error(`The file uses ${code}. Reproject it to WGS 84 (EPSG:4326) first.`);
    fc = reproject(fc, code);
  }
  return fc;
}

function reproject(fc, code) {
  const tr = proj4(code, "EPSG:4326");
  const out = JSON.parse(JSON.stringify(fc));
  turf.coordEach(out, c => { const [x, y] = tr.forward([c[0], c[1]]); c[0] = x; c[1] = y; });
  return out;
}

function flatten2d(fc) {
  const feats = (fc.features || []).filter(f => f && f.geometry);
  return turf.truncate({type: "FeatureCollection", features: feats}, {precision: 6, coordinates: 2, mutate: true});   // 0.1 m
}

function looksProjected(fc) {
  let bad = false;
  turf.coordEach(fc, c => { if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) bad = true; });
  return bad;
}

/* ---------- review: choose features, buffer points/lines, then use ---------- */
function featName(f, i) {
  const p = f.properties || {};
  const k = ["name", "Name", "NAME", "name_en", "TS", "DT", "ST", "title", "Title", "label", "id", "ID"].find(k => p[k] != null && String(p[k]).trim());
  return k ? String(p[k]) : `Feature ${i + 1}`;
}

async function review(fc, name) {
  const step = $("#uploadstep");
  if (!fc.features.length) throw new Error("The file has no features.");
  if (looksProjected(fc)) {
    step.innerHTML = `<div class="warnline">Coordinates are projected (metres) and the file says not which system.</div>
      <label class="field">Coordinate system<select id="crspick">${CRS_CHOICES.map(([c, n]) => `<option value="${c}">${n} (${c})</option>`).join("")}</select></label>
      <div class="btnrow"><button class="btn primary" type="button" id="crsgo">Reproject</button></div>`;
    $("#crsgo").onclick = () => review(reproject(fc, $("#crspick").value), name).catch(e => { step.innerHTML = `<div class="warnline">${esc(e.message)}</div>`; });
    return;
  }
  const polys = [], others = [];
  fc.features.forEach((f, i) => {
    const t = f.geometry.type;
    (/Polygon/.test(t) ? polys : others).push({f, i, name: featName(f, i)});
  });
  if (!polys.length) return bufferStep(fc, others, name);
  const rows = polys.map(({f, i, name: n}) => {
    let a = 0;
    try { a = turf.area(f) / 1e6; } catch { /* invalid ring */ }
    return `<label class="chk"><input type="checkbox" data-i="${i}" checked> ${esc(n)} <span class="note">≈ ${fmtArea(a)}</span></label>`;
  }).join("");
  step.innerHTML = `<p class="note"><b>${esc(name)}</b>: ${polys.length} polygon feature${polys.length > 1 ? "s" : ""}${others.length ? `, ${others.length} point/line feature(s) ignored` : ""}.
    ${polys.length > 1 ? "Selected features are merged into one area." : ""}</p>
    ${polys.length > 1 ? `<div class="btnrow"><button class="btn" type="button" id="selall">All</button><button class="btn" type="button" id="selnone">None</button></div>` : ""}
    <div class="flist">${rows}</div>
    <div class="btnrow"><button class="btn primary" type="button" id="useupload">Use as area</button></div>`;
  $("#selall")?.addEventListener("click", () => step.querySelectorAll("[data-i]").forEach(c => { c.checked = true; }));
  $("#selnone")?.addEventListener("click", () => step.querySelectorAll("[data-i]").forEach(c => { c.checked = false; }));
  $("#useupload").onclick = () => guard(async () => {
    const pick = [...step.querySelectorAll("[data-i]:checked")].map(c => fc.features[+c.dataset.i]);
    if (!pick.length) return toast("Select at least one feature.", "err");
    const label = pick.length === 1 ? featName(pick[0], 0) : `${name} (${pick.length} features)`;
    await useFeatures(pick, label, name);
  });
}

function bufferStep(fc, others, name) {
  const step = $("#uploadstep");
  step.innerHTML = `<p class="note"><b>${esc(name)}</b> has ${others.length} point/line feature(s) and no polygon. Buffer them into an area:</p>
    <label class="field">Buffer distance (metres)<input type="text" id="bufm" inputmode="numeric" value="1000"></label>
    <div class="btnrow"><button class="btn primary" type="button" id="bufgo">Buffer and use</button></div>`;
  $("#bufgo").onclick = () => guard(async () => {
    const m = parseFloat($("#bufm").value);
    if (!(m > 0 && m <= 50000)) return toast("Use a distance between 1 and 50,000 m.", "err");
    const buffered = others.map(({f}) => turf.buffer(f, m, {units: "meters", steps: 16})).filter(Boolean);
    await useFeatures(buffered, `${name} (${fmt(m)} m buffer)`, name);
  });
}

/* setAoi already toasts server errors; local failures (e.g. a union that breaks) are shown under the list. */
function guard(fn) {
  fn().catch(e => {
    if (e?.message) $("#uploadstep").insertAdjacentHTML("beforeend", `<div class="warnline">${esc(e.message)}</div>`);
  });
}

async function useFeatures(features, label, fileName) {
  const seq = uploadSeq;
  let merged = features.length === 1 ? features[0] : turf.union(turf.featureCollection(features));
  if (!merged) throw new Error("Could not merge the features.");
  let geom = merged.geometry;
  const nv = turf.coordAll(merged).length;
  if (nv > 40000) {                      // keeps each request well under the host's 4.5 MB body limit; 2 m is a fifth of a pixel
    geom = turf.simplify(merged, {tolerance: 0.00002, highQuality: true}).geometry;
    toast(`Simplified ${fmt(nv)} vertices at 2 m tolerance (pixels are 10 m).`, "", 6000);
  }
  await setAoi({kind: "geojson", geometry: geom, name: label}, {source: `Uploaded: ${fileName}`});
  if (seq !== uploadSeq) return;
  $("#uploadstep").innerHTML = `<p class="note">Using <b>${esc(label)}</b>. Drop another file to replace it.</p>`;
}
