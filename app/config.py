"""Settings, dataset facts and Earth Engine limits.

Dataset facts were read from the live collection on 2026-10-23; tests/test_live_ee.py repeats the key checks.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
MIMU = ROOT / "data/mimu"
ATLAS = ROOT / "web/data/atlas.json"
ON_VERCEL = bool(os.environ.get("VERCEL"))
# Vercel's filesystem is read-only except /tmp (per instance, so the stats cache only lives while it is warm).
CACHE = Path(os.environ.get("MMFT_CACHE_DIR") or ("/tmp/mmft-cache" if ON_VERCEL else ROOT / "cache"))
# The page is served by run.py locally; when hosted, it lives on GitHub Pages and this app is the API only.
SERVE_WEB = WEB.is_dir() and not ON_VERCEL
CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "MMFT_CORS_ORIGINS", "https://geonet-myanmar.github.io,http://127.0.0.1:8770,http://localhost:8770").split(",") if o.strip()]

EE_PROJECT = os.environ.get("EE_PROJECT", "gee-python-419405")

# Forest Typology (ForTy) 2020 v1.0. 135,542 UTM tiles worldwide, 1,154 over Myanmar (413 in EPSG:32646, 741 in
# EPSG:32647), 10 m, tile origins on whole 10 m multiples. Neighbouring tiles overlap; mosaic() keeps one value.
COLLECTION = "projects/nature-trace/assets/forest_typology/forest_typology_2020_v1_0_collection"
CATALOG_URL = "https://developers.google.com/earth-engine/datasets/catalog/projects_nature-trace_assets_forest_typology_forest_typology_2020_v1_0_collection"
# Five uint8 probability bands on 0-250 (scale 0.004). The sixth class, Other land, is 250 minus their sum.
# At native resolution the five sum to at most 249 in every Myanmar test box; only pyramid levels exceed 250.
BANDS = ["PrimaryForest", "NaturallyRegeneratingForest", "PlantedForest", "PlantationForest", "TreeCropsAndAgroforestry"]
FULL = 250
SCALE_M = 10
# Classes 1-6 are the argmax of the six probabilities, the same rule as the publisher's own
# forest_typology_2020_v1_0_classification collection (identical on all 3.7 M test pixels).
CLASSES = [
    {"id": 1, "key": "primary", "band": "PrimaryForest", "name": "Primary forest",
     "color": "#1B7837", "safe": "#0b6b2e", "forest": True, "natural": True,
     "desc": "Native forest with no visible signs of human disturbance."},
    {"id": 2, "key": "regen", "band": "NaturallyRegeneratingForest", "name": "Naturally regenerating forest",
     "color": "#7FBF7B", "safe": "#7fbf7b", "forest": True, "natural": True,
     "desc": "Forest established mainly through natural regeneration, including secondary forest recovering after logging, fire or clearing."},
    {"id": 3, "key": "planted", "band": "PlantedForest", "name": "Planted forest",
     "color": "#1D91C0", "safe": "#2a78d6", "forest": True, "natural": False,
     "desc": "Forest mainly planted or seeded and managed on long rotations (more than 40 years)."},
    {"id": 4, "key": "plantation", "band": "PlantationForest", "name": "Plantation forest",
     "color": "#E65FA9", "safe": "#d55181", "forest": True, "natural": False,
     "desc": "Intensively managed planted forest of one or two species, even-aged, on rotations of 40 years or less."},
    {"id": 5, "key": "treecrops", "band": "TreeCropsAndAgroforestry", "name": "Tree crops & agroforestry",
     "color": "#E6AB02", "safe": "#eda100", "forest": False, "natural": False,
     "desc": "Commodity tree crops such as oil palm, rubber and orchards, and agroforestry. Agricultural land under the EUDR."},
    {"id": 6, "key": "other", "band": None, "name": "Other land",
     "color": "#FDE278", "safe": "#c9c5b9", "forest": False, "natural": False,
     "desc": "Everything else: cropland, grassland, built-up land, water, sparse woody vegetation under 10 % canopy, other wooded land and small tree patches."},
]
UNCERTAIN_COLOR = "#8a8f8c"
# Confidence histogram: the winning class's probability in 20 bins of 0.05 (bin b holds b*0.05 <= p < (b+1)*0.05).
NBINS = 20

# Bump whenever a computation changes, so cached statistics are not reused across versions.
ALGO_VERSION = "2026.10.23-1"

# Earth Engine request limits (measured 2026-10-21): every thumbnail / download request is budgeted at 6 bytes
# per pixel for 3 uint8 bands, i.e. 2 bytes per uint8 band, within 50,331,648 bytes.
EE_REQUEST_BYTES = 50_331_648
MAX_REQUEST_PX = (EE_REQUEST_BYTES - 64) // 6

# AOI limits (quota protection; everything bills to EE_PROJECT). Admin units of any size use the precomputed atlas.
AOI_WARN_KM2 = 40_000
AOI_MAX_KM2 = 160_000
AOI_MAX_VERTICES = 200_000
# Large pieces are reduced as cells of about this size (one Earth Engine request each; ~3 s per 1,000 km2).
CELL_KM2 = 2000

ATTRIBUTION = "Forest Typology (ForTy) 2020 v1.0, Google, CC BY 4.0"
CITATION = ("Neumann, M., Raichuk, A., Potapov, P., Lesiv, M., et al. (2026). Global forest typology at 10-meter "
            "resolution for forest and land-use monitoring. Scientific Data 13, 1434. https://doi.org/10.1038/s41597-026-08299-5")
MIMU_CREDIT = "Boundaries: MIMU PCode v9.4"
