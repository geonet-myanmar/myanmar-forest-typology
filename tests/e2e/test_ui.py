"""The app in the installed Chrome: admin picker (incl. Shan), uploads, live stats, threshold, inspector, exports."""
import pytest
from conftest import FIXTURES

pytestmark = pytest.mark.e2e
pw = pytest.importorskip("playwright.sync_api")


@pytest.fixture(scope="module")
def page(base_url):
    with pw.sync_playwright() as p:
        b = p.chromium.launch(channel="chrome")
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(base_url + "/#tab=area")
        pg.wait_for_selector("#sel-st option[value=MMR222]", state="attached")
        pg.errors = errors
        yield pg
        b.close()


def live_done(pg):
    pg.wait_for_function("document.querySelector('#an-status').innerText.includes('Computed live')", timeout=240_000)


def test_shan_cascade_and_atlas(page):
    page.select_option("#sel-st", "MMR222")
    assert page.eval_on_selector_all("#sel-dt option", "o => o.length") == 17      # 16 districts + placeholder
    page.click("#adminuse")
    page.wait_for_function("document.querySelector('#an-status').innerText.includes('55 townships')")
    assert "155,715" in page.inner_text("#an-tiles")
    page.click("#bdlevel button[data-lv='2']")
    assert page.eval_on_selector_all("#bdtable tbody tr", "r => r.length") == 16


def test_threshold_moves_area_to_uncertain(page):
    before = page.inner_text("#an-table")
    page.evaluate("const t = document.querySelector('#thr2'); t.value = 0.8; t.dispatchEvent(new Event('input'))")
    assert "Uncertain" in page.inner_text("#an-table") and page.inner_text("#an-table") != before
    assert page.input_value("#thr") == "0.8"
    page.evaluate("const t = document.querySelector('#thr2'); t.value = 0; t.dispatchEvent(new Event('input'))")


@pytest.mark.parametrize("files,expect", [(["nyaungshwe.kmz"], "Nyaungshwe"), (["nyaungshwe.kml"], "Nyaungshwe"),
                                          (["taunggyi_pair_shp.zip"], "2 features"), (["hpakant_4326.geojson"], "")])
def test_upload_formats(page, files, expect, expected_areas):
    page.click("button[data-tab=area]")
    page.click("#aoimode button[data-mode=upload]")
    page.set_input_files("#fileinput", [str(FIXTURES / f) for f in files])
    page.wait_for_selector("#useupload")
    page.click("#useupload")
    page.wait_for_function("document.querySelector('#uploadstep').innerText.includes('Using')", timeout=60_000)
    live_done(page)
    assert expect in page.inner_text("#aoichip")
    area = expected_areas[files[0]]
    land = float(page.inner_text("#an-tiles .tile:nth-child(4) .tv").replace(",", "").split()[0])
    assert land == pytest.approx(area, rel=0.01)


def test_loose_shapefile_set(page):
    page.click("button[data-tab=area]")
    page.click("#aoimode button[data-mode=upload]")
    page.set_input_files("#fileinput", [str(p) for p in (FIXTURES / "loose").iterdir()])
    page.wait_for_selector("#useupload")
    assert "2 polygon features" in page.inner_text("#uploadstep")


def test_projected_geojson_without_crs_asks(page):
    page.click("button[data-tab=area]")
    page.click("#aoimode button[data-mode=upload]")
    page.set_input_files("#fileinput", str(FIXTURES / "hpakant_utm_nocrs.geojson"))
    page.wait_for_selector("#crspick")
    page.select_option("#crspick", "EPSG:32647")
    page.click("#crsgo")
    page.wait_for_selector("#useupload")


def test_drawn_rectangle(page):
    page.click("button[data-tab=area]")
    page.click("#aoimode button[data-mode=draw]")
    page.click("[data-draw=Rectangle]")
    page.mouse.click(420, 380)                     # Geoman rectangles: click a corner, then the opposite one
    page.mouse.move(520, 460, steps=6)
    page.mouse.click(520, 460)
    page.wait_for_function("document.querySelector('#aoichip').innerText.includes('Drawn')", timeout=30_000)
    live_done(page)


def test_inspector_and_exports(page):
    page.click("button[data-tab=map]")
    page.mouse.click(470, 420)
    page.wait_for_selector(".pxbars", timeout=60_000)
    assert page.eval_on_selector_all(".pxrow", "r => r.length") == 6
    with page.expect_download(timeout=180_000) as dl:
        page.click("#img-save")
    assert dl.value.suggested_filename.endswith(".png")
    page.click("button[data-tab=analyze]")
    for btn in ("#dl-csv", "#dl-bdcsv", "#dl-json"):
        with page.expect_download() as dl:
            page.click(btn)
        assert dl.value.suggested_filename.endswith((".csv", ".json"))
    page.click("[data-tif=scores]")
    page.wait_for_selector(".dl-list a", timeout=120_000)
    assert "EPSG:326" in page.inner_text("#modalbody")
    page.click("#modalclose")
    assert not page.errors
