"""AOI resolution and validation (MIMU lookup, cleaning, Myanmar overlap, limits). No Earth Engine calls."""
import json
import pytest
from app import aoi as A
from conftest import FIXTURES


def box(w, s, e, n):
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def test_admin_township_uses_full_resolution_mimu():
    a = A.resolve({"kind": "admin", "pcode": "MMR001009"})
    assert a.name.startswith("Hpakant Township") and a.name_my == "ဖားကန့်"
    assert a.area_km2 == pytest.approx(5756.52, rel=1e-4)
    assert a.vertices > 1000 and a.level == 3


@pytest.mark.parametrize("pcode,level", [("MMR001", 1), ("MMR001D002", 2), ("MMR014002", 3)])
def test_admin_levels(pcode, level):
    assert A.resolve({"kind": "admin", "pcode": pcode}).level == level


def test_unknown_pcode():
    with pytest.raises(ValueError):
        A.resolve({"kind": "admin", "pcode": "MMR999"})


def test_geojson_inside_myanmar(expected_areas):
    g = json.loads((FIXTURES / "hpakant_4326.geojson").read_text())["features"][0]["geometry"]
    a = A.resolve({"kind": "geojson", "geometry": g, "name": "x"})
    assert a.area_km2 == pytest.approx(expected_areas["hpakant_4326.geojson"], rel=1e-3)
    assert a.inside_pct == 100.0 and not a.warnings


def test_outside_myanmar_rejected():
    with pytest.raises(ValueError, match="does not overlap Myanmar"):
        A.resolve({"kind": "geojson", "geometry": box(100.4, 13.6, 100.7, 13.9)})


def test_partly_outside_warns():
    a = A.resolve({"kind": "geojson", "geometry": box(98.3, 16.5, 98.8, 16.9)})   # Myawaddy - Mae Sot border
    assert 0 < a.inside_pct < 100 and any("outside Myanmar" in w for w in a.warnings)


def test_projected_coordinates_rejected():
    with pytest.raises(ValueError, match="longitude/latitude"):
        A.resolve({"kind": "geojson", "geometry": box(300000, 2800000, 310000, 2810000)})


def test_points_need_a_buffer():
    with pytest.raises(ValueError, match="buffer"):
        A.resolve({"kind": "geojson", "geometry": {"type": "Point", "coordinates": [96.1, 19.7]}})


def test_bowtie_is_repaired():
    bow = {"type": "Polygon", "coordinates": [[[96.0, 19.0], [96.2, 19.2], [96.2, 19.0], [96.0, 19.2], [96.0, 19.0]]]}
    a = A.resolve({"kind": "geojson", "geometry": bow})
    assert a.area_km2 > 100 and a.geometry["type"] in ("Polygon", "MultiPolygon")


RACE = r"""
import random, sys
from concurrent.futures import ThreadPoolExecutor
from shapely.prepared import prep
sys.path.insert(0, sys.argv[1])
from app import aoi as A
A._load()
def one(i):
    r = random.Random(i); x, y = 95 + r.random() * 3, 18 + r.random() * 5
    try:
        A.resolve({"kind": "geojson", "geometry": {"type": "Polygon",
                   "coordinates": [[[x, y], [x + .3, y], [x + .3, y + .3], [x, y + .3], [x, y]]]}})
    except ValueError:
        pass
for k in range(12):
    A._mm["prep"] = prep(A._mm["geom"]); A._resolved._d.clear()   # fresh, unbuilt GEOS index every round
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(one, range(k * 64, k * 64 + 64)))
"""


def test_concurrent_validation_does_not_crash(tmp_path):
    """Regression: GEOS prepared geometries are not thread-safe; parallel requests segfaulted the server."""
    import subprocess, sys
    from conftest import ROOT
    f = tmp_path / "race.py"
    f.write_text(RACE)
    assert subprocess.run([sys.executable, str(f), str(ROOT)], timeout=300).returncode == 0


def test_too_large_rejected():
    with pytest.raises(ValueError, match="limit"):
        A.resolve({"kind": "geojson", "geometry": box(92.5, 10.0, 101.0, 28.0)})
