"""Earth Engine: live statistics against the atlas, the argmax rule, tiles, the inspector and GeoTIFF grids."""
import io, json, urllib.request
import ee
import pytest
from app import aoi as A, forty as F, layers as Lr, media as Md, stats as S
from app.config import ATLAS, COLLECTION
from app.ee_client import init

pytestmark = pytest.mark.live


@pytest.fixture(scope="module", autouse=True)
def _ee():
    init()


def atlas():
    return json.loads(ATLAS.read_text(encoding="utf-8"))["townships"]


def test_live_township_matches_atlas():
    pc = "MMR013029"                                   # a small Yangon township: one piece
    z = F.finish(S.zone_stats(A.pieces(A.admin_feature(pc)["geometry"], by_township=False))["all"])
    ref = atlas()[pc]
    assert z["data_km2"] == pytest.approx(ref["data_km2"], abs=1e-4)
    for c in range(6):
        assert z["hist"][c] == pytest.approx(ref["hist"][c], abs=1e-4)


def test_drawn_copy_of_a_township_breaks_down_to_it():
    """A custom AOI equal to Taunggyi Township: its own zone holds ~all of it; neighbours get only edge slivers."""
    pc = "MMR014001"
    g = A.admin_feature(pc)["geometry"]
    out = S.aoi_stats(A.resolve({"kind": "geojson", "geometry": g, "name": "copy"}))
    ref = atlas()[pc]
    assert out["source"] == "live"
    assert out["zones"][pc]["data_km2"] == pytest.approx(ref["data_km2"], rel=1e-3)
    others = sum(z["data_km2"] for k, z in out["zones"].items() if k != pc)
    assert others < 0.002 * ref["data_km2"]


def test_argmax_equals_publisher_classification():
    g = ee.Geometry.Rectangle([96.35, 26.55, 96.45, 26.65])
    s6 = F.scores(g)
    cls, _ = F.class_and_top(s6)
    pub = ee.ImageCollection(COLLECTION.replace("_collection", "_classification")).filterBounds(g).mosaic()
    r = cls.eq(pub).reduceRegion(ee.Reducer.mean(), g, crs="EPSG:32647", crsTransform=S.GRID).getInfo()
    assert r["class"] == pytest.approx(1.0)


@pytest.mark.parametrize("lon,lat,cls", [(97.75, 16.2, 5), (96.4, 26.6, 1), (96.16, 16.8, 6)])
def test_point_inspector(lon, lat, cls):
    r = S.point(lon, lat)
    assert r["class"] == cls and sum(r["scores"]) == 250 and r["township"]


def test_point_in_open_sea_has_no_data():
    with pytest.raises(ValueError, match="No ForTy data"):
        S.point(94.0, 15.0)


@pytest.mark.parametrize("spec", [{"type": "class", "threshold": 0.7}, {"type": "class", "palette": "safe", "classes": [1, 2]},
                                  {"type": "score", "target": "natural"}, {"type": "score", "target": "5"},
                                  {"type": "confidence", "measure": "margin"}])
def test_layer_tiles_render(spec):
    r = Lr.map_url(spec)
    url = r["url"].format(z=10, x=784, y=454)            # Taunggyi area
    with urllib.request.urlopen(url, timeout=120) as resp:
        head = resp.read(4)                              # EE sends JPEG when a tile has no transparent pixel
        assert resp.status == 200 and (head.startswith(b"\x89PNG") or head.startswith(b"\xff\xd8"))


def test_download_is_on_the_native_grid():
    rasterio = pytest.importorskip("rasterio")
    import numpy as np
    a = A.resolve({"kind": "geojson", "geometry": {"type": "Polygon", "coordinates": [[[96.9, 20.5], [96.95, 20.5], [96.95, 20.55], [96.9, 20.55], [96.9, 20.5]]]}})
    plan = Md.download_plan(a, {"type": "class"})
    assert plan["crs"] == "EPSG:32647" and len(plan["chunks"]) == 1
    with urllib.request.urlopen(plan["chunks"][0]["url"], timeout=300) as resp:
        data = resp.read()
    with rasterio.MemoryFile(data) as mf, mf.open() as ds:
        assert ds.transform.a == 10 and ds.transform.c % 10 == 0 and ds.transform.f % 10 == 0
        v = set(np.unique(ds.read(1)).tolist())
    assert v <= {0, 1, 2, 3, 4, 5, 6} and len(v - {0}) >= 2
