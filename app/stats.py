"""Area statistics at native 10 m resolution, by township, plus the pixel inspector.

Every piece is reduced on the native grid of its UTM zone (crs + a 10 m crsTransform on the tiles' lattice), never
on a coarser `scale`. Areas are true areas (pixelArea, km2). Admin units use the precomputed township atlas, which
scripts/04_build_atlas.py builds with this same code.
"""
import json, threading, time
from concurrent.futures import ThreadPoolExecutor
import ee
from shapely.geometry import Point
from . import aoi as A, forty as F
from .cache import digest, disk_get, disk_set
from .config import ATLAS, ALGO_VERSION, BANDS, FULL, CLASSES
from .ee_client import call, EEError

GRID = [10, 0, 0, 0, -10, 0]          # ForTy tile origins sit on whole 10 m multiples in both UTM zones
_slots = threading.BoundedSemaphore(20)
_atlas, _alock = {}, threading.Lock()


def reduce_piece(epsg, gj):
    geom = ee.Geometry(gj, "EPSG:4326", False)
    img = F.stats_image(geom)

    def run(tile_scale):
        with _slots:
            return call(img.reduceRegion(F.STATS_REDUCER(), geom, crs=f"EPSG:{epsg}", crsTransform=GRID,
                                         maxPixels=1e11, tileScale=tile_scale).getInfo)
    try:
        r = run(4)
    except EEError as e:
        if "memory" not in str(e).lower():
            raise
        r = run(16)
    return r.get("groups", [])


def zone_stats(pieces, workers=16):
    """Reduce (zone, epsg, geojson) pieces in parallel and fold them per zone."""
    zones = {}
    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(pieces)))) as ex:
        results = list(ex.map(lambda p: reduce_piece(p[1], p[2]), pieces))
    for (zone, _, _), groups in zip(pieces, results):
        F.add_groups(zones.setdefault(zone, F.empty_zone()), groups)
    return zones


def atlas():
    with _alock:
        if not _atlas and ATLAS.exists():
            _atlas.update(json.loads(ATLAS.read_text(encoding="utf-8")))
        return _atlas


def aoi_stats(aoi):
    t0 = time.time()
    if aoi.kind == "admin":
        at = atlas()
        if not at:
            raise ValueError("The township atlas (web/data/atlas.json) is missing; run scripts/04_build_atlas.py.")
        zones = {p: at["townships"][p] for p in A.townships_of(aoi.pcode) if p in at["townships"]}
        total = F.empty_zone()
        for z in zones.values():
            total = F.merge(total, z)
        return {"source": "atlas", "algo_version": at.get("algo_version"), "aoi_km2": aoi.area_km2,
                "total": F.finish(total), "zones": zones, "pieces": 0, "seconds": round(time.time() - t0, 2)}

    key = digest("stats", aoi.key)
    hit = disk_get("stats", key)
    if hit is not None:
        return hit
    pcs = A.pieces(aoi.geometry)
    zones = zone_stats(pcs)
    total = F.empty_zone()
    for z in zones.values():
        total = F.merge(total, z)
    out = {"source": "live", "algo_version": ALGO_VERSION, "aoi_km2": aoi.area_km2, "total": F.finish(total),
           "zones": {k: F.finish(v) for k, v in zones.items()}, "pieces": len(pcs),
           "seconds": round(time.time() - t0, 1)}
    return disk_set("stats", key, out)


def point(lon, lat):
    pt = ee.Geometry.Point([float(lon), float(lat)])
    epsg = A.utm_epsg(float(lon))
    v = call(F.scores(pt).select(BANDS).reduceRegion(
        ee.Reducer.first(), pt, crs=f"EPSG:{epsg}", crsTransform=GRID).getInfo)
    if not v or any(v.get(b) is None for b in BANDS):
        raise ValueError("No ForTy data at this point (sea, or outside the map's coverage).")
    s = [int(v[b]) for b in BANDS]
    s.append(max(0, FULL - sum(s)))
    cls = max(range(6), key=lambda i: (s[i], -i)) + 1
    srt = sorted(s)
    A._load()
    with A.GEOS_LOCK:
        p = Point(float(lon), float(lat))
        hits = [A._ts["pcodes"][i] for i in A._ts["tree"].query(p, predicate="intersects")]
    tsp = A.township_props(hits[0]) if hits else None
    return {"lon": float(lon), "lat": float(lat), "epsg": epsg, "scores": s, "class": cls,
            "class_name": CLASSES[cls - 1]["name"], "top": srt[-1], "margin": srt[-1] - srt[-2],
            "forest": sum(s[:4]), "natural": sum(s[:2]),
            "township": ({"pcode": tsp["pcode"], "name_en": tsp["name_en"], "name_my": tsp.get("name_my", ""),
                          "dt": tsp.get("dt", ""), "st": tsp.get("sub") or tsp.get("st", "")} if tsp else None)}
