"""Precompute native-resolution ForTy statistics for all 330 MIMU townships -> web/data/atlas.json.

The page answers every admin unit (township, district, State/Region, Union) from this file instantly, with no
Earth Engine cost, and draws the township/district/region choropleths from it. It uses app.stats, the same code
the API runs for drawn and uploaded areas. Each township is reduced over its own full-resolution polygon, cut by
UTM zone and into <= 2,000 km2 cells. Results are cached per township in data/raw/atlas/, so a rerun resumes.

    python scripts/04_build_atlas.py            # uses the stored Earth Engine login, project gee-python-419405
    python scripts/04_build_atlas.py --fresh    # ignore the per-township cache
"""
import argparse, json, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import aoi as A, forty as F, stats as S          # noqa: E402
from app.config import ATLAS, ALGO_VERSION, COLLECTION   # noqa: E402
from app.ee_client import init                            # noqa: E402

CACHE = ROOT / "data/raw/atlas"


def one(pcode, fresh):
    f = CACHE / f"{pcode}.json"
    if f.exists() and not fresh:
        d = json.loads(f.read_text(encoding="utf-8"))
        if d.get("algo_version") == ALGO_VERSION:
            return pcode, d["zone"], 0.0
    t0 = time.time()
    geom = A.admin_feature(pcode)["geometry"]
    pcs = A.pieces(geom, by_township=False)
    z = S.zone_stats(pcs, workers=6).get("all", F.empty_zone())
    z = F.finish(z)
    f.write_text(json.dumps({"algo_version": ALGO_VERSION, "pieces": len(pcs), "zone": z}), encoding="utf-8")
    return pcode, z, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--workers", type=int, default=5)
    args = ap.parse_args()
    init()
    CACHE.mkdir(parents=True, exist_ok=True)
    A._load()
    pcodes = sorted(A._ts["pcodes"], key=lambda p: -A.township_props(p)["area_km2"])   # big ones first
    out, t0 = {}, time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(one, p, args.fresh): p for p in pcodes}
        for i, fu in enumerate(as_completed(futs), 1):
            p = futs[fu]
            try:
                pc, z, dt = fu.result()
            except Exception as e:                 # report and carry on; a rerun picks up the rest
                print(f"[{i:3d}/{len(pcodes)}] {p} FAILED: {e}", flush=True)
                continue
            out[pc] = z
            pr = A.township_props(pc)
            gap = pr["area_km2"] - z["data_km2"]
            print(f"[{i:3d}/{len(pcodes)}] {pc} {pr['name_en']:<22s} {pr['area_km2']:9,.1f} km2  data {z['data_km2']:9,.1f}"
                  f"  no-data {gap:8,.2f}  {dt:5.1f}s  (elapsed {time.time() - t0:5.0f}s)", flush=True)
    missing = [p for p in pcodes if p not in out]
    if missing:
        print(f"{len(missing)} townships failed; rerun to retry: {missing}")
        return 1
    atlas = {"algo_version": ALGO_VERSION, "collection": COLLECTION,
             "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
             "method": "Sum over each MIMU township polygon on the native 10 m UTM grid (EPSG:32646 west of 96 E, "
                       "32647 east); edge pixels weighted by coverage; pixelArea km2.",
             "townships": {p: out[p] for p in sorted(out)}}
    ATLAS.write_text(json.dumps(atlas, separators=(",", ":")), encoding="utf-8")
    tot = sum(z["data_km2"] for z in out.values())
    print(f"wrote {ATLAS.relative_to(ROOT)} ({ATLAS.stat().st_size / 1e6:.2f} MB); mapped {tot:,.0f} km2 in "
          f"{time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
