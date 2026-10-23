"""FastAPI app: JSON API under /api, plus the static page from web/ when run locally.

Hosted, the page is on GitHub Pages and this app is the API only (CORS allows the Pages origin).
"""
import logging, time
from collections import deque
from typing import Optional
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from . import aoi as A, layers as Lr, media as Md, stats as S
from .config import (WEB, SERVE_WEB, CORS_ORIGINS, CLASSES, UNCERTAIN_COLOR, NBINS, ATTRIBUTION, CITATION, CATALOG_URL,
                     MIMU_CREDIT, ALGO_VERSION, EE_PROJECT, COLLECTION, AOI_WARN_KM2, AOI_MAX_KM2)
from .ee_client import EEError, init

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = FastAPI(title="Myanmar Forest Typology Explorer", docs_url="/api/docs", openapi_url="/api/openapi.json")
RATE_PER_MIN = 120          # per client IP
_hits: dict = {}


@app.middleware("http")
async def _rate_limit(request: Request, call_next):
    """Every request spends the project's Earth Engine quota, so damp runaway clients (per instance)."""
    if request.method == "POST" and request.url.path.startswith("/api/"):
        ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0].strip()
        now = time.time()
        if len(_hits) > 5000:
            _hits.clear()
        q = _hits.setdefault(ip, deque())
        while q and q[0] < now - 60:
            q.popleft()
        if len(q) >= RATE_PER_MIN:
            return JSONResponse({"detail": "Too many requests from this address; wait a minute and try again."}, status_code=429)
        q.append(now)
    return await call_next(request)


app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST"],
                   allow_headers=["content-type"], max_age=86400)    # outermost, so 4xx answers carry CORS too


@app.exception_handler(ValueError)
async def _bad_request(_: Request, e: ValueError):
    return JSONResponse({"detail": str(e)}, status_code=400)


@app.exception_handler(EEError)
async def _ee_failed(_: Request, e: EEError):
    return JSONResponse({"detail": f"Earth Engine: {e}"}, status_code=502)


class AoiBody(BaseModel):
    aoi: dict


class LayerBody(BaseModel):
    layer: dict
    aoi: Optional[dict] = None


class PointBody(BaseModel):
    lon: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-85, le=85)


class ThumbBody(AoiBody):
    layer: dict
    preset: str = "1440p"
    aspect: str = "auto"
    opacity: float = Field(0.9, ge=0.2, le=1)


class DownloadBody(AoiBody):
    kind: str = "class"


@app.on_event("startup")
def _startup():
    init()


@app.get("/api/meta")
def meta():
    return {"classes": CLASSES, "uncertain_color": UNCERTAIN_COLOR, "nbins": NBINS, "attribution": ATTRIBUTION,
            "citation": CITATION, "catalog": CATALOG_URL, "collection": COLLECTION, "mimu": MIMU_CREDIT,
            "algo_version": ALGO_VERSION, "project": EE_PROJECT, "palettes": {"official": Lr.palette("official"),
                                                                              "safe": Lr.palette("safe")},
            "limits": {"aoi_warn_km2": AOI_WARN_KM2, "aoi_max_km2": AOI_MAX_KM2},
            "presets": list(Md.PRESETS), "aspects": ["auto", *Md.ASPECTS]}


@app.post("/api/aoi")
def aoi_check(body: AoiBody):
    a = A.resolve(body.aoi)
    return a.public(with_geometry=a.kind != "admin")


@app.get("/api/admin/{pcode}")
def admin_geometry(pcode: str):
    f = A.admin_feature(pcode)
    if not f:
        raise HTTPException(404, f"Unknown PCode {pcode}")
    return f


@app.post("/api/layer")
def layer(body: LayerBody):
    return Lr.map_url(body.layer, A.resolve(body.aoi) if body.aoi else None)


@app.post("/api/stats")
def stats(body: AoiBody):
    return S.aoi_stats(A.resolve(body.aoi))


@app.post("/api/point")
def point(body: PointBody):
    return S.point(body.lon, body.lat)


@app.post("/api/thumb")
def thumb(body: ThumbBody):
    if body.preset not in Md.PRESETS:
        raise ValueError(f"Unknown size {body.preset!r}")
    return Md.layer_thumb(A.resolve(body.aoi), body.layer, body.preset, body.aspect, body.opacity)


@app.post("/api/download")
def download(body: DownloadBody):
    return Md.download_plan(A.resolve(body.aoi), {"type": body.kind})


if SERVE_WEB:
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
else:
    @app.get("/", include_in_schema=False)
    def root():
        return {"service": "Myanmar Forest Typology Explorer API",
                "app": "https://geonet-myanmar.github.io/myanmar-forest-typology/", "docs": "/api/docs"}
