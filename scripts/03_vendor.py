"""Vendor the pinned front-end libraries into web/vendor (no CDN at runtime) and record SHA-256s.

Versions are the newest releases that were at least two weeks old on 2026-10-21.
"""
import hashlib
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "web/vendor"
CDN = "https://cdn.jsdelivr.net/npm"
PKGS = {
    "leaflet@1.9.4": ["dist/leaflet.js", "dist/leaflet.css", "dist/images/layers.png", "dist/images/layers-2x.png",
                      "dist/images/marker-icon.png", "dist/images/marker-icon-2x.png", "dist/images/marker-shadow.png"],
    "@geoman-io/leaflet-geoman-free@2.20.2": ["dist/leaflet-geoman.min.js", "dist/leaflet-geoman.css"],
    "@tmcw/togeojson@7.1.2": ["dist/togeojson.umd.js"],
    "jszip@3.10.1": ["dist/jszip.min.js"],
    "shpjs@6.2.0": ["dist/shp.min.js"],
    "proj4@2.22.0": ["dist/proj4.js"],
    "@turf/turf@7.4.0": ["turf.min.js"],
    "topojson-client@3.1.0": ["dist/topojson-client.min.js"],
}


def main():
    lines = []
    for spec, files in PKGS.items():
        name = spec.rsplit("@", 1)[0].split("/")[-1]
        for f in files:
            dest = VENDOR / name / f.replace("dist/", "")
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists():
                r = requests.get(f"{CDN}/{spec}/{f}", timeout=120)
                r.raise_for_status()
                dest.write_bytes(r.content)
            h = hashlib.sha256(dest.read_bytes()).hexdigest()
            lines.append(f"{spec:42s} {f:36s} {dest.stat().st_size:>9,d}  sha256:{h}")
            print(lines[-1])
    (VENDOR / "VERSIONS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
