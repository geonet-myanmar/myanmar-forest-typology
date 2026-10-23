"""Map images (Earth Engine thumbnails the page finishes with title, legend and scale) and native-grid GeoTIFFs.

Downloads are cut on the native 10 m UTM grid of the AOI's centre into chunks under Earth Engine's request budget
(2 bytes per uint8 band per pixel, measured), with a VRT that mosaics them back together.
"""
import math
from concurrent.futures import ThreadPoolExecutor
from xml.sax.saxutils import escape
import ee
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform as shp_transform
from . import aoi as A, forty as F, layers as Lr
from .cache import TTL, digest
from .config import MAX_REQUEST_PX, EE_REQUEST_BYTES, FULL, SCALE_M
from .ee_client import call

R = 6378137.0
PRESETS = {"4k": 3840, "1440p": 2560, "1080p": 1920, "720p": 1280}
ASPECTS = {"16:9": 16 / 9, "1:1": 1.0, "4:5": 0.8, "4:3": 4 / 3, "a4l": 297 / 210, "a4p": 210 / 297}
_urls = TTL(100 * 60, 256)   # EE thumbnail and download tokens last 2 h


def merc(lon, lat):
    lat = max(min(lat, 85.0), -85.0)
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def inv_merc(x, y):
    return math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)


def _even(n):
    return max(2, int(n) // 2 * 2)


def frame_plan(aoi, preset="1440p", aspect="auto", margin=0.05):
    x0, y0 = merc(aoi.bbox[0], aoi.bbox[1])
    x1, y1 = merc(aoi.bbox[2], aoi.bbox[3])
    w, h = (x1 - x0) * (1 + 2 * margin), (y1 - y0) * (1 + 2 * margin)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    a = ASPECTS.get(aspect) or min(max(w / h, 0.6), 1.8)
    if w / h < a:
        w = h * a
    else:
        h = w / a
    s = max(w, h) / PRESETS.get(preset, 2560)
    if (w / s) * (h / s) > MAX_REQUEST_PX:
        s = math.sqrt(w * h / MAX_REQUEST_PX)
    W, H = _even(round(w / s)), _even(round(h / s))
    w, h = W * s, H * s
    lat_c = inv_merc(cx, cy)[1]
    return {"region": [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], "width": W, "height": H, "scale": s,
            "ground_m": s * math.cos(math.radians(lat_c)), "lat": lat_c}


def _rect(region):
    return ee.Geometry.Rectangle(region, "EPSG:3857", False)


def _backdrop():
    """Sea blue, land as a pale hillshade (SRTM), so the class map reads without a basemap."""
    sea = ee.Image.constant([210, 223, 229]).visualize(min=0, max=255)
    dem = ee.Image("USGS/SRTMGL1_003")
    hill = ee.Terrain.hillshade(dem).visualize(min=60, max=255, palette=["9a9d96", "f4f3ee"])
    return sea.blend(hill)


def layer_thumb(aoi, spec, preset="1440p", aspect="auto", opacity=0.9):
    plan = frame_plan(aoi, preset, aspect)
    key = digest("thumb", aoi.key, spec, plan["width"], plan["height"], plan["region"], opacity)
    hit = _urls.get(key)
    if hit:
        return hit
    img, vis, legend = Lr.build({**spec, "clip": False}, aoi)
    inside = ee.Image(1).clip(aoi.ee()).unmask(0)
    dim = ee.Image(0).visualize(palette=["15201b"], opacity=0.42).updateMask(inside.Not())
    layer = img.clip(aoi.ee()).visualize(**vis, opacity=float(opacity))
    fc = ee.FeatureCollection([ee.Feature(aoi.ee())])
    halo = ee.Image().byte().paint(fc, 1, 4).visualize(palette=["15201b"], opacity=0.5)
    edge = ee.Image().byte().paint(fc, 1, 2).visualize(palette=["ffffff"])
    comp = _backdrop().blend(dim).blend(layer).blend(halo).blend(edge)
    url = call(comp.getThumbURL, {"region": _rect(plan["region"]), "dimensions": f"{plan['width']}x{plan['height']}",
                                  "crs": "EPSG:3857", "format": "png"})
    return _urls.set(key, {**plan, "url": url, "legend": legend})


# ---------- GeoTIFF downloads ----------
def _download_image(spec, aoi):
    s6 = F.scores(aoi.ee())
    kind = spec.get("type", "class")
    if kind == "class":
        cls, _ = F.class_and_top(s6)
        return cls.clip(aoi.ee()).unmask(0).toUint8(), 1, "forty2020_class", ["class"]
    if kind == "scores":
        names = ["primary", "natural_regen", "planted", "plantation", "tree_crops", "other_land"]
        return s6.rename(names).clip(aoi.ee()).unmask(255).toUint8(), 6, "forty2020_scores", names
    if kind == "confidence":
        _, top = F.class_and_top(s6)
        return top.addBands(F.margin(s6)).rename(["top", "margin"]).clip(aoi.ee()).unmask(255).toUint8(), 2, \
            "forty2020_confidence", ["top", "margin"]
    raise ValueError(f"Unknown download {kind!r}.")


def utm_bounds(aoi, epsg):
    with A.GEOS_LOCK:
        tr = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
        g = shp_transform(tr.transform, shape(aoi.geometry))
        return g.bounds


def chunk_grid(bounds, bytes_per_px, s=SCALE_M):
    """Cover the UTM bounds with whole native pixels on the 10 m lattice, split into tiles under the request budget."""
    minx, miny, maxx, maxy = bounds
    x0, x1 = math.floor(minx / s) * s, math.ceil(maxx / s) * s
    y0, y1 = math.floor(miny / s) * s, math.ceil(maxy / s) * s
    cols, rows = int(round((x1 - x0) / s)), int(round((y1 - y0) / s))
    tile = int(math.sqrt((EE_REQUEST_BYTES * 0.95) / bytes_per_px)) // 256 * 256
    chunks = []
    for rr in range(0, rows, tile):
        for cc in range(0, cols, tile):
            w, h = min(tile, cols - cc), min(tile, rows - rr)
            chunks.append({"col": cc, "row": rr, "width": w, "height": h,
                           "transform": [s, 0, x0 + cc * s, 0, -s, y1 - rr * s]})
    return chunks, cols, rows, x0, y1


def download_plan(aoi, spec):
    img, nb, base, names = _download_image(spec, aoi)
    lon_c = (aoi.bbox[0] + aoi.bbox[2]) / 2
    epsg = A.utm_epsg(lon_c)
    chunks, cols, rows, gx0, gy0 = chunk_grid(utm_bounds(aoi, epsg), 2 * nb)
    if len(chunks) > 400:
        raise ValueError(f"{len(chunks)} files would be needed at native 10 m; pick a smaller area or fewer bands.")
    key = digest("dl", aoi.key, spec)
    hit = _urls.get(key)
    if hit:
        return hit
    name_of = lambda i: f"{base}_{i + 1:03d}" if len(chunks) > 1 else base

    def one(ic):
        i, c = ic
        url = call(img.getDownloadURL, {"name": name_of(i), "crs": f"EPSG:{epsg}", "crs_transform": c["transform"],
                                        "dimensions": f"{c['width']}x{c['height']}", "format": "GEO_TIFF"})
        return {**c, "url": url, "file": name_of(i) + ".tif"}

    with ThreadPoolExecutor(max_workers=8) as ex:
        out = list(ex.map(one, enumerate(chunks)))
    spans = lon_c < 96 < aoi.bbox[2] or aoi.bbox[0] < 96 < lon_c
    return _urls.set(key, {
        "name": base, "crs": f"EPSG:{epsg}", "scale": SCALE_M, "bands": names, "cols": cols, "rows": rows,
        "nodata": 0 if nb == 1 else 255, "chunks": out,
        "note": ("The area crosses 96° E, so the part in the other UTM zone is resampled (nearest neighbour) onto this grid."
                 if spans else ""),
        "vrt": vrt(out, cols, rows, gx0, gy0, nb, epsg, names, 0 if nb == 1 else 255) if len(out) > 1 else None})


def vrt(chunks, cols, rows, x0, y0, nb, epsg, names, nodata):
    out = [f'<VRTDataset rasterXSize="{cols}" rasterYSize="{rows}">', f"  <SRS>EPSG:{epsg}</SRS>",
           f"  <GeoTransform>{x0!r}, {SCALE_M!r}, 0, {y0!r}, 0, {-SCALE_M!r}</GeoTransform>"]
    for b in range(1, nb + 1):
        out.append(f'  <VRTRasterBand dataType="Byte" band="{b}">')
        out.append(f"    <Description>{escape(names[b - 1])}</Description>")
        out.append(f"    <NoDataValue>{nodata}</NoDataValue>")
        for c in chunks:
            out.append(f'    <SimpleSource><SourceFilename relativeToVRT="1">{escape(c["file"])}</SourceFilename>'
                       f"<SourceBand>{b}</SourceBand>"
                       f'<SrcRect xOff="0" yOff="0" xSize="{c["width"]}" ySize="{c["height"]}"/>'
                       f'<DstRect xOff="{c["col"]}" yOff="{c["row"]}" xSize="{c["width"]}" ySize="{c["height"]}"/></SimpleSource>')
        out.append("  </VRTRasterBand>")
    out.append("</VRTDataset>")
    return "\n".join(out)
