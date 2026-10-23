"""Earth Engine initialisation and a retrying call wrapper.

Locally this uses the stored user credentials. They carry no project, so the project is always passed
explicitly (a bare ee.Initialize() fails on this machine). Set EE_SERVICE_ACCOUNT_KEY (a path or the JSON
itself) to run under a service account when the app is hosted later.
"""
import json, logging, os, random, threading, time
import ee
from .config import EE_PROJECT

log = logging.getLogger("ee")
_lock = threading.Lock()
_ready = False


def init():
    global _ready
    with _lock:
        if _ready:
            return
        key = os.environ.get("EE_SERVICE_ACCOUNT_KEY", "").strip()
        if key:
            info = json.loads(key) if key.startswith("{") else json.loads(open(key, encoding="utf-8").read())
            creds = ee.ServiceAccountCredentials(info["client_email"], key_data=json.dumps(info))
            ee.Initialize(creds, project=EE_PROJECT)
            log.info("Earth Engine: service account %s, project %s", info["client_email"], EE_PROJECT)
        else:
            ee.Initialize(project=EE_PROJECT)
            log.info("Earth Engine: user credentials, project %s", EE_PROJECT)
        _ready = True


class EEError(RuntimeError):
    """An Earth Engine failure with a message fit to show in the UI."""


_RETRY = ("Too many concurrent", "rate limit", "429", "503", "Deadline", "temporarily", "Internal error")


def call(fn, *args, retries=4, **kwargs):
    """Run an Earth Engine call, retrying the transient failures with jittered backoff."""
    init()
    for attempt in range(retries + 1):
        try:
            return fn(*args, **kwargs)
        except ee.EEException as e:
            msg = str(e)
            if attempt < retries and any(s.lower() in msg.lower() for s in _RETRY):
                time.sleep(min(20, 1.5 * 2 ** attempt) * (0.7 + 0.6 * random.random()))
                continue
            raise EEError(friendly(msg)) from e


def friendly(msg):
    if "memory limit" in msg.lower():
        return f"Earth Engine ran out of memory for this area. Try a smaller area. ({msg})"
    if "timed out" in msg.lower():
        return f"Earth Engine timed out. Try a smaller area or fewer years. ({msg})"
    return msg
