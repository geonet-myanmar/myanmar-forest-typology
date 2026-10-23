// Drawing an area on the map (Geoman): rectangle, polygon, circle; then editing the drawn shape.
import {$, $$, toast} from "./util.js";
import {S, on} from "./state.js";
import {map} from "./map.js";
import {setAoi} from "./aoi.js";

const STYLE = {color: "#2a78d6", weight: 2, fillColor: "#2a78d6", fillOpacity: 0.08};
let editLayer = null;

export function initDraw() {
  map.pm.setGlobalOptions({pathOptions: STYLE, templineStyle: STYLE, hintlineStyle: {...STYLE, dashArray: "5 5"},
                           snappable: false, allowSelfIntersection: false, finishOn: "dblclick"});
  $$("[data-draw]").forEach(b => b.addEventListener("click", () => startDraw(b.dataset.draw)));
  $("#drawcancel").addEventListener("click", stopDraw);
  $("#drawedit").addEventListener("click", () => (editLayer ? endEdit(true) : startEdit()));
  map.on("pm:create", async e => {
    let geom;
    if (e.shape === "Circle") {
      const c = e.layer.getLatLng();
      geom = turf.circle([c.lng, c.lat], e.layer.getRadius() / 1000, {steps: 128, units: "kilometers"}).geometry;
    } else {
      geom = e.layer.toGeoJSON().geometry;
    }
    map.removeLayer(e.layer);
    stopDraw();
    try {
      await setAoi({kind: "geojson", geometry: geom, name: `Drawn ${e.shape.toLowerCase()}`}, {source: "Drawn on the map"});
    } catch { /* toast already shown */ }
  });
  on("aoi", a => {
    if (editLayer) endEdit(false);
    $("#drawedit").disabled = !(a && a.spec.kind === "geojson");
  });
}

function startDraw(shape) {
  if (editLayer) endEdit(false);
  map.pm.disableDraw();
  map.pm.enableDraw(shape, {pathOptions: STYLE});
  $("#drawcancel").hidden = false;
  toast(shape === "Polygon" ? "Click to add points; click the first point or double-click to finish." :
        "Press and drag on the map.", "", 5000);
}

function stopDraw() {
  map.pm.disableDraw();
  $("#drawcancel").hidden = true;
}

function startEdit() {
  if (!S.aoi || S.aoi.spec.kind !== "geojson") return;
  editLayer = L.geoJSON(S.aoi.spec.geometry, {pane: "aoi", style: STYLE}).addTo(map);
  editLayer.eachLayer(l => l.pm.enable({allowSelfIntersection: false}));
  $("#drawedit").textContent = "Finish editing";
  toast("Drag the vertices; click Finish editing when done.", "", 5000);
}

async function endEdit(apply) {
  const layer = editLayer;
  editLayer = null;
  $("#drawedit").textContent = "Edit shape";
  if (!layer) return;
  const fc = layer.toGeoJSON();
  layer.eachLayer(l => l.pm.disable());
  map.removeLayer(layer);
  if (!apply) return;
  const polys = [];
  turf.flattenEach(fc, f => { if (f.geometry?.type === "Polygon") polys.push(f.geometry.coordinates); });
  const geometry = polys.length === 1 ? {type: "Polygon", coordinates: polys[0]} : {type: "MultiPolygon", coordinates: polys};
  try {
    await setAoi({...S.aoi.spec, geometry}, {source: (S.aoi.source || "Custom area") + " (edited)", fit: false});
  } catch { /* toast already shown */ }
}
