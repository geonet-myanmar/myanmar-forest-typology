// App state, a tiny event bus, and the shareable part of the state in the URL hash.
const handlers = {};
export const on = (evt, fn) => (handlers[evt] ||= []).push(fn);
export const emit = (evt, data) => (handlers[evt] || []).forEach(fn => fn(data));

export const S = {
  meta: null,
  aoi: null,          // {spec, info, display, source}: spec is what the API takes; info is the cleaned summary
  tab: "area",
  layer: "class",     // class | score | confidence
  palette: "official",
  classes: [1, 2, 3, 4, 5, 6],
  threshold: 0,       // winning-score threshold shared by the map and the statistics (0 = argmax)
  uncertain: "grey",
  scoreTarget: "forest",
  scoreMin: 0.1,
  confMeasure: "top",
  opacity: 0.85,
  clip: false,
  stats: null,        // statistics of the current AOI: {total, zones, source, ...}
};

/* Share admin units, the layer and the threshold; drawn or uploaded shapes stay in this browser. */
export function writeHash() {
  const p = new URLSearchParams();
  p.set("tab", S.tab);
  p.set("ly", S.layer);
  if (S.layer === "score") p.set("sc", S.scoreTarget);
  if (S.threshold > 0) p.set("t", S.threshold.toFixed(2));
  if (S.palette !== "official") p.set("pal", S.palette);
  if (S.aoi?.spec?.kind === "admin") p.set("aoi", S.aoi.spec.pcode);
  try { history.replaceState(null, "", "#" + p.toString()); } catch { /* ignore */ }
}

export function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const t = parseFloat(p.get("t"));
  return {tab: p.get("tab"), layer: p.get("ly"), sc: p.get("sc"), pal: p.get("pal"), aoi: p.get("aoi"),
          threshold: t >= 0 && t < 1 ? Math.round(t * 20) / 20 : null};
}
