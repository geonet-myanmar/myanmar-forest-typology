"""Areas of interest: a MIMU unit by PCode, or a GeoJSON polygon drawn or uploaded in the browser.

Admin AOIs always use the full-resolution MIMU polygon from data/mimu (the map shows a simplified copy), and their
statistics come from the precomputed township atlas. Custom AOIs are cut into pieces (AOI x township x UTM zone x
cell) so each piece is reduced on its own native grid and the results also break down by township.
"""
import json, math, threading
from dataclasses import dataclass, field, asdict
import ee
from pyproj import Geod
from shapely import set_precision
from shapely.geometry import shape, mapping, box, MultiPolygon
from shapely.prepared import prep
from shapely.strtree import STRtree
from shapely.validation import make_valid
from .cache import TTL, digest
from .config import MIMU, AOI_MAX_KM2, AOI_WARN_KM2, AOI_MAX_VERTICES, CELL_KM2

GEOD = Geod(ellps="WGS84")
LEVELS = {0: "Union", 1: "State/Region", 2: "District", 3: "Township"}
_admin, _mm, _lock = {}, {}, threading.Lock()
_ts = {}          # township index: pcodes, shapes, STRtree
# GEOS prepared geometries (the shared Myanmar outline) are not thread-safe: 16 threads validating at once segfault.
# Requests run in a threadpool (and share one Vercel instance), so all GEOS / pyproj work goes through this lock.
GEOS_LOCK = threading.Lock()
_resolved = TTL(3600, 256)


def _load():
    with _lock:
        if _admin:
            return
        for lv in range(4):
            fc = json.loads((MIMU / f"adm{lv}.geojson").read_text(encoding="utf-8"))
            for f in fc["features"]:
                _admin[f["properties"]["pcode"]] = f
        g = shape(_admin["MMR"]["geometry"])
        _mm["geom"], _mm["prep"] = g, prep(g)
        ts = [f for f in _admin.values() if f["properties"]["level"] == 3]
        _ts["pcodes"] = [f["properties"]["pcode"] for f in ts]
        _ts["shapes"] = [shape(f["geometry"]) for f in ts]
        _ts["tree"] = STRtree(_ts["shapes"])


def admin_feature(pcode):
    _load()
    return _admin.get(pcode)


@dataclass
class AOI:
    key: str
    kind: str
    name: str
    geometry: dict
    area_km2: float
    bbox: list
    name_my: str = ""
    pcode: str = ""
    level: int = 0
    inside_pct: float = 100.0
    vertices: int = 0
    warnings: list = field(default_factory=list)

    def ee(self):
        return ee.Geometry(self.geometry, "EPSG:4326", False)

    def public(self, with_geometry=True):
        d = asdict(self)
        if not with_geometry:
            d.pop("geometry")
        return d


def area_km2(g):
    return abs(GEOD.geometry_area_perimeter(g)[0]) / 1e6


def _polygonal(g):
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    parts = [p for p in getattr(g, "geoms", []) if p.geom_type in ("Polygon", "MultiPolygon")]
    polys = [q for p in parts for q in (p.geoms if p.geom_type == "MultiPolygon" else [p])]
    return MultiPolygon(polys) if polys else None


def _count_vertices(g):
    polys = g.geoms if g.geom_type == "MultiPolygon" else [g]
    return sum(len(p.exterior.coords) + sum(len(i.coords) for i in p.interiors) for p in polys)


def resolve(spec):
    """spec: {"kind": "admin", "pcode": ...} or {"kind": "geojson", "geometry": {...}, "name": ...}."""
    if not isinstance(spec, dict):
        raise ValueError("Missing area of interest.")
    _load()
    kind = spec.get("kind")
    if kind == "admin":
        f = _admin.get(spec.get("pcode", ""))
        if not f:
            raise ValueError(f"Unknown MIMU PCode {spec.get('pcode')!r}.")
        key = f"adm:{f['properties']['pcode']}"
        hit = _resolved.get(key)
        if hit:
            return hit
        p = f["properties"]
        with GEOS_LOCK:
            g = shape(f["geometry"])
            bbox, nv = [round(v, 6) for v in g.bounds], _count_vertices(g)
        parent = p.get("dt") if p["level"] == 3 else p.get("st") or ""
        unit = (p.get("type") or LEVELS[1]) if p["level"] == 1 else LEVELS[p["level"]]
        name = "Myanmar" if p["level"] == 0 else f"{p['name_en']} {unit}" + (f", {p.get('sub') or parent}" if parent else "")
        return _resolved.set(key, AOI(key=key, kind="admin", geometry=f["geometry"], area_km2=p["area_km2"], bbox=bbox,
                                      name=name,
                                      name_my=p.get("name_my", ""), pcode=p["pcode"], level=p["level"], vertices=nv))
    if kind != "geojson":
        raise ValueError("Area of interest must be an admin unit or a GeoJSON polygon.")

    raw_key = digest("aoi", spec.get("geometry"))
    hit = _resolved.get(raw_key)
    if hit:
        return AOI(**{**asdict(hit), "name": spec.get("name") or hit.name})
    with GEOS_LOCK:
        return _resolved.set(raw_key, _validate(spec))


def _validate(spec):
    try:
        g = shape(spec["geometry"])
    except Exception as e:
        raise ValueError(f"Not a valid GeoJSON geometry: {e}")
    minx, miny, maxx, maxy = g.bounds
    if minx < -180 or maxx > 180 or miny < -90 or maxy > 90:
        raise ValueError("Coordinates are not longitude/latitude. Reproject the file to WGS 84 (EPSG:4326).")
    g = _polygonal(make_valid(g))
    if g is None or g.is_empty:
        raise ValueError("The area has no polygon. Points and lines need a buffer first.")
    g = set_precision(g, 1e-7)
    nv = _count_vertices(g)
    if nv > AOI_MAX_VERTICES:
        raise ValueError(f"The polygon has {nv:,} vertices; simplify it below {AOI_MAX_VERTICES:,}.")
    a = area_km2(g)
    if a < 0.01:
        raise ValueError("The area is smaller than 0.01 km² (about 11 pixels).")
    if a > AOI_MAX_KM2:
        raise ValueError(f"The area is {a:,.0f} km²; the limit is {AOI_MAX_KM2:,} km² (Sagaing Region is about 94,000). Pick a State/Region from the admin list to see larger areas.")
    if not _mm["prep"].intersects(g):
        raise ValueError("The area does not overlap Myanmar.")
    inside = 100.0 if _mm["prep"].contains(g) else 100.0 * area_km2(g.intersection(_mm["geom"])) / a
    warnings = []
    if inside < 99.9:
        warnings.append(f"{100 - inside:.1f}% of the area lies outside Myanmar; it is still analysed.")
    if a > AOI_WARN_KM2:
        warnings.append(f"Large area ({a:,.0f} km²): native-resolution statistics can take several minutes.")
    geom = mapping(g)
    return AOI(key="geo:" + digest("geom", geom)[:16], kind="geojson", name=spec.get("name") or "Custom area",
               geometry=json.loads(json.dumps(geom)), area_km2=round(a, 3), bbox=[round(v, 6) for v in g.bounds],
               inside_pct=round(inside, 2), vertices=nv, warnings=warnings)


def utm_epsg(lon):
    """Myanmar's ForTy tiles are all in UTM 46N (west of 96 E) or 47N."""
    return 32646 if lon < 96 else 32647


def _split_cells(g, cell_km2):
    a = area_km2(g)
    if a <= cell_km2 * 1.25:
        return [g]
    minx, miny, maxx, maxy = g.bounds
    fill = max(g.area, 1e-12) / max(g.envelope.area, 1e-12)        # a k x k grid over the bbox; only cells that hit g count
    k = max(2, min(12, math.ceil(math.sqrt(a / cell_km2 / fill))))
    out = []
    for i in range(k):
        for j in range(k):
            c = box(minx + (maxx - minx) * i / k, miny + (maxy - miny) * j / k,
                    minx + (maxx - minx) * (i + 1) / k, miny + (maxy - miny) * (j + 1) / k)
            if not g.intersects(c):
                continue
            part = _polygonal(g.intersection(c))
            if part is not None and not part.is_empty:
                out.append(part)
    return out


def pieces(geometry, cell_km2=CELL_KM2, by_township=True):
    """Cut a polygon into (zone, epsg, geojson) pieces: zone is the MIMU township PCode ("outside" beyond Myanmar),
    epsg the UTM zone whose native 10 m grid the piece is reduced on. Pieces tile the polygon, and reductions weight
    edge pixels by coverage, so piece sums add up to the whole."""
    _load()
    out = []
    with GEOS_LOCK:
        g = shape(geometry)
        parts = []
        if by_township:
            for i in _ts["tree"].query(g, predicate="intersects"):
                t = _ts["shapes"][i]
                inter = g if t.contains(g) else _polygonal(g.intersection(t))
                if inter is not None and not inter.is_empty and area_km2(inter) > 1e-4:
                    parts.append((_ts["pcodes"][i], inter))
            if not _mm["prep"].contains(g):
                rest = _polygonal(g.difference(_mm["geom"]))
                if rest is not None and not rest.is_empty and area_km2(rest) > 1e-4:
                    parts.append(("outside", rest))
        else:
            parts.append(("all", g))
        for zone, part in parts:
            for epsg, half in ((32646, box(-180, -90, 96, 90)), (32647, box(96, -90, 180, 90))):
                h = part if (half.contains(part)) else _polygonal(part.intersection(half))
                if h is None or h.is_empty or area_km2(h) < 1e-5:
                    continue
                for c in _split_cells(h, cell_km2):
                    out.append((zone, epsg, json.loads(json.dumps(mapping(c)))))
    return out


def township_props(pcode):
    _load()
    f = _admin.get(pcode)
    return f["properties"] if f else None


def townships_of(pcode):
    """Township PCodes inside an admin unit (all 330 for MMR)."""
    _load()
    f = _admin.get(pcode)
    if not f:
        return []
    lv = f["properties"]["level"]
    key = {0: None, 1: "st_pcode", 2: "dt_pcode", 3: "pcode"}[lv]
    return [p for p in _ts["pcodes"] if key is None or _admin[p]["properties"][key] == pcode]
