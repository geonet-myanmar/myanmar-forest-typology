# Myanmar Forest Typology Explorer

A web app for Google's **Forest Typology (ForTy) 2020 v1.0** (Earth Engine collection
`projects/nature-trace/assets/forest_typology/forest_typology_2020_v1_0_collection`, CC BY 4.0), the global 10 m
map of primary, naturally regenerating, planted and plantation forest, tree crops and other land. Pick any area in
Myanmar, then map it and analyse it.

**Choosing an area**
- MIMU States/Regions, Districts and Townships (PCode v9.4, searchable in English or Myanmar), or the whole country.
- Draw a rectangle, polygon or circle on the map.
- Upload GeoJSON (a legacy `crs` is honoured), KML, KMZ, a zipped Shapefile, a loose `.shp/.dbf/.prj` set or GPX.

**Map**
- Forest type, in the published palette or a validated colour-blind-safe one, with any subset of classes shown.
- Each class's confidence score, plus the summed scores for all forest (1–4), natural forest (1–2) and
  planted + plantation (3–4).
- Confidence: the winning class's score, or its margin over the runner-up.
- A confidence threshold shared with the statistics. Pixels below it show as "uncertain" or are hidden.
- A pixel inspector showing all six scores.
- A PNG export with legend, scale bar and credits.

**Analyze**
- Class areas counted three ways: by winning class (optionally above the threshold), score-weighted, and by summed
  score ≥ 0.5.
- The composition chart and table.
- An "area kept as the threshold rises" curve.
- A breakdown by township, district or State/Region, sortable, with an optional choropleth that drills down on click.
- CSV and JSON exports, and native 10 m GeoTIFFs (classes, six scores, confidence) cut into tiles with a VRT.

## Run it

```
pip install -r requirements.txt          # requirements-dev.txt adds the data scripts and tests
python run.py                            # opens http://127.0.0.1:8770
```

The app uses this machine's Earth Engine login with project `gee-python-419405`. Override it with `EE_PROJECT=...`.
Set `EE_SERVICE_ACCOUNT_KEY` (a path or the JSON itself) to run under a service account. Drawn and uploaded areas
count against that project's Earth Engine quota. Admin units cost nothing: they come from the precomputed atlas.

## How the numbers are made

- **Native resolution.** Every statistic is reduced on the dataset's own 10 m UTM grid: EPSG:32646 west of 96° E
  and EPSG:32647 east of it, with a `crsTransform` on the tiles' lattice and true pixel areas. A coarser `scale` is
  never used. Areas are cut into pieces (area × township × UTM zone × cells of up to 2,000 km²). Each piece is one
  Earth Engine request, and edge pixels are weighted by coverage, so the pieces add up and break down by township.
- **One pass per piece** gives a 6 × 20 histogram: km² by winning class and by winning score (0.05 bins). It also
  gives score-weighted km² and the summed-score ≥ 0.5 masks. Every threshold and every roll-up to district,
  State/Region or Union is computed in the browser from that histogram, with no new request.
- **Township atlas.** `web/data/atlas.json` holds that summary for all 330 townships (668,607 km², built in 7 min by
  `scripts/04_build_atlas.py`). Admin areas open instantly from it. Drawn areas run live at about 3 s per 1,000 km².
- **Classes** are the argmax of the six scores. This matches the publisher's own
  `forest_typology_2020_v1_0_classification` on every pixel tested. Other land = 250 − the sum of the five bands.

Checked against the live data (2026-10-23):
- The five bands sum to at most 249 at native resolution. Only pyramid levels exceed 250, so Other land is clamped
  at 0 for map tiles.
- **Inside Myanmar the Planted forest score never exceeds 0.01**, and Plantation forest totals 142 km². The app
  says so wherever it matters.
- Coastal tiles give open sea an Other land score. MIMU units follow the coastline, so their figures are unaffected.
  For drawn areas, the sea part is listed as "Outside Myanmar".
- Myanmar nationally: 63.9% forest (Primary 32.7%, Naturally regenerating 31.1%), Tree crops 2.4%, Other land 33.7%.
- The paper reports that in Asia the map over-assigns Primary versus Naturally regenerating forest. The About tab
  passes this on with the paper's accuracy figures.

## Rebuild the data

```
python scripts/01_fetch_mimu.py            # MIMU WFS -> data/raw/mimu
python scripts/02_build_admin.py           # data/mimu/adm0-3.geojson + web/data/admin.topo.json
python scripts/02_build_admin.py --patch   # only re-parent Shan/Bago sub-states onto MMR222/MMR111
python scripts/03_vendor.py                # pinned JS libraries -> web/vendor (+ SHA-256 in VERSIONS.txt)
python scripts/04_build_atlas.py           # web/data/atlas.json (per-township cache in data/raw/atlas)
```

## Tests

```
python -m pytest -m "not live and not e2e"   # pieces, folding, MIMU hierarchy, atlas integrity
python -m pytest -m live                     # Earth Engine: live vs atlas, argmax = publisher, tiles, GeoTIFF grid
python -m pytest -m e2e                      # the app in Chrome: Shan, every upload format, drawing, exports
```

## Hosting

- The page (`web/`) is published by GitHub Actions (`.github/workflows/pages.yml`).
- The API (`app/`) runs on Vercel (`vercel.json`, `tool.vercel.entrypoint`) under a render-only Earth Engine service
  account.
- `web/js/config.js` points the page at the API when it is served from github.io.

## Layout

```
app/        FastAPI backend: ee_client, forty (dataset maths), aoi (pieces), stats, layers, media, main
web/        page, CSS, ES modules (no build step), data/admin.topo.json, data/atlas.json, vendor/
data/mimu/  MIMU boundaries at full resolution (used for analysis)
scripts/    data preparation
tests/      unit, live and e2e tests; fixtures/
```

Citation: Neumann, M., Raichuk, A., Potapov, P., Lesiv, M., et al. (2026). Global forest typology at 10-meter
resolution for forest and land-use monitoring. *Scientific Data* 13, 1434. https://doi.org/10.1038/s41597-026-08299-5
