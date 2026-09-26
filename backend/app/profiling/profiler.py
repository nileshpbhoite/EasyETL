"""Deterministic data profiling (Polars). Facts only — AI interprets these facts, it never invents them."""
from __future__ import annotations

import hashlib
import math
from typing import Any

import polars as pl

from .semantic import (
    date_expr,
    datetime_expr,
    detect_semantic,
    numeric_expr,
    pattern_of,
    pii_for,
    validity_expr,
)

NUMERIC_SEMANTICS = {"integer", "decimal", "currency", "percentage"}
DATE_SEMANTICS = {"date", "date_of_birth", "timestamp"}
INTERNAL_COLS = {"__row_id"}


def _round(v: Any, n: int = 4) -> Any:
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return round(v, n)
    return v


def _jsonable(v: Any) -> Any:
    if v is None or isinstance(v, (str, int, bool)):
        return v
    if isinstance(v, float):
        return _round(v)
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)


def schema_hash(df: pl.DataFrame) -> str:
    sig = "|".join(f"{c}:{t}" for c, t in df.schema.items() if c not in INTERNAL_COLS)
    return hashlib.sha1(sig.encode()).hexdigest()[:12]


def _nested_fields(dtype: pl.DataType, prefix: str = "") -> list[str]:
    out = []
    if isinstance(dtype, pl.Struct):
        for f in dtype.fields:
            name = f"{prefix}.{f.name}" if prefix else f.name
            sub = _nested_fields(f.dtype, name)
            out.extend(sub or [name])
    elif isinstance(dtype, pl.List):
        out.extend(_nested_fields(dtype.inner, prefix + "[]"))
    return out


def profile_column(df: pl.DataFrame, name: str) -> dict[str, Any]:
    s = df[name]
    n = df.height
    nested = isinstance(s.dtype, (pl.Struct, pl.List))
    null_count = int(s.null_count())
    if not nested and s.dtype == pl.Utf8:
        blank = int(((s.str.strip_chars() == "") & s.is_not_null()).sum())
        null_count += blank
    semantic, confidence, facts = detect_semantic(name, s)
    col: dict[str, Any] = {
        "name": name, "dtype": str(s.dtype), "semantic_type": semantic, "semantic_confidence": _round(confidence, 3),
        "null_count": null_count, "null_pct": _round(null_count / n * 100 if n else 0, 2), "is_nested": nested,
    }
    if nested:
        col["nested_fields"] = _nested_fields(s.dtype)
        col["nested_kind"] = "array" if isinstance(s.dtype, pl.List) else "object"
        col["distinct_count"] = None
        col["unique_pct"] = None
        col["cardinality"] = "n/a"
        col["sample_values"] = [str(v)[:120] for v in s.drop_nulls().head(3).to_list()]
        return col

    str_s = s.cast(pl.Utf8)
    non_null = str_s.drop_nulls()
    non_null = non_null.filter(non_null.str.strip_chars() != "")
    distinct = int(non_null.n_unique()) if non_null.len() else 0
    nn = non_null.len()
    col["distinct_count"] = distinct
    col["unique_pct"] = _round(distinct / nn * 100 if nn else 0, 2)
    col["duplicate_values"] = int(nn - distinct)
    col["cardinality"] = ("unique" if distinct == nn and nn > 0 else "high" if distinct > nn * 0.5 else "medium" if distinct > 50 else "low")
    lengths = non_null.str.len_chars()
    col["min_length"] = int(lengths.min()) if nn else None
    col["max_length"] = int(lengths.max()) if nn else None
    col["avg_length"] = _round(float(lengths.mean()), 1) if nn else None

    stripped = non_null.str.strip_chars()
    col["whitespace_issues"] = int((stripped != non_null).sum() + non_null.str.contains(r"\s{2,}").sum()) if nn else 0
    letters = non_null.str.replace_all(r"[^A-Za-zÀ-ÿ]", "")
    has_letters = letters.str.len_chars() > 1
    col["all_upper_count"] = int((has_letters & (letters == letters.str.to_uppercase())).sum()) if nn else 0
    col["all_lower_count"] = int((has_letters & (letters == letters.str.to_lowercase())).sum()) if nn else 0
    case_groups = stripped.str.to_lowercase().n_unique() if nn else 0
    col["case_variant_values"] = int(stripped.n_unique() - case_groups) if nn else 0
    vc = non_null.value_counts(sort=True).head(10)
    col["top_values"] = [{"value": r[0], "count": int(r[1]), "pct": _round(r[1] / nn * 100 if nn else 0, 2)} for r in vc.rows()]
    col["sample_values"] = non_null.unique(maintain_order=True).head(5).to_list()

    # patterns (shape analysis) for text-like columns
    if nn:
        pats = pl.Series([pattern_of(v) for v in non_null.head(5000).to_list()]).value_counts(sort=True)
        total = int(pats["count"].sum())
        col["patterns"] = [{"pattern": p, "count": int(c), "pct": _round(c / total * 100, 2)} for p, c in pats.head(6).rows()]
        col["pattern_count"] = pats.height
        col["pattern_consistency"] = _round(pats["count"][0] / total * 100, 2) if total else 100.0

    # validity
    vexpr = validity_expr(name, semantic)
    if vexpr is not None and nn:
        frame = pl.DataFrame({name: non_null})
        valid = frame.select(vexpr.alias("ok")).to_series()
        invalid_mask = ~valid.fill_null(False)
        col["invalid_count"] = int(invalid_mask.sum())
        col["invalid_pct"] = _round(col["invalid_count"] / nn * 100, 2)
        col["invalid_examples"] = non_null.filter(invalid_mask).unique(maintain_order=True).head(5).to_list()
    else:
        col["invalid_count"] = 0
        col["invalid_pct"] = 0.0

    # numeric statistics
    if semantic in NUMERIC_SEMANTICS or s.dtype.is_numeric():
        nums = pl.DataFrame({name: s}).select(numeric_expr(name) if s.dtype == pl.Utf8 else pl.col(name).cast(pl.Float64)).to_series().drop_nulls()
        if nums.len():
            q1, q3 = nums.quantile(0.25), nums.quantile(0.75)
            iqr = (q3 or 0) - (q1 or 0)
            lo, hi = (q1 or 0) - 1.5 * iqr, (q3 or 0) + 1.5 * iqr
            outliers = nums.filter((nums < lo) | (nums > hi)) if iqr > 0 else nums.head(0)
            col.update({
                "min": _round(nums.min()), "max": _round(nums.max()), "mean": _round(nums.mean()), "median": _round(nums.median()),
                "std": _round(nums.std()), "p25": _round(q1), "p75": _round(q3), "sum": _round(nums.sum()),
                "negative_count": int((nums < 0).sum()), "zero_count": int((nums == 0).sum()),
                "outlier_count": int(outliers.len()), "outlier_bounds": [_round(lo), _round(hi)],
            })
            try:
                bins = 12
                mn, mx = float(nums.min()), float(nums.max())
                upper = min(mx, hi) if iqr > 0 else mx
                if upper > mn:
                    width = (upper - mn) / bins
                    idx = ((nums.clip(mn, upper) - mn) / width).floor().clip(0, bins - 1).cast(pl.Int32)
                    counts = idx.value_counts().sort(idx.name)
                    cmap = dict(counts.rows())
                    col["histogram"] = [{"bin": _round(mn + i * width, 2), "count": int(cmap.get(i, 0))} for i in range(bins)]
            except Exception:  # noqa: BLE001
                pass

    # date statistics
    if semantic in DATE_SEMANTICS:
        parser = datetime_expr(name) if semantic == "timestamp" else date_expr(name)
        dates = pl.DataFrame({name: s}).select(parser).to_series().drop_nulls() if s.dtype == pl.Utf8 else s.drop_nulls()
        if dates.len():
            col["date_min"] = _jsonable(dates.min())
            col["date_max"] = _jsonable(dates.max())
            fmt_count = col.get("pattern_count", 1)
            col["date_formats_detected"] = fmt_count
            try:
                years = dates.dt.year().alias("year")
                yr = years.value_counts().sort("year")
                col["histogram"] = [{"bin": int(r[0]), "count": int(r[1])} for r in yr.rows()][-40:]
            except Exception:  # noqa: BLE001
                pass

    col["pii"] = pii_for(name, semantic)
    col["top_values"] = [{**t, "value": _jsonable(t["value"])} for t in col["top_values"]]
    col["sample_values"] = [_jsonable(v) for v in col["sample_values"]]
    return col


def _pk_candidates(df: pl.DataFrame, columns: list[dict]) -> list[dict]:
    n = df.height
    out = []
    for c in columns:
        if c["is_nested"] or not n:
            continue
        name = c["name"]
        lname = name.lower()
        name_score = 1.0 if (lname in ("id", "sys_id") or lname.endswith("_id") or lname.endswith("id") or lname in ("vin", "order_id", "kunnr", "vbeln")) else 0.4
        position_score = 1.0 if df.columns.index(name) == 0 else 0.6
        uniqueness = (c.get("distinct_count") or 0) / n
        completeness = 1 - c["null_pct"] / 100
        if uniqueness < 0.9 or completeness < 0.95 or (name_score < 1 and uniqueness < 0.995):
            continue
        confidence = 0.55 * uniqueness + 0.2 * completeness + 0.17 * name_score + 0.08 * position_score
        dups = n - (c.get("distinct_count") or 0) - c["null_count"]
        reason = f"{uniqueness * 100:.1f}% unique, {completeness * 100:.1f}% complete"
        if dups > 0:
            reason += f"; {dups:,} duplicate value{'s' if dups != 1 else ''} to resolve"
        out.append({"column": name, "confidence": round(min(confidence, 0.999), 3), "uniqueness_pct": round(uniqueness * 100, 2),
                    "duplicates": int(max(dups, 0)), "reason": reason})
    out.sort(key=lambda x: -x["confidence"])
    return out[:3]


def quality_scores(df: pl.DataFrame, columns: list[dict], duplicate_rows: int, pk: list[dict]) -> dict[str, float]:
    flat = [c for c in columns if not c["is_nested"]]
    n = max(df.height, 1)
    completeness = 100 - (sum(c["null_pct"] for c in flat) / len(flat) if flat else 0)
    validity = 100 - (sum(c.get("invalid_pct", 0) for c in flat) / len(flat) if flat else 0)
    key_dups = pk[0]["duplicates"] if pk else 0
    uniqueness = 100 - min(100, (duplicate_rows + key_dups) / n * 100 * 4)
    text_cols = [c for c in flat if c.get("pattern_consistency") is not None and c["semantic_type"] in
                 ("phone", "date", "date_of_birth", "country", "identifier", "category", "boolean", "currency", "percentage", "timestamp")]
    consistency = sum(min(100.0, c["pattern_consistency"] + (100 - c["pattern_consistency"]) * (0.0 if c["semantic_type"] not in ("category", "identifier") else 0.6))
                      for c in text_cols) / len(text_cols) if text_cols else 100.0
    for c in flat:
        if c["semantic_type"] in ("category", "country", "boolean") and c.get("top_values"):
            lowered = {}
            for t in c["top_values"]:
                k = str(t["value"]).strip().lower()
                lowered[k] = lowered.get(k, 0) + 1
            if any(v > 1 for v in lowered.values()):
                consistency -= 4
    consistency = max(0.0, consistency)
    score = 0.25 * completeness + 0.25 * validity + 0.25 * uniqueness + 0.25 * consistency
    return {k: round(v, 1) for k, v in dict(score=score, completeness=completeness, validity=validity,
                                              uniqueness=uniqueness, consistency=consistency).items()}


def profile_dataframe(df: pl.DataFrame, dataset_name: str = "", total_rows: int | None = None) -> dict[str, Any]:
    df = df.select([c for c in df.columns if c not in INTERNAL_COLS])
    columns = [profile_column(df, c) for c in df.columns]
    flat_cols = [c for c in df.columns if not isinstance(df[c].dtype, (pl.Struct, pl.List))]
    duplicate_rows = int(df.height - df.select(flat_cols).unique().height) if flat_cols else 0
    pk = _pk_candidates(df, columns)
    quality = quality_scores(df, columns, duplicate_rows, pk)
    return {
        "dataset_name": dataset_name,
        "row_count": total_rows if total_rows is not None else df.height,
        "profiled_rows": df.height,
        "sampled": total_rows is not None and total_rows > df.height,
        "column_count": df.width,
        "duplicate_rows": duplicate_rows,
        "duplicate_pct": round(duplicate_rows / df.height * 100, 2) if df.height else 0,
        "nested_columns": [c["name"] for c in columns if c["is_nested"]],
        "pii_columns": [c["name"] for c in columns if c.get("pii")],
        "columns": columns,
        "primary_key_candidates": pk,
        "quality": quality,
        "schema_hash": schema_hash(df),
        "schema": [{"name": c, "type": str(t)} for c, t in df.schema.items()],
    }


def light_quality(df: pl.DataFrame, sample_rows: int = 20_000) -> dict[str, Any]:
    """Metrics for before/after previews — computed with the same scoring as full profiling so numbers agree."""
    cols = [c for c in df.columns if c not in INTERNAL_COLS]
    view = df.select(cols)
    p = profile_dataframe(view.head(sample_rows), total_rows=view.height)
    flat = [c for c in p["columns"] if not c["is_nested"]]
    null_cells = sum(c["null_count"] for c in flat)
    cells = max(p["profiled_rows"] * max(len(flat), 1), 1)
    return {"rows": view.height, "columns": len(cols), "null_pct": round(null_cells / cells * 100, 2), "null_cells": null_cells,
            "duplicates": p["duplicate_rows"], "invalid_values": sum(c.get("invalid_count", 0) for c in flat),
            "quality_score": p["quality"]["score"], "quality": p["quality"],
            "invalid_by_type": _invalid_by_type(flat, view.head(sample_rows)), "format_columns": _format_stats(flat)}


FORMAT_TYPES = ("phone", "date", "date_of_birth", "timestamp", "country", "email", "identifier", "currency", "percentage", "boolean", "category")


def _invalid_by_type(cols: list[dict], view: pl.DataFrame) -> dict[str, dict[str, float]]:
    """Invalid values per semantic type. Phones count as invalid when not in one international (E.164) format."""
    out: dict[str, dict[str, float]] = {}
    n = view.height
    for c in cols:
        st = c["semantic_type"]
        if st not in ("email", "phone", "date", "date_of_birth", "country"):
            continue
        key = "date" if st == "date_of_birth" else st
        o = out.setdefault(key, {"invalid": 0, "values": 0})
        present = n - c["null_count"]
        o["values"] += present
        if st == "phone" and view.schema[c["name"]] == pl.Utf8:
            s = view[c["name"]].drop_nulls().str.strip_chars()
            s = s.filter(s != "")
            o["invalid"] += int((~s.str.contains(r"^\+\d{8,15}$")).sum())
        else:
            o["invalid"] += c.get("invalid_count", 0) or 0
    for o in out.values():
        o["pct"] = round(o["invalid"] / o["values"] * 100, 2) if o["values"] else 0.0
    return out


def _format_stats(cols: list[dict]) -> dict[str, int]:
    """Columns whose values follow one consistent format (typed columns count as consistent)."""
    relevant = [c for c in cols if c["semantic_type"] in FORMAT_TYPES]
    consistent = 0
    for c in relevant:
        typed = c["dtype"] not in ("String",)
        variants = c.get("case_variant_values", 0) or 0
        if typed or ((c.get("pattern_consistency") or 0) >= 95 and not variants) or (c["semantic_type"] in ("category", "identifier", "email") and not variants and not c.get("invalid_count")):
            consistent += 1
    return {"consistent": consistent, "total": len(relevant)}
