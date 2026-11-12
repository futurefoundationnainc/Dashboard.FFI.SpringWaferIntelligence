"""Wafer Map page: iXML file names, the newest-first (LIFO) share search, 3D die-level
exports, layout matching and the /api/wafermap + layout-revision endpoints."""
from __future__ import annotations

import io
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

import app as app_module
from engine import CloudPcsAdapterError, parse_cloudpcs_export
from tests.test_xml_adapter import build_cloudpcs_xml, make_rows
from wafermap import LocalDirSource, Locator, WaferNotFound, normalize_sample, parse_ixml_name
from wafermap.settings import Settings

client = TestClient(app_module.app)
TODAY = date(2026, 11, 12)

NAME_2D = "iXML#1851_WaferYield_DefectMonitor_2026_11_11_T_23_39_41_3941_MsgId_MET_W3057621_2026_11_11T12_03_57275Z.xml"
NAME_3D = "iXML#1852_3D_YIELD_MONITOR_2026_11_11_T_23_44_05_445_MsgId_MET_W3059214_2026_11_11T12_04_23598Z.xml"

DIE_COLUMNS = [
    "REGION", "TECHNOLOGY", "PROCESS", "PRODUCT", "PRODUCTGROUP", "SAMPLEID", "LOT_REJECT_CODE", "PRODUCTTYPE", "DIE_NUM",
    "DIE_LOC_X", "DIE_LOC_Y", "DIE_GRADE", "DIE_SCRAP_STAGE", "FARM_DIE", "FPW", "DPW", "NUM_SPRINGS_PER_SUBDIE",
    "DEFECT_CODE", "COMMENTS", "UPLOAD_TIMESTAMP", "DATACOLLECTIONDISPOSITION",
]


def die_rows(sample="W305463.5", product="159-501160A", group="SEQUOIA I", dies=range(1, 9), scrap=(6, 7), farm=(1, 2)) -> list[dict]:
    rows = []
    for d in dies:
        bad = d in scrap
        rows.append({
            "REGION": "Livermore", "TECHNOLOGY": "T11.6P", "PROCESS": "4595SDBANK", "PRODUCT": product, "PRODUCTGROUP": group,
            "SAMPLEID": sample, "LOT_REJECT_CODE": "NA", "PRODUCTTYPE": "B", "DIE_NUM": str(d), "DIE_LOC_X": "", "DIE_LOC_Y": "",
            "DIE_GRADE": "SCRAP" if bad else "A_DIE", "DIE_SCRAP_STAGE": "38080SPIN" if bad else "null",
            "FARM_DIE": "F" if d in farm else "D", "FPW": str(len(farm)), "DPW": str(len(dies) - len(farm)),
            "NUM_SPRINGS_PER_SUBDIE": "300", "DEFECT_CODE": ("UD" if d == 6 else "null") if bad else "null",
            "COMMENTS": "", "UPLOAD_TIMESTAMP": "2026-31-10T04:49:19.000Z", "DATACOLLECTIONDISPOSITION": "SUCCESS",
        })
    return rows


def die_xml(**kw) -> bytes:
    sample = kw.get("sample", "W305463.5")
    return build_cloudpcs_xml(die_rows(**kw), columns=DIE_COLUMNS, header={"TRANSACTIONID": f"MET_{sample}_2026-31-10T22:00:28.770Z"})


def ixml_name(counter: int, plan_token: str, ts: datetime, sample: str) -> str:
    return (f"iXML#{counter}_{plan_token}_{ts:%Y_%m_%d_T_%H_%M_%S}_{ts.minute}{ts.second}"
            f"_MsgId_MET_{normalize_sample(sample)}_{ts:%Y_%d_%m}T{ts:%H_%M}_00000Z.xml")


def put(share: Path, day: date, name: str, payload: bytes) -> None:
    folder = share / "risa" / f"{day:%Y}" / f"{day:%Y_%m_%d}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(payload)


def make_locator(tmp_path: Path, lookback: int = 30) -> Locator:
    settings = Settings(source="local", sas_url="", share="api-fileshare", root="risa", local_dir=tmp_path / "share",
                        lookback_days=lookback, cache_dir=tmp_path / "cache", live_ttl_seconds=0, prewarm_days=0)
    return Locator(settings, LocalDirSource(settings.local_dir), today=lambda: TODAY)


# --------------------------------------------------------------------------- file names
def test_parse_customer_file_names():
    two = parse_ixml_name(NAME_2D)
    assert (two.plan, two.sample, two.counter, two.timestamp) == ("2d", "W3057621", 1851, datetime(2026, 11, 11, 23, 39, 41))
    three = parse_ixml_name(NAME_3D)
    assert (three.plan, three.sample, three.timestamp) == ("3d", "W3059214", datetime(2026, 11, 11, 23, 44, 5))
    # the ingest's second copy has no DataCollectionPlan token and must never match
    assert parse_ixml_name("iXML#1851_2026_11_11_T_23_39_41_3941_MsgId_MET_W3057621_2026_11_11T12_03_57275Z.xml") is None
    assert parse_ixml_name("iXML#9_OTHER_PLAN_2026_11_11_T_23_39_41_3941_MsgId_MET_W3057621_x.xml") is None
    assert normalize_sample("w305762.1") == "W3057621"


# --------------------------------------------------------------------------- LIFO search
def test_newest_day_wins_and_search_stops(tmp_path: Path):
    share = tmp_path / "share"
    put(share, date(2026, 11, 1), ixml_name(5, "3D_YIELD_MONITOR", datetime(2026, 11, 1, 9, 0, 0), "W305463.5"), die_xml(scrap=(6,)))
    put(share, date(2026, 11, 10), ixml_name(7, "3D_YIELD_MONITOR", datetime(2026, 11, 10, 8, 0, 0), "W305463.5"), die_xml(scrap=(6, 7, 8)))
    put(share, date(2026, 11, 10), ixml_name(6, "3D_YIELD_MONITOR", datetime(2026, 11, 10, 7, 0, 0), "W305463.5"), die_xml(scrap=()))
    locator = make_locator(tmp_path)
    located, export = locator.locate_and_load("W305463.5", "3d")
    assert located.folder == "risa/2026/2026_11_10" and located.counter == 7 and located.candidates_in_folder == 2
    assert located.folders_scanned == 4  # 11-13 (ahead), 11-12, 11-11 (empty), then 11-10
    assert int(export.frame.Status.ne("Good").sum()) == 3
    # the older day's file is never opened: the search stopped at the newest day
    assert not any("2026_11_01" in p.name for p in (tmp_path / "cache" / "parsed").iterdir())


def test_same_second_uses_counter_and_plan_filter(tmp_path: Path):
    share = tmp_path / "share"
    ts = datetime(2026, 11, 11, 10, 0, 0)
    put(share, date(2026, 11, 11), ixml_name(10, "3D_YIELD_MONITOR", ts, "W305463.5"), die_xml(scrap=()))
    put(share, date(2026, 11, 11), ixml_name(11, "3D_YIELD_MONITOR", ts, "W305463.5"), die_xml(scrap=(6,)))
    put(share, date(2026, 11, 9), ixml_name(3, "WaferYield_DefectMonitor", ts, "W305463.5"), build_cloudpcs_xml(make_rows(sample="W305463.5")))
    locator = make_locator(tmp_path)
    located, _ = locator.locate_and_load("W305463.5", "3d")
    assert located.counter == 11
    located, export = locator.locate_and_load("W305463.5", "2d")
    assert located.plan == "2d" and export.level == "spring"
    located, _ = locator.locate_and_load("W305463.5", None)  # both plans: the newest overall
    assert located.plan == "3d"


def test_dot_collision_falls_through_to_the_real_sample(tmp_path: Path):
    share = tmp_path / "share"
    # W30546.35 and W305463.5 share the file-name form W3054635
    put(share, date(2026, 11, 11), ixml_name(2, "3D_YIELD_MONITOR", datetime(2026, 11, 11, 9, 0, 0), "W30546.35"), die_xml(sample="W30546.35"))
    put(share, date(2026, 11, 5), ixml_name(1, "3D_YIELD_MONITOR", datetime(2026, 11, 5, 9, 0, 0), "W305463.5"), die_xml(sample="W305463.5"))
    located, export = make_locator(tmp_path).locate_and_load("W305463.5", "3d")
    assert located.folder.endswith("2026_11_05") and export.sample_ids == ["W305463.5"]
    # typed without the dot (as in file names): the newest file whose id matches without dots
    located, export = make_locator(tmp_path).locate_and_load("w3054635", "3d")
    assert located.folder.endswith("2026_11_11") and export.sample_ids == ["W30546.35"]


def test_not_found_within_lookback_and_listing_cache(tmp_path: Path):
    share = tmp_path / "share"
    put(share, date(2026, 9, 1), ixml_name(1, "3D_YIELD_MONITOR", datetime(2026, 9, 1, 9, 0, 0), "W1.1"), die_xml(sample="W1.1"))
    locator = make_locator(tmp_path, lookback=30)
    with pytest.raises(WaferNotFound, match="last 30 days"):
        locator.locate_and_load("W1.1", "3d")
    # missing day folders are never remembered on disk (they may be uploaded later)
    assert list((tmp_path / "cache" / "listings").iterdir()) == []
    assert make_locator(tmp_path, lookback=90).locate_and_load("W1.1", "3d")[0].folder.endswith("2026_09_01")
    # settled folders that exist are kept for good; recent ones (within settled_days) are not
    listings = {p.stem for p in (tmp_path / "cache" / "listings").iterdir()}
    assert "2026_09_01" in listings and not any(s >= "2026_11_10" for s in listings)


def test_folder_uploaded_after_a_search_is_found(tmp_path: Path):
    """The backfill case: the share has data up to 10-15; 10-20 is uploaded after a first search."""
    share = tmp_path / "share"
    put(share, date(2026, 10, 15), ixml_name(1, "3D_YIELD_MONITOR", datetime(2026, 10, 15, 9, 0, 0), "W2.2"), die_xml(sample="W2.2", scrap=()))
    locator = make_locator(tmp_path)  # live TTL 0: missing folders are re-checked on every search
    assert locator.locate_and_load("W2.2", "3d")[0].folder.endswith("2026_10_15")
    put(share, date(2026, 10, 20), ixml_name(2, "3D_YIELD_MONITOR", datetime(2026, 10, 20, 9, 0, 0), "W2.2"), die_xml(sample="W2.2", scrap=(6,)))
    located, export = locator.locate_and_load("W2.2", "3d")
    assert located.folder.endswith("2026_10_20") and int(export.frame.Status.ne("Good").sum()) == 1
    # and a fresh process (disk cache only) sees it too
    assert make_locator(tmp_path).locate_and_load("W2.2", "3d")[0].folder.endswith("2026_10_20")


# --------------------------------------------------------------------------- 3D die-level exports
def test_die_level_export_rule_and_farm_dies():
    export = parse_cloudpcs_export(io.BytesIO(die_xml()), name="3d.xml")
    assert export.level == "die" and export.product == "159-501160A" and export.product_group == "SEQUOIA I"
    assert export.farm_dies == [1, 2] and export.header["TRANSACTIONID"].startswith("MET_W305463.5_")
    status = dict(zip(export.frame.Die_Num, export.frame.Status))
    assert status[1] == "Good" and status[6] == "UD" and status[7] == "UNCODED"  # 'null' code on a SCRAP die
    assert set(export.frame.Spring_Num) == {1}


def test_real_samples_parse_when_present():
    examples = Path(__file__).resolve().parents[1] / "examples"
    files = sorted(examples.glob("iXML#*.xml"))
    if not files:
        pytest.skip("customer iXML samples are not in backend/examples (kept out of git)")
    levels = {parse_ixml_name(f.name).plan: parse_cloudpcs_export(f, name=f.name).level for f in files}
    assert levels.get("3d", "die") == "die" and levels.get("2d", "spring") == "spring"


# --------------------------------------------------------------------------- API
@pytest.fixture
def wafermap_env(tmp_path, monkeypatch):
    ref_dir = tmp_path / "coordinates"
    ref_dir.mkdir()
    monkeypatch.setattr(app_module, "REF_DIR", ref_dir)
    monkeypatch.setattr(app_module, "_LOCATOR", make_locator(tmp_path))
    app_module._reference.cache_clear()
    app_module._layout_file.cache_clear()
    put(tmp_path / "share", date(2026, 11, 11), ixml_name(1, "3D_YIELD_MONITOR", datetime(2026, 11, 11, 9, 0, 0), "W305463.5"), die_xml())
    yield ref_dir
    app_module._reference.cache_clear()
    app_module._layout_file.cache_clear()


def die_layout_csv(dies=range(1, 9)) -> bytes:
    return pd.DataFrame([{"Die_Num": d, "X": 10.0 * (d % 4), "Y": 10.0 * (d // 4)} for d in dies]).to_csv(index=False).encode()


def test_wafermap_no_layout_then_layout_by_group(wafermap_env):
    res = client.get("/api/wafermap", params={"sample": "W305463.5", "plan": "3d"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "no_layout" and body["map"] is None and "159-501160A" in body["message"]
    assert body["level"] == "die" and body["product_group"] == "SEQUOIA I" and body["farm_dies"] == [1, 2]
    assert body["summary"] == {"unit": "die", "total": 6, "good": 4, "bad": 2, "yield_pct": pytest.approx(400 / 6),
                               "farm_dies": 2, "farm_good": 2, "dies": 8}
    assert body["file"]["folder"] == "risa/2026/2026_11_11"

    res = client.post("/api/layouts", data={"name": "SEQUOIA-I", "products": "X-OTHER", "product_groups": "SEQUOIA I", "author": "ann"},
                      files=[("file", ("seq.csv", die_layout_csv(), "text/csv"))])
    assert res.status_code == 200, res.text
    body = client.get("/api/wafermap", params={"sample": "w305463.5", "plan": "3d"}).json()
    assert body["status"] == "ok" and body["layout"] == {"name": "SEQUOIA-I", "revision": 1, "matched_by": "product_group", "kind": "die"}
    m = body["map"]
    assert len(m["status_codes"]) == len(m["x"]) == 8 and m["uninspected"] == 0
    assert [body["states"][c] for c in m["status_codes"]][5] == "UD" and m["die_yield"] is None


def test_wafermap_layout_mismatch_and_errors(wafermap_env):
    client.post("/api/layouts", data={"name": "SMALL", "products": "159-501160A"}, files=[("file", ("s.csv", die_layout_csv(dies=range(1, 5)), "text/csv"))])
    body = client.get("/api/wafermap", params={"sample": "W305463.5"}).json()
    assert body["status"] == "layout_mismatch" and "not present" in body["message"] and body["layout"]["name"] == "SMALL"
    assert client.get("/api/wafermap", params={"sample": "W999.1", "plan": "3d"}).status_code == 404
    assert client.get("/api/wafermap", params={"sample": "W305463.5", "plan": "4d"}).status_code == 422
    assert client.get("/api/wafermap", params={"sample": "../etc"}).status_code == 422


def test_layout_revision_endpoints(wafermap_env):
    def save(dies, replace=False, author="ann"):
        return client.post("/api/layouts", data={"name": "L", "products": "159-501160A", "replace": str(replace).lower(), "author": author, "action": "edit"},
                           files=[("file", ("l.csv", die_layout_csv(dies=dies), "text/csv"))])

    assert save(range(1, 9)).status_code == 200
    assert save(range(1, 5), replace=True, author="bob").json()["revision"] == 2
    assert client.get("/api/wafermap", params={"sample": "W305463.5"}).json()["status"] == "layout_mismatch"
    detail = client.get("/api/layouts/L").json()
    assert [(r["rev"], r["author"], r["action"]) for r in detail["revisions"]] == [(2, "bob", "edit"), (1, "ann", "edit")]
    geo = client.get("/api/layouts/L/revisions/1").json()
    assert geo["rev"] == 1 and len(geo["source_x"]) == 8 and geo["kind"] == "die"
    restored = client.post("/api/layouts/L/restore", json={"rev": 1, "author": "ann"}).json()
    assert restored["revision"] == 3 and restored["note"] == "Restored revision 1"
    assert client.get("/api/wafermap", params={"sample": "W305463.5"}).json()["status"] == "ok"  # cache cleared
    named = client.post("/api/layouts/L/names", json={"products": ["159-501160A"], "product_groups": ["SEQUOIA I"]}).json()
    assert named["revision"] == 4 and named["product_groups"] == ["SEQUOIA I"]
    assert client.post("/api/layouts/L/hidden", json={"hidden": True}).json()["hidden"] is True
    assert client.get("/api/wafermap", params={"sample": "W305463.5"}).json()["status"] == "no_layout"
    assert client.post("/api/layouts/L/hidden", json={"hidden": False}).json()["hidden"] is False
    assert client.get("/api/layouts/NOPE").status_code == 404
    assert client.post("/api/layouts/L/restore", json={"rev": 99}).status_code == 422


def test_wafermap_2d_spring_export_with_gang_yield(tmp_path, monkeypatch, tiny_reference_dir):
    monkeypatch.setattr(app_module, "REF_DIR", tiny_reference_dir)
    monkeypatch.setattr(app_module, "_LOCATOR", make_locator(tmp_path))
    app_module._layout_file.cache_clear()
    rows = make_rows(product="TEST-PROD", sample="W304235.1", dies=(1, 2), springs=range(1, 11))
    for r in rows[:7]:
        r.update(SPRING_GRADING="SCRAP", DEFECT_CODE="H8")
    put(tmp_path / "share", date(2026, 11, 12), ixml_name(9, "WaferYield_DefectMonitor", datetime(2026, 11, 12, 1, 2, 3), "W304235.1"), build_cloudpcs_xml(rows))
    body = client.get("/api/wafermap", params={"sample": "W304235.1", "plan": "2d"}).json()
    assert body["status"] == "ok" and body["level"] == "feature" and body["layout"]["matched_by"] == "product"
    gy = body["map"]["die_yield"]
    assert gy["total"] == 2 and gy["scrapped"] == 1 and gy["rows"][0]["disposition"] == "SCRAP"
    assert body["summary"]["unit"] == "feature" and body["summary"]["bad"] == 7
    app_module._layout_file.cache_clear()


def test_adapter_rejects_spring_export_on_die_layout():
    from engine import place_export
    from engine.reference import parse_reference
    ref, _ = parse_reference(io.BytesIO(die_layout_csv()), suffix=".csv")
    export = parse_cloudpcs_export(io.BytesIO(build_cloudpcs_xml(make_rows())), name="2d.xml")
    with pytest.raises(CloudPcsAdapterError, match="spring-level but layout"):
        place_export(export, ref, "DIE")


def test_stages_scrap_for_defects_banked_for_good(wafermap_env):
    # die_rows(): dies 6 (UD) and 7 (code 'null' -> UNCODED) are SCRAP at stage 38080SPIN;
    # Good dies are banked at PROCESS 4595SDBANK (their DIE_SCRAP_STAGE is 'null')
    export = parse_cloudpcs_export(io.BytesIO(die_xml()), name="3d.xml")
    stage = dict(zip(export.frame.Die_Num, export.frame.Stage))
    assert stage[6] == "38080SPIN" and stage[1] == "4595SDBANK"
    client.post("/api/layouts", data={"name": "SEQ", "products": "159-501160A"}, files=[("file", ("s.csv", die_layout_csv(), "text/csv"))])
    body = client.get("/api/wafermap", params={"sample": "W305463.5", "plan": "3d"}).json()
    assert body["status_stages"] == {
        "Good": [{"stage": "4595SDBANK", "count": 6}],
        "UD": [{"stage": "38080SPIN", "count": 1}],
        "UNCODED": [{"stage": "38080SPIN", "count": 1}],
    }
    m = body["map"]
    assert m["stages"] == ["4595SDBANK", "38080SPIN"]
    assert m["stage_codes"] == [0, 0, 0, 0, 0, 1, 1, 0]  # dies 1..8 in layout order


def test_map_filter_library(wafermap_env):
    rules = {"match": "all", "rules": [{"field": "kind", "op": "equals", "value": "defect"},
                                       {"field": "stage", "op": "num_lt", "value": "4900", "digits": 4}]}
    res = client.post("/api/map-filters", json={"name": "Defects before 4900", "definition": rules, "author": "ann", "note": "first"})
    assert res.status_code == 200, res.text
    f = res.json()
    assert f["revision"] == 1 and f["definition"]["rules"][1]["digits"] == 4
    fid = f["id"]
    # duplicate name, bad rules
    assert client.post("/api/map-filters", json={"name": "defects BEFORE 4900", "definition": rules}).status_code == 422
    bad = {"rules": [{"field": "stage", "op": "num_lt", "value": "abc"}]}
    assert "not a number" in client.post("/api/map-filters", json={"name": "Bad", "definition": bad}).json()["detail"]
    assert client.post("/api/map-filters", json={"name": "Empty", "definition": {"rules": []}}).status_code == 422
    assert client.post("/api/map-filters", json={"name": "Op", "definition": {"rules": [{"field": "kind", "op": "contains", "value": "x"}]}}).status_code == 422
    # revision, restore, copy, hide
    starts7 = {"match": "any", "rules": [{"field": "stage", "op": "starts_with", "value": "7"}]}
    assert client.put(f"/api/map-filters/{fid}", json={"definition": starts7, "author": "bob"}).json()["revision"] == 2
    restored = client.post(f"/api/map-filters/{fid}/restore", json={"rev": 1, "author": "ann"}).json()
    assert restored["revision"] == 3 and restored["definition"]["rules"][0]["field"] == "kind"
    history = client.get(f"/api/map-filters/{fid}").json()["revisions"]
    assert [(r["rev"], r["action"]) for r in history] == [(3, "restore"), (2, "edit"), (1, "create")]
    copy = client.post(f"/api/map-filters/{fid}/copy", json={"name": "My copy", "author": "cy"}).json()
    assert copy["copied_from"] == fid and copy["definition"] == restored["definition"] and copy["revision"] == 1
    assert client.post(f"/api/map-filters/{fid}/hidden", json={"hidden": True}).json()["hidden"] is True
    listed = {x["name"]: x["hidden"] for x in client.get("/api/map-filters").json()["filters"]}
    assert listed == {"Defects before 4900": True, "My copy": False}
    # a hidden filter's name is free again; bringing it back then clashes
    client.post("/api/map-filters", json={"name": "Defects before 4900", "definition": rules})
    assert client.post(f"/api/map-filters/{fid}/hidden", json={"hidden": False}).status_code == 422
    assert client.get("/api/map-filters/nope").status_code == 404
    assert (wafermap_env / "map_filters.json").is_file()  # stored next to the layouts
