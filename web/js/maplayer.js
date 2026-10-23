// The Map tab: layer choice, class palette and visibility, the shared confidence threshold, display options,
// and the pixel inspector.
import {api} from "./api.js";
import {$, $$, esc, fmt, toast, store, debounce} from "./util.js";
import {S, on, emit, writeHash} from "./state.js";
import {map, refreshLayer, setOpacity} from "./map.js";
import {scoreBars} from "./charts.js";

const pal = () => S.meta.palettes[S.palette];

function renderClassList() {
  $("#classlist").innerHTML = S.meta.classes.map((c, i) => `
    <label class="clsrow" title="${esc(c.desc)}"><input type="checkbox" data-c="${c.id}" ${S.classes.includes(c.id) ? "checked" : ""}>
      <i class="sw" style="background:${pal()[i]}"></i><span>${c.id}. ${esc(c.name)}</span></label>`).join("");
}

function setClasses(list) {
  S.classes = list;
  renderClassList();
  store.set("classes", list);
  refreshLayer();
}

export function setLayerMode(ly) {
  S.layer = ["class", "score", "confidence"].includes(ly) ? ly : "class";
  $$("#lymode button").forEach(b => b.setAttribute("aria-pressed", b.dataset.ly === S.layer));
  for (const m of ["class", "score", "confidence"]) $("#ly-" + m).hidden = m !== S.layer;
  $("#thrgroup").hidden = S.layer !== "class";
  writeHash();
}

/* The threshold lives in two sliders (Map and Analyze); both write S.threshold and announce it. */
export function setThreshold(t, from) {
  S.threshold = Math.max(0, Math.min(0.95, Math.round(t * 20) / 20));
  for (const [id, out] of [["#thr", "#o-thr"], ["#thr2", "#o-thr2"]]) {
    if (id !== from) $(id).value = S.threshold;
    $(out).textContent = S.threshold > 0 ? fmt(S.threshold, 2) : "off";
  }
  store.set("threshold", S.threshold);
  writeHash();
  emit("threshold", S.threshold);
}
const refreshSoon = debounce(() => refreshLayer(), 350);

export function initMapTab(h) {
  S.palette = h.pal === "safe" ? "safe" : store.get("palette", "official");
  S.classes = store.get("classes", [1, 2, 3, 4, 5, 6]);
  S.uncertain = store.get("uncertain", "grey");
  S.opacity = store.get("opacity", 0.85);
  S.scoreTarget = h.sc || store.get("scoreTarget", "forest");
  $("#palette").value = S.palette;
  $("#thr-mode").value = S.uncertain;
  $("#sc-target").value = S.scoreTarget;
  $("#opacity").value = Math.round(S.opacity * 100);
  $("#o-opacity").textContent = Math.round(S.opacity * 100) + "%";
  renderClassList();
  setLayerMode(h.layer || "class");
  setThreshold(h.threshold ?? store.get("threshold", 0));

  $$("#lymode button").forEach(b => b.addEventListener("click", () => { setLayerMode(b.dataset.ly); refreshLayer(); }));
  $("#palette").addEventListener("change", e => {
    S.palette = e.target.value;
    store.set("palette", S.palette);
    renderClassList();
    writeHash();
    refreshLayer();
    emit("palette");
  });
  $("#classlist").addEventListener("change", () => {
    const list = $$("#classlist input:checked").map(i => +i.dataset.c);
    if (!list.length) { toast("Keep at least one class.", "err"); renderClassList(); return; }
    setClasses(list);
  });
  $("#cls-all").onclick = () => setClasses([1, 2, 3, 4, 5, 6]);
  $("#cls-forest").onclick = () => setClasses([1, 2, 3, 4]);
  $("#cls-trees").onclick = () => setClasses([1, 2, 3, 4, 5]);
  $("#thr").addEventListener("input", e => { setThreshold(+e.target.value, "#thr"); refreshSoon(); });
  $("#thr-mode").addEventListener("change", e => { S.uncertain = e.target.value; store.set("uncertain", S.uncertain); refreshLayer(); });
  $("#sc-target").addEventListener("change", e => { S.scoreTarget = e.target.value; store.set("scoreTarget", S.scoreTarget); writeHash(); refreshLayer(); });
  $("#sc-min").addEventListener("input", e => { S.scoreMin = +e.target.value; $("#o-scmin").textContent = fmt(S.scoreMin, 2); refreshSoon(); });
  $("#cf-measure").addEventListener("change", e => { S.confMeasure = e.target.value; refreshLayer(); });
  $("#opacity").addEventListener("input", e => {
    setOpacity(+e.target.value / 100);
    $("#o-opacity").textContent = e.target.value + "%";
    store.set("opacity", S.opacity);
  });
  $("#clip").addEventListener("change", e => { S.clip = e.target.checked; refreshLayer(); });
  on("threshold", () => { if (S.layer === "class") refreshSoon(); });
  on("map:click", inspect);
}

/* ---------- pixel inspector ---------- */
let pin = null, pop = null;
async function inspect(ll) {
  if (!$("#inspect").checked || map.pm?.globalDrawModeEnabled?.() || map.pm?.globalEditModeEnabled?.()) return;
  if ($("#adminpick").checked) return;
  pin?.remove();
  pin = L.circleMarker(ll, {radius: 6, color: "#fff", weight: 2.5, fillColor: "#15201b", fillOpacity: 1, pane: "aoi", interactive: false}).addTo(map);
  pop = L.popup({maxWidth: 380, className: "pxpop", autoPanPadding: [30, 30]}).setLatLng(ll)
    .setContent(`<p class="note">Reading the 10 m pixel at ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}…</p>`).openOn(map);
  pop.on("remove", () => { pin?.remove(); pin = null; });
  try {
    const r = await api("point", {lon: ll.lng, lat: ll.lat});
    const rows = S.meta.classes.map((c, i) => ({label: c.name, color: pal()[i], value: r.scores[i] / 250, win: c.id === r.class}));
    const ts = r.township;
    pop.setContent(`<div class="px">
      <div class="eyebrow">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)} · UTM ${r.epsg === 32646 ? "46N" : "47N"}</div>
      <div class="pxhead"><i class="sw" style="background:${pal()[r.class - 1]}"></i><b>${esc(r.class_name)}</b></div>
      ${scoreBars(rows)}
      <div class="pxsum">All forest (1–4) <b>${fmt(r.forest / 250, 2)}</b> · natural (1–2) <b>${fmt(r.natural / 250, 2)}</b> · margin <b>${fmt(r.margin / 250, 2)}</b></div>
      ${ts ? `<div class="note">${esc(ts.name_en)} <span class="my">${esc(ts.name_my)}</span>, ${esc(ts.dt)}, ${esc(ts.st)}</div>` : ""}
    </div>`);
  } catch (e) {
    pop.setContent(`<div class="warnline">${esc(e.message)}</div>`);
  }
}
