import json, os, subprocess, sys, time, urllib.request
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
FIXTURES = ROOT / "tests/fixtures"


def _up(url):
    try:
        with urllib.request.urlopen(url + "/api/meta", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


@pytest.fixture(scope="session")
def base_url():
    """MMFT_BASE_URL (e.g. the GitHub Pages site), else the running app on 8770, else a fresh one on 8771."""
    if os.environ.get("MMFT_BASE_URL"):
        yield os.environ["MMFT_BASE_URL"].rstrip("/")
        return
    if _up("http://127.0.0.1:8770"):
        yield "http://127.0.0.1:8770"
        return
    proc = subprocess.Popen([sys.executable, "run.py", "--no-browser", "--port", "8771"], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = "http://127.0.0.1:8771"
    for _ in range(90):
        if _up(url):
            break
        time.sleep(1)
    else:
        proc.kill()
        pytest.fail("the app did not start")
    yield url
    proc.terminate()


def post(base, path, body, timeout=600):
    req = urllib.request.Request(f"{base}/api/{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


@pytest.fixture(scope="session")
def expected_areas():
    return json.loads((FIXTURES / "expected.json").read_text())
