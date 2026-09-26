from datetime import date

import polars as pl

from app.transforms.library import REGISTRY, TransformContext, validate_params
from app.transforms.executor import apply_steps, preview_step
from app.engine.metadata import TransformStep as T
from app.profiling.profiler import profile_dataframe
from app.ai.policy import validate_transform

DF = pl.DataFrame({
    "id": ["1", "2", "2", "3"], "name": [" alice ", "BOB", "BOB", None], "email": ["a@x.com", "bad@", "bad@", "C@X.COM"],
    "phone": ["(555) 123-4567", "555.123.4567", "555.123.4567", "+44 20 7946 0958"], "dob": ["1990-01-31", "01/31/1990", "01/31/1990", "31 Jan 1990"],
    "country": ["USA", "U.S.A.", "U.S.A.", "UK"], "amount": ["$1,200.50", "15", "15", "-3"],
})
CTX = TransformContext(today=date(2025, 1, 31))


def run(type_, params):
    out, res = apply_steps(DF, [T(type=type_, dataset_id="d", params=params)], CTX)
    assert res[0]["status"] == "ok", res
    return out


def test_library_size():
    assert len(REGISTRY) >= 80


def test_cleaning():
    assert run("trim_whitespace", {"columns": ["name"]})["name"][0] == "alice"
    assert run("titlecase", {"columns": ["name"]})["name"].to_list()[:2] == ["Alice", "Bob"]
    assert run("standardize_phone", {"column": "phone"})["phone"].to_list() == ["+15551234567", "+15551234567", "+15551234567", "+442079460958"]
    assert run("validate_email", {"column": "email"})["email"].to_list() == ["a@x.com", None, None, "c@x.com"]
    assert run("standardize_country", {"column": "country"})["country"].to_list() == ["United States"] * 3 + ["United Kingdom"]


def test_types_dates():
    out = run("convert_types", {"conversions": [{"column": "amount", "to": "currency"}, {"column": "dob", "to": "date"}]})
    assert out["amount"].to_list() == [1200.5, 15.0, 15.0, -3.0]
    assert out["dob"].to_list() == [date(1990, 1, 31)] * 4
    assert run("calculate_age", {"column": "dob"})["age"].to_list() == [35] * 4


def test_duplicates_and_filter():
    assert run("remove_duplicates", {"columns": ["id"], "keep": "first"}).height == 3
    assert run("filter_rows", {"conditions": [{"column": "amount", "op": "gt", "value": 10}]}).height == 3
    assert run("remove_invalid", {"column": "amount", "check": "non_negative"}).height == 3


def test_aggregate_pivot():
    out = run("aggregate", {"group_by": ["country"], "aggregations": [{"column": "amount", "fn": "sum", "alias": "total"}]})
    assert dict(out.rows())["U.S.A."] == 30.0


def test_expression_if():
    expr = {"type": "if", "condition": {"type": "op", "op": ">", "left": {"type": "column", "name": "amount"}, "right": {"type": "literal", "value": 100}},
            "then": {"type": "literal", "value": "big"}, "else": {"type": "literal", "value": "small"}}
    assert run("derive_column", {"output": "size", "expression": expr})["size"].to_list() == ["big", "small", "small", "small"]


def test_pii():
    assert run("mask", {"columns": ["phone"]})["phone"][0].endswith("4567")
    h = run("hash", {"columns": ["email"]})["email"]
    assert len(h[0]) == 64 and h[1] == h[2]


def test_preview_diff():
    steps = [T(type="standardize_country", dataset_id="d", params={"column": "country"})]
    pv = preview_step(DF, steps, steps[0].id, CTX)
    assert pv["changes"]["changed_columns"] == {"country": 4}


def test_policy_rejects_code_and_unknown_columns():
    assert validate_transform("uppercase", {"columns": ["missing"]}, DF.columns)
    assert validate_transform("uppercase", {"columns": ["name"], "code": "import os"}, DF.columns)
    assert validate_transform("not_a_transform", {}, DF.columns)
    assert not validate_params("uppercase", {"columns": ["name"]}, DF.columns)


def test_profiler_detects_semantics():
    p = profile_dataframe(DF)
    sem = {c["name"]: c["semantic_type"] for c in p["columns"]}
    assert sem["email"] == "email" and sem["phone"] == "phone" and sem["country"] == "country"
    assert p["duplicate_rows"] == 1
    assert {c["name"] for c in p["columns"] if c["pii"]} >= {"email", "phone", "dob"}
