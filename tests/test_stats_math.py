"""Piece cutting, zone folding, the atlas and the MIMU hierarchy. No Earth Engine calls."""
import json
import pytest
from shapely.geometry import shape
from app import aoi as A, forty as F
from app.config import ATLAS, MIMU, NBINS
from conftest import FIXTURES


def box(w, s, e, n):
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def test_pieces_tile_the_area_across_townships_and_utm_zones():
    g = box(95.9, 21.9, 96.15, 22.1)                  # Mandalay / Sagaing, straddles 96 E
    pcs = A.pieces(g)
    total = sum(A.area_km2(shape(p[2])) for p in pcs)
    assert total == pytest.approx(A.area_km2(shape(g)), rel=1e-3)
    assert {p[1] for p in pcs} == {32646, 32647}
    for zone, epsg, gj in pcs:
        lon = shape(gj).centroid.x
        assert epsg == (32646 if lon < 96 else 32647)
    assert len({p[0] for p in pcs}) >= 5


def test_big_township_is_cut_into_cells():
    g = A.admin_feature("MMR001009")["geometry"]           # Hpakant, 5,757 km2
    pcs = A.pieces(g, by_township=False)
    assert len(pcs) >= 3 and all(A.area_km2(shape(p[2])) < 2000 * 1.6 for p in pcs)
    assert sum(A.area_km2(shape(p[2])) for p in pcs) == pytest.approx(5756.52, rel=1e-3)


def test_outside_part_is_its_own_zone():
    pcs = A.pieces(box(98.3, 16.5, 98.8, 16.9))           # Myawaddy - Mae Sot
    assert "outside" in {p[0] for p in pcs}


def test_fold_groups():
    z = F.empty_zone()
    F.add_groups(z, [{"key": 119, "sum": [2.0, 1.9, 0.05, 0, 0, 0, 2.0, 2.0]},
                     {"key": 603, "sum": [1.0, 0.1, 0.1, 0, 0, 0.1, 0, 0]}])
    out = F.finish(z)
    assert out["data_km2"] == 3.0
    assert out["hist"][0][19] == 2.0 and out["hist"][5][3] == 1.0
    assert out["soft"][:5] == [2.0, 0.15, 0, 0, 0.1]
    assert out["soft"][5] == pytest.approx(0.75)
    assert out["f50"] == 2.0 and out["n50"] == 2.0


def test_states_are_normalised_for_shan_and_bago():
    """MIMU districts/townships name sub-states (Shan North = MMR015, Bago East = MMR007, ...)."""
    states = {f["properties"]["pcode"] for f in json.loads((MIMU / "adm1.geojson").read_text(encoding="utf-8"))["features"]}
    for lv in (2, 3):
        for f in json.loads((MIMU / f"adm{lv}.geojson").read_text(encoding="utf-8"))["features"]:
            assert f["properties"]["st_pcode"] in states, f["properties"]["pcode"]
    assert len(A.townships_of("MMR222")) == 55 and len(A.townships_of("MMR111")) == 28
    assert len(A.townships_of("MMR")) == 330


def test_shan_district_name_keeps_the_sub_state():
    a = A.resolve({"kind": "admin", "pcode": "MMR014D001"})
    assert a.name == "Taunggyi District, Shan (South)"
    assert A.resolve({"kind": "admin", "pcode": "MMR001"}).name == "Kachin State"


def test_atlas_covers_every_township_at_full_area():
    at = json.loads(ATLAS.read_text(encoding="utf-8"))
    assert len(at["townships"]) == 330
    for pc, z in at["townships"].items():
        area = A.township_props(pc)["area_km2"]
        assert z["data_km2"] == pytest.approx(area, rel=0.005, abs=0.05), pc     # worst: Bilin, 0.3% coastal gap
        assert len(z["hist"]) == 6 and all(len(r) == NBINS for r in z["hist"])
        assert sum(z["soft"]) == pytest.approx(z["data_km2"], abs=1e-3)          # values are rounded to 1e-5 km2
        assert sum(map(sum, z["hist"])) == pytest.approx(z["data_km2"], abs=1e-3)


def test_atlas_national_totals():
    at = json.loads(ATLAS.read_text(encoding="utf-8"))
    land = sum(z["data_km2"] for z in at["townships"].values())
    cls = [sum(sum(z["hist"][c]) for z in at["townships"].values()) for c in range(6)]
    assert land == pytest.approx(668_607, rel=1e-4)
    assert 100 * sum(cls[:4]) / land == pytest.approx(63.9, abs=0.1)
    assert cls[2] < 1                                    # ForTy maps no planted forest inside Myanmar


def test_fixture_shapes_resolve(expected_areas):
    g = json.loads((FIXTURES / "hpakant_4326.geojson").read_text())["features"][0]["geometry"]
    a = A.resolve({"kind": "geojson", "geometry": g})
    pcs = A.pieces(a.geometry)
    assert sum(A.area_km2(shape(p[2])) for p in pcs) == pytest.approx(expected_areas["hpakant_4326.geojson"], rel=2e-3)
