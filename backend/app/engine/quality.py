"""Data-quality rule evaluation (deterministic). Rules are metadata; on Databricks they become Lakeflow expectations."""
from __future__ import annotations

from datetime import date
from typing import Any, Callable

import polars as pl

from ..profiling.semantic import _COUNTRY_INDEX, EMAIL_RE, country_lookup, date_expr, numeric_expr
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
    {"rule": "expression", "label": "Custom SQL condition", "dimension": "custom", "params": ["sql"]},
]

NUM_CLEAN = r"[$€£¥,%\s]"
ACTIONS = {"flag": "Flag & load", "quarantine": "Quarantine (park in DQ table)", "drop": "Drop record", "fail": "Fail the run"}
SEVERITY_WEIGHT = {"critical": 4, "high": 3, "medium": 2, "low": 1}
ACTION_RANK = {"flag": 1, "quarantine": 2, "drop": 3, "fail": 4}


def _q(v: Any) -> str:
    """Databricks SQL string literal."""
    return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _ident(c: str) -> str:
    return "`" + c.replace("`", "``") + "`"


def rule_sql(rule: QualityRule) -> str | None:
    """The rule as a Databricks SQL boolean predicate (NULL-safe: the generated code wraps it in COALESCE(..., TRUE)).
    Returns None for rules that need more than one row to decide (uniqueness, referential integrity) — the
    runtime evaluates those with a window / join instead."""
    p = rule.params or {}
    if rule.rule == "expression":
        return p.get("sql") or "TRUE"
    if not rule.column:
        return None
    c = _ident(rule.column)
    s = f"trim(CAST({c} AS STRING))"
    if rule.rule == "not_null":
        return f"{c} IS NOT NULL AND {s} <> ''"
    if rule.rule == "email":
        return f"{c} IS NULL OR {s} RLIKE {_q(EMAIL_RE)}"
    if rule.rule == "phone":
        return f"{c} IS NULL OR length(regexp_replace({s}, '[^0-9]', '')) BETWEEN 7 AND 15"
    if rule.rule == "date":
        return f"{c} IS NULL OR {s} = '' OR coalesce(try_to_date({s}), try_to_date({s}, 'MM/dd/yyyy'), try_to_date({s}, 'dd/MM/yyyy'), CAST(try_to_timestamp({s}) AS DATE)) IS NOT NULL"
    if rule.rule == "range":
        lo, hi = p.get("min"), p.get("max")
        is_date = isinstance(lo, str) and lo[:4].isdigit() or isinstance(hi, str) and (hi == "today" or hi[:4].isdigit())
        v = f"try_to_date({s})" if is_date else f"try_cast(regexp_replace({s}, {_q(NUM_CLEAN)}, '') AS DOUBLE)"
        parts = []
        if lo not in (None, ""):
            parts.append(f"{v} >= {'DATE ' + _q(lo) if is_date else float(lo)}")
        if hi not in (None, ""):
            parts.append(f"{v} <= {'current_date()' if hi == 'today' else ('DATE ' + _q(hi) if is_date else float(hi))}")
        return " AND ".join(parts) or "TRUE"
    if rule.rule == "in_set":
        vals = ", ".join(_q(str(x).strip().lower()) for x in p.get("values") or [])
        return f"{c} IS NULL OR lower({s}) IN ({vals})" if vals else "TRUE"
    if rule.rule == "in_reference":
        vals = ", ".join(_q(k) for k in sorted(_COUNTRY_INDEX))
        return f"{c} IS NULL OR lower({s}) IN ({vals})"
    if rule.rule == "regex":
        return f"{c} IS NULL OR {s} RLIKE {_q(p.get('pattern') or '.*')}"
    if rule.rule == "min_length":
        return f"{c} IS NULL OR length({s}) >= {int(p.get('length') or 1)}"
    return None


def rag(pass_rate: float | None, rule: QualityRule) -> str | None:
    if pass_rate is None:
        return None
    return "green" if pass_rate >= rule.threshold_green else "amber" if pass_rate >= rule.threshold_amber else "red"


def _blank(col: str) -> pl.Expr:
    return pl.col(col).is_null() | (pl.col(col).cast(pl.Utf8).str.strip_chars() == "")


def _num(df: pl.DataFrame, col: str) -> pl.Expr:
    return numeric_expr(col) if df.schema[col] == pl.Utf8 else pl.col(col).cast(pl.Float64, strict=False)


def rule_mask(df: pl.DataFrame, rule: QualityRule, load: Callable[[str], pl.DataFrame] | None = None) -> pl.Expr:
    """Boolean expression — True where the record PASSES."""
    c = rule.column
    p = rule.params or {}
    if rule.rule == "expression":
        from .dq_sql import to_polars

        return to_polars(p.get("sql") or "TRUE", dict(df.schema))
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
    """Run every enabled rule. Per rule: pass rate, failing records, Red/Amber/Green status and the configured action.
    Overall: severity-weighted score, per-dimension scores, and what happens to records when the pipeline runs
    (quarantined / dropped / flagged / loaded)."""
    results = []
    n = df.height
    empty = pl.Series([False] * n, dtype=pl.Boolean)
    failing_any = empty
    by_action = {a: empty for a in ACTION_RANK}
    for r in rules:
        if not r.enabled:
            continue
        base = {"rule_id": r.id, "name": r.name or r.description or f"{r.column}: {r.rule.replace('_', ' ')}", "dimension": r.dimension, "description": r.description, "column": r.column,
                "severity": r.severity, "action": r.action(), "on_fail": r.action(), "origin": r.origin, "sql": rule_sql(r),
                "threshold_green": r.threshold_green, "threshold_amber": r.threshold_amber}
        if r.column and r.column not in df.columns:
            results.append({**base, "status": "error", "rag": "red", "message": f"Column '{r.column}' isn't in the output (renamed or removed?)"})
            continue
        try:
            passed = df.select(rule_mask(df, r, load).fill_null(True).alias("ok"))["ok"]
        except Exception as e:  # noqa: BLE001
            results.append({**base, "status": "error", "rag": "red", "message": str(e)})
            continue
        failed_mask = ~passed
        failed = int(failed_mask.sum())
        failing_any = failing_any | failed_mask
        by_action[r.action()] = by_action[r.action()] | failed_mask
        if failed and r.column:
            examples = df.filter(failed_mask).select(r.column).head(5)[r.column].cast(pl.Utf8).to_list()
        else:
            examples = []
        pr = round((1 - failed / n) * 100, 2) if n else 100.0
        results.append({**base, "status": "passed" if failed == 0 else "failed", "failed": failed, "pass_rate": pr, "rag": rag(pr, r), "examples": examples})
    by_dim: dict[str, list[float]] = {}
    for res in results:
        if res.get("pass_rate") is not None:
            by_dim.setdefault(res["dimension"], []).append(res["pass_rate"])
    dims = {d: round(sum(v) / len(v), 1) for d, v in by_dim.items()}
    weighted = [(res["pass_rate"], SEVERITY_WEIGHT.get(res["severity"], 2)) for res in results if res.get("pass_rate") is not None]
    overall = round(sum(p * w for p, w in weighted) / sum(w for _, w in weighted), 1) if weighted else None
    if n:
        dropped = by_action["drop"]
        quarantined = by_action["quarantine"] & ~dropped
        flagged = by_action["flag"] & ~quarantined & ~dropped
        handling = {"quarantined": int(quarantined.sum()), "dropped": int(dropped.sum()), "flagged": int(flagged.sum()),
                    "loaded": n - int((quarantined | dropped).sum()), "fail_rules_triggered": sum(1 for r in results if r["action"] == "fail" and r.get("failed"))}
    else:
        handling = {"quarantined": 0, "dropped": 0, "flagged": 0, "loaded": 0, "fail_rules_triggered": 0}
    rag_counts = {k: sum(1 for r in results if r.get("rag") == k) for k in ("green", "amber", "red")}
    return {"rules": results, "dimensions": dims, "score": overall, "failing_records": int(failing_any.sum()) if n else 0, "records": n,
            "handling": handling, "rag": rag_counts, "issues": sum(r.get("failed", 0) for r in results)}
