"""Map layers: Earth Engine map IDs plus the legend the page draws for each.

The class map defaults to the publisher's palette (what the catalog and the paper show). It fails the colour-vision
checks (Planted vs Plantation forest, delta E 5.0 under protanopia), so a validated alternative is offered: it passes
all-pairs CVD (worst 8.2) and normal-vision (16.0) separation, with Other land as a neutral grey.
Score layers are one-hue ramps, light to dark, in the hue of the class they show.
"""
import ee
from . import forty as F
from .cache import TTL, digest
from .config import CLASSES, FULL, UNCERTAIN_COLOR
from .ee_client import call

RAMPS = {
    "green": ["#d9f0d3", "#a6dba0", "#5aae61", "#1b7837", "#00441b"],
    "blue": ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"],
    "magenta": ["#fbe0ef", "#f1a7cf", "#e065a8", "#b3337c", "#6e1450"],
    "amber": ["#fdefc3", "#f9d36b", "#e6ab02", "#a87a00", "#5f4500"],
    "sand": ["#f2eee2", "#d9d2bd", "#b1a789", "#7d735a", "#4a4433"],
}
TARGETS = {
    1: ("Primary forest", "green"), 2: ("Naturally regenerating forest", "green"), 3: ("Planted forest", "blue"),
    4: ("Plantation forest", "magenta"), 5: ("Tree crops & agroforestry", "amber"), 6: ("Other land", "sand"),
    "forest": ("All forest (classes 1–4)", "green"), "natural": ("Natural forest (classes 1–2)", "green"),
    "managed": ("Planted + plantation forest (classes 3–4)", "blue"),
}
_maps = TTL(45 * 60, 512)   # map IDs outlive this comfortably; the page also refreshes on tile errors


def palette(name):
    return [c["safe" if name == "safe" else "color"] for c in CLASSES]


def _target(t):
    if isinstance(t, str) and t.isdigit():
        t = int(t)
    if t not in TARGETS:
        raise ValueError(f"Unknown score layer {t!r}.")
    return t


def build(spec, aoi=None):
    """Return (ee.Image ready for getMapId / visualize, vis params, legend) for a layer spec."""
    t = spec.get("type")
    s6 = F.scores()
    if t == "class":
        pal = palette(spec.get("palette", "official"))
        show = sorted({int(c) for c in spec.get("classes", range(1, 7)) if 1 <= int(c) <= 6})
        if not show:
            raise ValueError("Choose at least one class to show.")
        thr = float(spec.get("threshold", 0))
        if not 0 <= thr < 1:
            raise ValueError("The confidence threshold must be between 0 and 1.")
        cls, top = F.class_and_top(s6)
        img = cls.updateMask(cls.remap(show, [1] * len(show), 0))
        items = [[pal[c - 1], CLASSES[c - 1]["name"]] for c in show]
        if thr > 0:
            sure = top.gte(round(thr * FULL))
            if spec.get("uncertain", "grey") == "grey":
                img = img.where(sure.Not(), 7)
                items.append([UNCERTAIN_COLOR, f"Uncertain (winning score < {thr:.2f})"])
            else:
                img = img.updateMask(sure)
        vis = {"min": 1, "max": 7, "palette": [p.lstrip("#") for p in pal] + [UNCERTAIN_COLOR.lstrip("#")]}
        title = "Forest type 2020" + (f" · score ≥ {thr:.2f}" if thr > 0 else " (highest score)")
        legend = {"kind": "categorical", "title": title, "items": items,
                  "masked": ("winning score below the threshold" if thr > 0 and spec.get("uncertain") == "hide" else "")}
    elif t == "score":
        tg = _target(spec.get("target", "forest"))
        name, ramp = TARGETS[tg]
        v = s6.select(tg - 1) if isinstance(tg, int) else F.group_score(s6, F.GROUPS[tg])
        lo = float(spec.get("min", 0.1))
        img = v.divide(FULL)
        img = img.updateMask(img.gte(lo))
        vis = {"min": lo, "max": 1, "palette": [c.lstrip("#") for c in RAMPS[ramp]]}
        legend = {"kind": "sequential", "title": f"Confidence score: {name}", "colors": RAMPS[ramp], "min": lo, "max": 1,
                  "masked": f"score < {lo:.2f}"}
    elif t == "confidence":
        cls, top = F.class_and_top(s6)
        if spec.get("measure") == "margin":
            img = F.margin(s6).divide(FULL)
            vis = {"min": 0, "max": 1, "palette": [c.lstrip("#") for c in RAMPS["blue"]]}
            legend = {"kind": "sequential", "title": "Winning margin (top score − runner-up)", "colors": RAMPS["blue"],
                      "min": 0, "max": 1, "low": "close call", "high": "clear"}
        else:
            img = top.divide(FULL)
            vis = {"min": 1 / 6, "max": 1, "palette": [c.lstrip("#") for c in RAMPS["blue"]]}
            legend = {"kind": "sequential", "title": "Winning class's score", "colors": RAMPS["blue"],
                      "min": 1 / 6, "max": 1, "low": "uncertain", "high": "confident"}
    else:
        raise ValueError(f"Unknown layer type {t!r}.")
    if spec.get("clip") and aoi is not None:
        img = img.clip(aoi.ee())
    return img, vis, legend


def map_url(spec, aoi=None):
    key = digest("map", spec, aoi.key if aoi and spec.get("clip") else None)
    hit = _maps.get(key)
    if hit:
        return hit
    img, vis, legend = build(spec, aoi)
    mid = call(img.getMapId, vis)
    return _maps.set(key, {"url": mid["tile_fetcher"].url_format, "legend": legend})
