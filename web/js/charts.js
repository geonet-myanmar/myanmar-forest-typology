// Hand-written SVG charts (dataviz specs: thin marks, 4px rounded data ends on the baseline, 2px surface gaps
// between fills, recessive grid, per-mark tooltips, a legend for every multi-series chart plus selective direct
// labels). Text uses the ink tokens, never the series colour.
import {esc, fmt, fmtArea, showTip, hideTip} from "./util.js";

const NS = "http://www.w3.org/2000/svg";
function svg(w, h) { const s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", `0 0 ${w} ${h}`); s.setAttribute("role", "img"); return s; }
function add(p, tag, at = {}, txt) {
  const e = document.createElementNS(NS, tag);
  for (const k in at) e.setAttribute(k, at[k]);
  if (txt != null) e.textContent = txt;
  p.appendChild(e);
  return e;
}
function head(el, o) {
  el.innerHTML = `<div class="ttl">${esc(o.title)}</div>${o.sub ? `<div class="sub">${o.sub}</div>` : ""}`;
}
function tips(node, html) {
  node.addEventListener("mousemove", e => showTip(e, html));
  node.addEventListener("mouseleave", hideTip);
  node.addEventListener("focus", e => { const r = node.getBoundingClientRect(); showTip({clientX: r.left, clientY: r.bottom}, html); });
  node.addEventListener("blur", hideTip);
}
const W = 420;

/* One 100% bar: segments [{label, value, color, note}], direct labels on segments >= 7%, legend below. */
export function stackBar(el, o) {
  head(el, o);
  const total = o.segments.reduce((a, s) => a + s.value, 0);
  if (!(total > 0)) return;
  const H = 54, m = {l: 0, r: 0, t: 4}, bh = 28;
  const s = svg(W, H);
  el.appendChild(s);
  let x = m.l;
  const iw = W - m.l - m.r;
  o.segments.forEach((sg, i) => {
    const w = iw * sg.value / total;
    if (w <= 0) return;
    const gap = i < o.segments.length - 1 ? 2 : 0;
    const r = add(s, "rect", {x, y: m.t, width: Math.max(0.5, w - gap), height: bh, fill: sg.color, rx: 3, tabindex: 0,
                              "aria-label": `${sg.label}: ${fmt(100 * sg.value / total, 1)}%`});
    tips(r, `<b>${esc(sg.label)}</b><br>${fmtArea(sg.value)} · ${fmt(100 * sg.value / total, 1)}%${sg.note ? `<br><span class="note">${esc(sg.note)}</span>` : ""}`);
    if (w / iw >= 0.07) add(s, "text", {x: x + w / 2 - 1, y: m.t + bh + 15, "text-anchor": "middle", class: "lab"}, `${fmt(100 * sg.value / total, 0)}%`);
    x += w;
  });
  const lg = document.createElement("div");
  lg.className = "leg";
  lg.innerHTML = o.segments.filter(sg => sg.value > 0).map(sg => `<span><i class="sw" style="background:${sg.color}"></i>${esc(sg.label)}</span>`).join("");
  el.appendChild(lg);
}

/* Share of each class's area kept as the threshold rises: lines (2px) over thresholds, end labels, a crosshair
   tooltip, and a dashed marker at the current threshold. */
export function keptCurve(el, o) {
  head(el, o);
  const {xs, series, threshold} = o;              // series: [{label, color, pct[], km2[]}]
  if (!series.length) return;
  const H = 190, m = {l: 38, r: 92, t: 10, b: 32};
  const s = svg(W, H);
  el.appendChild(s);
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = v => m.l + iw * (v - xs[0]) / (xs[xs.length - 1] - xs[0]);
  const y = v => m.t + ih * (1 - v / 100);
  for (const v of [0, 25, 50, 75, 100]) {
    add(s, "line", {x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v), class: v === 0 ? "ax" : "gl"});
    add(s, "text", {x: m.l - 6, y: y(v) + 3.5, "text-anchor": "end"}, v + "%");
  }
  for (const v of [0.2, 0.4, 0.6, 0.8]) if (v >= xs[0]) add(s, "text", {x: x(v), y: H - m.b + 14, "text-anchor": "middle"}, fmt(v, 1));
  add(s, "text", {x: m.l + iw / 2, y: H - 3, "text-anchor": "middle"}, "threshold on the winning class's score");
  if (threshold > 0) {
    add(s, "line", {x1: x(threshold), x2: x(threshold), y1: m.t, y2: m.t + ih, class: "thr", "stroke-dasharray": "4 3"});
  }
  const ends = [];
  for (const sr of series) {
    const d = sr.pct.map((v, i) => `${i ? "L" : "M"}${x(xs[i]).toFixed(1)},${y(v ?? 0).toFixed(1)}`).join("");
    add(s, "path", {d, fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round"});
    ends.push({sr, y: y(sr.pct[sr.pct.length - 1] ?? 0)});
  }
  ends.sort((a, b) => a.y - b.y);                  // direct labels at the right end, nudged apart
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 12);
  for (const e of ends) {
    add(s, "circle", {cx: x(xs[xs.length - 1]), cy: y(e.sr.pct[e.sr.pct.length - 1] ?? 0), r: 3, fill: e.sr.color});
    add(s, "text", {x: m.l + iw + 8, y: Math.min(e.y, m.t + ih + 8) + 3.5, class: "lab"}, e.sr.short || e.sr.label);
  }
  const cross = add(s, "line", {x1: 0, x2: 0, y1: m.t, y2: m.t + ih, class: "ax", visibility: "hidden"});
  const hit = add(s, "rect", {x: m.l, y: m.t, width: iw, height: ih, fill: "transparent"});
  hit.addEventListener("mousemove", e => {
    const r = s.getBoundingClientRect(), px = (e.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(xs.length - 1, Math.round((px - m.l) / iw * (xs.length - 1))));
    cross.setAttribute("x1", x(xs[i]));
    cross.setAttribute("x2", x(xs[i]));
    cross.setAttribute("visibility", "visible");
    showTip(e, `<b>Score ≥ ${fmt(xs[i], 2)}</b>` + series.map(sr => `<div class="row"><i class="sw" style="background:${sr.color}"></i>${esc(sr.label)}: ${fmt(sr.pct[i], 0)}% · ${fmtArea(sr.km2[i])}</div>`).join(""));
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  if (series.length > 1) {
    const lg = document.createElement("div");
    lg.className = "leg";
    lg.innerHTML = series.map(sr => `<span><i class="sw" style="background:${sr.color}"></i>${esc(sr.label)}</span>`).join("");
    el.appendChild(lg);
  }
}

/* Six horizontal score bars for the pixel inspector (0-1 scale, values printed). */
export function scoreBars(rows) {
  return `<div class="pxbars">${rows.map(r => `<div class="pxrow${r.win ? " win" : ""}"><span class="pxl"><i class="sw" style="background:${r.color}"></i>${esc(r.label)}</span>
    <span class="pxtrack"><span style="width:${(100 * r.value).toFixed(1)}%;background:${r.color}"></span></span><span class="pxv">${fmt(r.value, 2)}</span></div>`).join("")}</div>`;
}
