// Client-side statistics from a zone summary (see app/forty.py): every threshold and breakdown is computed here
// from the 6 x 20 confidence histogram, so moving the threshold never needs a new Earth Engine request.
//   zone = {data_km2, hist: [6][20] km2 by winning class and winning-score bin (0.05 wide), soft: [6] score-weighted
//           km2, f50 / n50: km2 where the summed forest / natural-forest score >= 0.5}
import {units} from "./aoi-admin.js";

export const NB = 20;
export const GROUPS = {forest: [1, 2, 3, 4], natural: [1, 2], managed: [3, 4]};

let atlasP = null;
export function atlas() {
  atlasP ||= fetch("data/atlas.json").then(r => {
    if (!r.ok) throw new Error("The township atlas (data/atlas.json) could not be loaded.");
    return r.json();
  });
  return atlasP;
}

export function emptyZone() {
  return {data_km2: 0, hist: Array.from({length: 6}, () => new Array(NB).fill(0)), soft: new Array(6).fill(0), f50: 0, n50: 0};
}

export function addZone(acc, z) {
  acc.data_km2 += z.data_km2;
  acc.f50 += z.f50;
  acc.n50 += z.n50;
  for (let c = 0; c < 6; c++) {
    acc.soft[c] += z.soft[c];
    for (let b = 0; b < NB; b++) acc.hist[c][b] += z.hist[c][b];
  }
  return acc;
}

export const binOf = t => Math.round(t * NB);

/* Area per class (km2) under the current counting rule. hard: winning class with score >= t (the rest is
   "uncertain"); soft: score-weighted (threshold does not apply). */
export function classAreas(z, mode = "hard", t = 0) {
  if (mode === "soft") return {cls: z.soft.slice(), uncertain: 0};
  const b0 = binOf(t);
  const cls = z.hist.map(row => row.slice(b0).reduce((a, v) => a + v, 0));
  return {cls, uncertain: Math.max(0, z.data_km2 - cls.reduce((a, v) => a + v, 0))};
}

export function summary(z, mode, t) {
  const {cls, uncertain} = classAreas(z, mode, t);
  const g = ids => ids.reduce((a, i) => a + cls[i - 1], 0);
  const land = z.data_km2;
  const pct = v => land > 0 ? 100 * v / land : null;
  return {land, cls, uncertain, forest: g(GROUPS.forest), natural: g(GROUPS.natural), managed: g(GROUPS.managed),
          treecrops: cls[4], other: cls[5], pct, f50: z.f50, n50: z.n50};
}

/* Share of a class's own (argmax) area at or above each bin. */
export function aboveShare(z, c, t) {
  const row = z.hist[c - 1], all = row.reduce((a, v) => a + v, 0);
  return all > 0 ? row.slice(binOf(t)).reduce((a, v) => a + v, 0) / all : null;
}

/* Zones (township PCodes, or "outside") rolled up to a MIMU level: 3 township, 2 district, 1 State/Region. */
export function rollup(zones, level) {
  const out = new Map();
  for (const [pc, z] of Object.entries(zones)) {
    let key = pc;
    if (pc !== "outside" && level < 3) {
      const p = units[pc]?.properties;
      key = p ? (level === 2 ? p.dt_pcode : p.st_pcode) : pc;
    }
    if (!out.has(key)) out.set(key, emptyZone());
    addZone(out.get(key), z);
  }
  return out;
}

/* Breakdown columns: [key, label, value(summary) -> number, unit]. */
export const METRICS = [
  ["forest_pct", "Forest (1–4), % of land", s => s.pct(s.forest), "%"],
  ["natural_pct", "Natural forest (1–2), %", s => s.pct(s.natural), "%"],
  ["primary_pct", "Primary forest, %", s => s.pct(s.cls[0]), "%"],
  ["regen_pct", "Naturally regenerating, %", s => s.pct(s.cls[1]), "%"],
  ["managed_pct", "Planted + plantation (3–4), %", s => s.pct(s.managed), "%"],
  ["treecrops_pct", "Tree crops & agroforestry, %", s => s.pct(s.treecrops), "%"],
  ["other_pct", "Other land, %", s => s.pct(s.other), "%"],
  ["uncertain_pct", "Uncertain (below threshold), %", s => s.pct(s.uncertain), "%"],
  ["forest_km2", "Forest (1–4), km²", s => s.forest, "km²"],
  ["natural_km2", "Natural forest (1–2), km²", s => s.natural, "km²"],
  ["treecrops_km2", "Tree crops & agroforestry, km²", s => s.treecrops, "km²"],
  ["land_km2", "Mapped land, km²", s => s.land, "km²"],
];
