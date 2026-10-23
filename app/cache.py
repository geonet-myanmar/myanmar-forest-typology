"""In-memory TTL cache for short-lived Earth Engine URLs, and a disk cache for statistics."""
import hashlib, json, threading, time
from collections import OrderedDict
from .config import CACHE, ALGO_VERSION


def digest(*parts):
    raw = json.dumps([ALGO_VERSION, *parts], sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


class TTL:
    def __init__(self, ttl_s, maxsize=1024):
        self.ttl, self.maxsize = ttl_s, maxsize
        self._d, self._lock = OrderedDict(), threading.Lock()

    def get(self, key):
        with self._lock:
            hit = self._d.get(key)
            if not hit or hit[0] < time.time():
                self._d.pop(key, None)
                return None
            self._d.move_to_end(key)
            return hit[1]

    def set(self, key, value):
        with self._lock:
            self._d[key] = (time.time() + self.ttl, value)
            self._d.move_to_end(key)
            while len(self._d) > self.maxsize:
                self._d.popitem(last=False)
        return value


def disk_get(ns, key):
    f = CACHE / ns / f"{key}.json"
    if f.exists():
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except ValueError:
            return None
    return None


def disk_set(ns, key, value):
    d = CACHE / ns
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f"{key}.tmp"
    tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    tmp.replace(d / f"{key}.json")
    return value
