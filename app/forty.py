"""Forest Typology (ForTy) 2020 v1.0 maths in Earth Engine: scores, the class map, confidence and the stats image.

Scores are the publisher's "relative confidence scores" (ensemble softmax, not calibrated), stored 0-250.
"""
import json, threading
import ee
from shapely.geometry import shape, mapping
from .config import COLLECTION, BANDS, FULL, NBINS, MIMU

BIN_W = FULL / NBINS          # 12.5 score units = 0.05
_outline, _olock = {}, threading.Lock()


def myanmar_outline():
    """Myanmar, simplified and buffered ~2 km: map tiles use the ForTy tiles that touch it (statistics filter by
    their own piece instead). Built once; a few hundred vertices."""
    with _olock:
        if "g" not in _outline:
            fc = json.loads((MIMU / "adm0.geojson").read_text(encoding="utf-8"))
            g = shape(fc["features"][0]["geometry"]).buffer(0.02).simplify(0.01)
            _outline["g"] = ee.Geometry(json.loads(json.dumps(mapping(g))), "EPSG:4326", False)
        return _outline["g"]


def collection(region=None):
    return ee.ImageCollection(COLLECTION).filterBounds(region if region is not None else myanmar_outline())


def scores(region=None):
    """Six bands on 0-250: the five stored scores plus Other land = 250 - their sum (clamped: pyramids can exceed 250)."""
    # A fully masked placeholder keeps the five bands when no tile touches the region (open sea): an empty mosaic
    # has no bands at all, and every select() on it fails.
    empty = ee.Image.constant([0] * 5).rename(BANDS).toUint8().updateMask(0)
    p = collection(region).merge(ee.ImageCollection([empty])).mosaic().select(BANDS)
    other = ee.Image(FULL).subtract(p.reduce(ee.Reducer.sum())).max(0).rename("OtherLand")
    return p.addBands(other)


def class_and_top(s6):
    """Argmax class (1-6, ties go to the lower class, as in the publisher's classification) and its score."""
    arr = s6.toArray()
    cls = arr.arrayArgmax().arrayGet([0]).add(1).rename("class")
    top = arr.arrayReduce(ee.Reducer.max(), [0]).arrayGet([0]).rename("top")
    return cls, top


def margin(s6):
    """Winning score minus the runner-up (0-250): how clearly the class wins."""
    srt = s6.toArray().arraySort()
    return srt.arrayGet([5]).subtract(srt.arrayGet([4])).rename("margin")


def group_score(s6, ids):
    """Summed score of a class group, e.g. forest = classes 1-4, natural forest = 1-2 (the paper's usage notes)."""
    return s6.select([i - 1 for i in ids]).reduce(ee.Reducer.sum())


GROUPS = {"forest": [1, 2, 3, 4], "natural": [1, 2], "managed": [3, 4]}


def stats_image(region):
    """Bands for one grouped reduction (Reducer.sum().repeat(8).group(8)):
    0 area km2 | 1-5 area x score/250 for classes 1-5 | 6 area where forest score >= 0.5 | 7 same for natural forest
    | 8 group key = class * 100 + confidence bin (0..19)."""
    s6 = scores(region)
    cls, top = class_and_top(s6)
    key = cls.multiply(100).add(top.divide(BIN_W).floor().min(NBINS - 1)).toInt().rename("key")
    area = ee.Image.pixelArea().divide(1e6).updateMask(s6.select(0).mask()).rename("a")
    bands = [area] + [area.multiply(s6.select(i)).divide(FULL).rename(f"s{i + 1}") for i in range(5)]
    bands.append(area.multiply(group_score(s6, GROUPS["forest"]).gte(FULL / 2)).rename("f50"))
    bands.append(area.multiply(group_score(s6, GROUPS["natural"]).gte(FULL / 2)).rename("n50"))
    return ee.Image.cat(bands + [key])


STATS_REDUCER = lambda: ee.Reducer.sum().repeat(8).group(groupField=8, groupName="key")


def empty_zone():
    return {"data_km2": 0.0, "hist": [[0.0] * NBINS for _ in range(6)], "soft": [0.0] * 6, "f50": 0.0, "n50": 0.0}


def add_groups(z, groups):
    """Fold one grouped reduction into a zone summary (soft Other land is filled in by finish())."""
    for g in groups:
        k, s = int(g["key"]), g["sum"]
        c, b = k // 100, k % 100
        if not 1 <= c <= 6 or not 0 <= b < NBINS:
            continue
        z["hist"][c - 1][b] += s[0]
        z["data_km2"] += s[0]
        for i in range(5):
            z["soft"][i] += s[1 + i]
        z["f50"] += s[6]
        z["n50"] += s[7]
    return z


def merge(a, b):
    out = empty_zone()
    for z in (a, b):
        out["data_km2"] += z["data_km2"]
        out["f50"] += z["f50"]
        out["n50"] += z["n50"]
        for c in range(6):
            out["soft"][c] += z["soft"][c]
            for i in range(NBINS):
                out["hist"][c][i] += z["hist"][c][i]
    return out


def finish(z, nd=5):
    """Soft Other land = data area minus the five expected areas; round for transport."""
    soft5 = sum(z["soft"][:5])
    z = {**z, "soft": z["soft"][:5] + [max(0.0, z["data_km2"] - soft5)]}
    r = lambda v: round(v, nd)
    return {"data_km2": r(z["data_km2"]), "hist": [[r(v) for v in row] for row in z["hist"]],
            "soft": [r(v) for v in z["soft"]], "f50": r(z["f50"]), "n50": r(z["n50"])}
