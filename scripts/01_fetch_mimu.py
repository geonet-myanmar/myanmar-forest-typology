"""Pull MIMU administrative boundaries (PCode v9.4) from the GeoNode GeoServer WFS into data/raw/mimu.

Falls back to the local copies in Downloads/tmp (same v9.4 schema) when the WFS is unreachable;
adm1 is then dissolved from the townships and adm0 from adm1.
"""
import json, sys
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/mimu"; RAW.mkdir(parents=True, exist_ok=True)
WFS = "https://geonode.themimu.info/geoserver/wfs"
LAYERS = {
    "adm0": "mmr_polbnda_adm0_250k_mimu_1",
    "adm1": "mmr_polbnda_adm1_250k_mimu_1",
    "adm2": "mmr_polbnda_adm2_250k_mimu",
    "adm3": "mmr_polbnda_adm3_250k_mimu_1",
}
EXPECT = {"adm0": 1, "adm1": 15, "adm2": 80, "adm3": 330}
LOCAL = {
    "adm2": Path.home() / "Downloads/tmp/MyanmarDistrictBoundaries.geojson",
    "adm3": Path.home() / "Downloads/tmp/MyanmarTownshipBoundaries.geojson",
}


def fetch(layer):
    p = dict(service="WFS", version="1.0.0", request="GetFeature", typeName=f"geonode:{layer}",
             outputFormat="application/json", srsName="EPSG:4326")
    r = requests.get(WFS, params=p, timeout=600)
    r.raise_for_status()
    return json.loads(r.content.decode("utf-8"))   # bytes -> UTF-8 explicitly (Myanmar names)


def dissolve(src, key_fields):
    import geopandas as gpd
    g = gpd.GeoDataFrame.from_features(src["features"], crs="EPSG:4326")
    d = g.dissolve(by=key_fields[0], as_index=False)[key_fields + ["geometry"]]
    return json.loads(d.to_json())


def main():
    got = {}
    for key, layer in LAYERS.items():
        f = RAW / f"{key}.geojson"
        if f.exists():
            got[key] = json.loads(f.read_text(encoding="utf-8"))
            continue
        try:
            js = fetch(layer)
            src = f"WFS {layer}"
        except Exception as e:                      # WFS down: use the local v9.4 copies
            print(f"{key}: WFS failed ({e}); using local fallback", file=sys.stderr)
            if key in LOCAL and LOCAL[key].exists():
                js = json.loads(LOCAL[key].read_text(encoding="utf-8"))
                src = str(LOCAL[key])
            elif key == "adm1" and "adm3" in got:
                js = dissolve(got["adm3"], ["ST_PCODE", "ST"])
                src = "dissolved from adm3"
            elif key == "adm0" and "adm1" in got:
                for ft in got["adm1"]["features"]:
                    ft["properties"]["_one"] = "MMR"
                js = dissolve(got["adm1"], ["_one"])
                src = "dissolved from adm1"
            else:
                raise
        f.write_text(json.dumps(js, ensure_ascii=False), encoding="utf-8")
        got[key] = js
        print(f"{key}: saved from {src}")
    for key, js in got.items():
        n = len(js["features"])
        flag = "" if n == EXPECT[key] else f"  <-- expected {EXPECT[key]}"
        print(f"{key}: {n} features, props {sorted(js['features'][0]['properties'])}{flag}")


if __name__ == "__main__":
    main()
