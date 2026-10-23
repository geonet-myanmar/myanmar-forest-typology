// "Save PNG with legend": an Earth Engine still of the current layer over a hillshade, finished on a canvas with
// the title, legend, scale bar, north arrow and the credits CC BY 4.0 requires.
import {api} from "./api.js";
import {$, fmt, download, slug, toast} from "./util.js";
import {S} from "./state.js";
import {layerSpec} from "./map.js";

const INK = "#15201b", MUTED = "#4b5852", PAPER = "#fbfcf9";

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Earth Engine did not return the image. Try a smaller size."));
    im.src = url;
  });
}

function niceLen(m) {
  const p = Math.pow(10, Math.floor(Math.log10(m)));
  return [5, 2, 1].map(k => k * p).find(v => v <= m) || p;
}

export async function saveMapImage() {
  if (!S.aoi) return;
  const btn = $("#img-save");
  btn.disabled = true;
  btn.textContent = "Rendering…";
  try {
    const r = await api("thumb", {aoi: S.aoi.spec, layer: layerSpec(), preset: $("#img-size").value,
                                  aspect: $("#img-aspect").value, opacity: Math.max(0.6, S.opacity)});
    const im = await loadImage(r.url);
    const W = r.width, k = W / 1600;                         // type scale follows the image width
    const pad = Math.round(28 * k), headH = Math.round(96 * k), footH = Math.round(54 * k);
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = r.height + headH + footH;
    const g = cv.getContext("2d");
    g.fillStyle = PAPER;
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(im, 0, headH);

    // title
    g.fillStyle = INK;
    g.font = `700 ${Math.round(34 * k)}px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif`;
    g.textBaseline = "alphabetic";
    g.fillText(S.aoi.info.name, pad, Math.round(46 * k));
    g.font = `500 ${Math.round(19 * k)}px "IBM Plex Sans", system-ui, sans-serif`;
    g.fillStyle = MUTED;
    g.fillText(`${r.legend.title} · Forest Typology (ForTy) 2020 v1.0, 10 m`, pad, Math.round(78 * k));

    // legend box
    const lg = r.legend, fs = Math.round(17 * k), lh = Math.round(27 * k), sw = Math.round(17 * k);
    g.font = `500 ${fs}px "IBM Plex Sans", system-ui, sans-serif`;
    const items = lg.kind === "categorical" ? lg.items : [];
    const boxW = Math.max(lg.kind === "categorical" ? Math.max(...items.map(([, n]) => g.measureText(n).width)) + sw + 26 * k : 300 * k, 220 * k);
    const boxH = lg.kind === "categorical" ? items.length * lh + 18 * k : 74 * k;
    const bx = pad, by = headH + r.height - boxH - pad;
    g.fillStyle = "rgba(251,252,249,0.94)";
    g.strokeStyle = "rgba(21,32,27,0.25)";
    g.lineWidth = Math.max(1, k);
    g.beginPath();
    g.roundRect(bx, by, boxW, boxH, 8 * k);
    g.fill();
    g.stroke();
    g.fillStyle = INK;
    if (lg.kind === "categorical") {
      items.forEach(([c, n], i) => {
        const y = by + 12 * k + i * lh;
        g.fillStyle = c;
        g.beginPath();
        g.roundRect(bx + 12 * k, y + 3 * k, sw, sw, 3 * k);
        g.fill();
        g.fillStyle = INK;
        g.fillText(n, bx + 12 * k + sw + 9 * k, y + sw);
      });
    } else {
      const gx = bx + 12 * k, gw = boxW - 24 * k, gy = by + 14 * k, gh = 16 * k;
      const grad = g.createLinearGradient(gx, 0, gx + gw, 0);
      lg.colors.forEach((c, i) => grad.addColorStop(i / (lg.colors.length - 1), c));
      g.fillStyle = grad;
      g.fillRect(gx, gy, gw, gh);
      g.fillStyle = INK;
      g.fillText(`${fmt(lg.min, 2)}${lg.low ? " " + lg.low : ""}`, gx, gy + gh + 24 * k);
      const hi = `${fmt(lg.max, 2)}${lg.high ? " " + lg.high : ""}`;
      g.fillText(hi, gx + gw - g.measureText(hi).width, gy + gh + 24 * k);
    }

    // scale bar (ground metres per pixel at the image centre) and north arrow
    const len = niceLen(r.ground_m * W * 0.18), px = len / r.ground_m;
    const sx = W - pad - px, sy = headH + r.height - pad - 10 * k;
    g.fillStyle = "rgba(251,252,249,0.94)";
    g.fillRect(sx - 12 * k, sy - 34 * k, px + 24 * k, 50 * k);
    g.fillStyle = INK;
    g.fillRect(sx, sy, px, 6 * k);
    g.fillStyle = PAPER;
    g.fillRect(sx + px / 2, sy + 1.5 * k, px / 2 - 1.5 * k, 3 * k);
    g.fillStyle = INK;
    g.font = `600 ${fs}px "IBM Plex Sans", system-ui, sans-serif`;
    const lbl = len >= 1000 ? `${fmt(len / 1000, 0)} km` : `${fmt(len, 0)} m`;
    g.fillText(lbl, sx + px - g.measureText(lbl).width, sy - 10 * k);
    const nx = W - pad - 18 * k, ny = headH + pad;
    g.fillStyle = "rgba(251,252,249,0.94)";
    g.beginPath();
    g.arc(nx, ny + 22 * k, 26 * k, 0, 2 * Math.PI);
    g.fill();
    g.fillStyle = INK;
    g.beginPath();
    g.moveTo(nx, ny + 6 * k);
    g.lineTo(nx + 10 * k, ny + 34 * k);
    g.lineTo(nx, ny + 28 * k);
    g.lineTo(nx - 10 * k, ny + 34 * k);
    g.closePath();
    g.fill();
    g.font = `700 ${Math.round(14 * k)}px "IBM Plex Sans", system-ui, sans-serif`;
    g.fillText("N", nx - 5 * k, ny + 50 * k);

    // credits
    g.fillStyle = MUTED;
    g.font = `400 ${Math.round(15 * k)}px "IBM Plex Sans", system-ui, sans-serif`;
    const fy = headH + r.height + Math.round(22 * k);
    g.fillText(`Data: ${S.meta.attribution}. ${S.meta.mimu}. Hillshade: SRTM (NASA/USGS). Web Mercator.`, pad, fy);
    g.fillText(`Scores are relative confidence, not calibrated probabilities. Made with the Myanmar Forest Typology Explorer, ${new Date().toISOString().slice(0, 10)}.`, pad, fy + Math.round(22 * k));

    const blob = await new Promise(res => cv.toBlob(res, "image/png"));
    download(blob, `${slug(S.aoi.info.name)}_forty2020_${layerSpec().type}.png`, "image/png");
  } catch (e) {
    toast(e.message, "err", 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save PNG with legend";
  }
}
