"""Data-quality rule evaluation (deterministic). Rules are metadata; on Databricks they become Lakeflow expectations."""
from __future__ import annotations

from datetime import date
from typing import Any, Callable

import polars as pl

from ..profiling.semantic import EMAIL_RE, country_lookup, date_expr, numeric_expr
from .metadata import QualityRule

DIMENSIONS = ["completeness", "uniqueness", "validity", "accuracy", "consistency", "referential_integrity", "range", "pattern", "custom"]

RULE_CATALOG = [
    {"rule": "not_null", "label": "Must not be empty", "dimension": "completeness", "params": []},
    {"rule": "unique", "label": "Must be unique", "dimension": "uniqueness", "params": []},
    {"rule": "email", "label": "Must be a valid email", "dimension": "validity", "params": []},
    {"rule": "phone", "label": "Must be a valid phone number", "dimension": "validity", "params": []},
    {"rule": "date", "label": "Must be a valid date", "dimension": "validity", "params": []},
    {"rule": "range", "label": "Must be within a range", "dimension": "range", "params": ["min", "max"]},
    {"rule": "in_set", "label": "Must be one of these values", "dimension": "consistency", "params": ["values"]},
    {"rule": "in_reference", "label": "Must exist in a reference list", "dimension": "consistency", "params": ["reference"]},
    {"rule": "in_dataset", "label": "Must exist in another dataset", "dimension": "referential_integrity", "params": ["dataset_id", "column"]},
    {"rule": "regex", "label": "Must match a pattern", "dimension": "pattern", "params": ["pattern"]},
    {"rule": "min_length", "label": "Minimum length", "dimension": "validity", "params": ["length"]},
]


def _blank(col: str) -> pl.Expr:
    return pl.col(col).is_null() | (pl.col(col).cast(pl.Utf8).str.strip_chars() == "")


def _num(df: pl.DataFrame, col: str) -> pl.Expr:
    return numeric_expr(col) if df.schema[col] == pl.Utf8 else pl.col(col).cast(pl.Float64, strict=False)


def rule_mask(df: pl.DataFrame, rule: QualityRule, load: Callable[[str], pl.DataFrame] | None = None) -> pl.Expr:
    """Boolean expression — True where the record PASSES."""
    c = rule.column
    p = rule.params or {}
    if rule.rule == "not_null":
        return ~_blank(c)
    if rule.rule == "unique":
        return ~pl.col(c).is_duplicated() | _blank(c)
    s = pl.col(c).cast(pl.Utf8).str.strip_chars()
    if rule.rule == "email":
        return s.str.contains(EMAIL_RE) | _blank(c)
    if rule.rule == "phone":
        return s.str.replace_all(r"\D", "").str.len_chars().is_between(7, 15) | _blank(c)
    if rule.rule == "date":
        return (date_expr(c).is_not_null() if df.schema[c] == pl.Utf8 else pl.lit(True)) | _blank(c)
    if rule.rule == "range":
        lo, hi = p.get("min"), p.get("max")
        is_date = isinstance(lo, str) and lo[:4].isdigit() or isinstance(hi, str) and (hi == "today" or hi[:4].isdigit())
        if is_date:
            v = date_expr(c) if df.schema[c] == pl.Utf8 else pl.col(c).cast(pl.Date)
            lo_v = date.fromisoformat(lo) if lo else None
            hi_v = date.today() if hi == "today" else (date.fromisoformat(hi) if hi else None)
        else:
            v = _num(df, c)
            lo_v = float(lo) if lo not in (None, "") else None
            hi_v = float(hi) if hi not in (None, "") else None
        ok = pl.lit(True)
        if lo_v is not None:
            ok = ok & (v >= lo_v)
        if hi_v is not None:
            ok = ok & (v <= hi_v)
        return ok.fill_null(True)
    if rule.rule == "in_set":
        values = [str(x).strip().lower() for x in (p.get("values") or [])]
        return s.str.to_lowercase().is_in(values) | _blank(c)
    if rule.rule == "in_reference":
        return s.map_elements(lambda v: country_lookup(v) is not None, return_dtype=pl.Boolean).fill_null(True) | _blank(c)
    if rule.rule == "in_dataset":
        if not load:
            return pl.lit(True)
        other = load(p["dataset_id"])
        col = p["column"]
        if col not in other.columns:
            from ..transforms.library import to_snake

            col = to_snake(col)
            if col not in other.columns:
                return pl.lit(True)
        keys = other[col].cast(pl.Utf8).str.strip_chars().str.to_uppercase().drop_nulls().unique().to_list()
        return s.str.to_uppercase().is_in(keys) | _blank(c)
    if rule.rule == "regex":
        return s.str.contains(p.get("pattern") or ".*") | _blank(c)
    if rule.rule == "min_length":
        return (s.str.len_chars() >= int(p.get("length") or 1)) | _blank(c)
    return pl.lit(True)


def evaluate(df: pl.DataFrame, rules: list[QualityRule], load: Callable[[str], pl.DataFrame] | None = None) -> dict[str, Any]:
    results = []
    n = df.height
    failing_any = pl.Series([False] * n) if n else pl.Series([], dtype=pl.Boolean)
    for r in rules:
        if not r.enabled:
            continue
        if r.column and r.column not in df.columns:
            results.append({"rule_id": r.id, "status": "error", "message": f"Column '{r.column}' isn't in the output (renamed or removed?)",
                            "dimension": r.dimension, "description": r.description})
            continue
        try:
            passed = df.select(rule_mask(df, r, load).fill_null(True).alias("ok"))["ok"]
        except Exception as e:  # noqa: BLE001
            results.append({"rule_id": r.id, "status": "error", "message": str(e), "dimension": r.dimension, "description": r.description})
            continue
        failed = int((~passed).sum())
        failing_any = failing_any | ~passed
        examples = df.filter(~passed).select(r.column).head(5)[r.column].cast(pl.Utf8).to_list() if failed and r.column else []
        results.append({"rule_id": r.id, "status": "passed" if failed == 0 else "failed", "dimension": r.dimension, "description": r.description,
                        "column": r.column, "failed": failed, "pass_rate": round((1 - failed / n) * 100, 2) if n else 100.0, "on_fail": r.on_fail,
                        "examples": examples})
    by_dim: dict[str, list[float]] = {}
    for res in results:
        if res.get("pass_rate") is not None:
            by_dim.setdefault(res["dimension"], []).append(res["pass_rate"])
    dims = {d: round(sum(v) / len(v), 1) for d, v in by_dim.items()}
    overall = round(sum(dims.values()) / len(dims), 1) if dims else None
    return {"rules": results, "dimensions": dims, "score": overall, "failing_records": int(failing_any.sum()) if n else 0, "records": n}
