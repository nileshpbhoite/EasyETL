"""Executes transformation metadata on Polars and produces Before/After previews with cell-level diffs."""
from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any, Callable

import polars as pl

from ..engine.metadata import TransformStep
from ..profiling.profiler import light_quality
from .library import TransformContext, TransformError, get

ROW_ID = "__row_id"


def with_row_id(df: pl.DataFrame) -> pl.DataFrame:
    return df if ROW_ID in df.columns else df.with_row_index(ROW_ID)


def apply_steps(df: pl.DataFrame, steps: list[TransformStep], ctx: TransformContext) -> tuple[pl.DataFrame, list[dict]]:
    """Apply enabled steps in order. A failing step is reported and skipped, so users can see and fix it."""
    results = []
    df = with_row_id(df)
    for step in steps:
        if not step.enabled:
            results.append({"step_id": step.id, "status": "disabled"})
            continue
        before = df.height
        try:
            _, fn = get(step.type)
            out = fn(df, step.params or {}, ctx)
            df = out
            results.append({"step_id": step.id, "status": "ok", "rows_in": before, "rows_out": df.height})
        except TransformError as e:
            results.append({"step_id": step.id, "status": "error", "message": str(e)})
        except Exception as e:  # noqa: BLE001 — surfaced as a friendly message with details
            results.append({"step_id": step.id, "status": "error", "message": "This step couldn't run with the current settings.",
                            "technical": f"{type(e).__name__}: {e}"})
    return df, results


def _json(v: Any) -> Any:
    if v is None or isinstance(v, (str, bool, int)):
        return v
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else round(v, 6)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _json(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_json(x) for x in v]
    return str(v)


def frame_rows(df: pl.DataFrame, limit: int = 100) -> list[dict]:
    return [{k: _json(v) for k, v in r.items()} for r in df.head(limit).to_dicts()]


def columns_meta(df: pl.DataFrame) -> list[dict]:
    return [{"name": c, "type": str(t)} for c, t in df.schema.items() if c != ROW_ID]


def _cmp_str(e: pl.Expr) -> pl.Expr:
    return e.cast(pl.Utf8, strict=False)


def diff_frames(before: pl.DataFrame, after: pl.DataFrame, row_limit: int = 60) -> dict:
    bcols = [c for c in before.columns if c != ROW_ID]
    acols = [c for c in after.columns if c != ROW_ID]
    added = [c for c in acols if c not in bcols]
    removed = [c for c in bcols if c not in acols]
    common = [c for c in acols if c in bcols]
    result: dict[str, Any] = {"added_columns": added, "removed_columns": removed, "changed_columns": {}, "changed_cells": 0,
                              "rows_removed": max(before.height - after.height, 0), "rows_added": max(after.height - before.height, 0),
                              "aligned": False, "removed_row_ids": [], "changed_row_ids": []}
    if ROW_ID not in before.columns or ROW_ID not in after.columns or after[ROW_ID].is_duplicated().any():
        result["before_rows"] = frame_rows(before.drop(ROW_ID, strict=False), row_limit)
        result["after_rows"] = frame_rows(after.drop(ROW_ID, strict=False), row_limit)
        return result

    result["aligned"] = True
    flat_common = [c for c in common if not isinstance(before.schema[c], (pl.Struct, pl.List)) and not isinstance(after.schema[c], (pl.Struct, pl.List))]
    joined = before.select([ROW_ID] + flat_common).join(after.select([ROW_ID] + flat_common), on=ROW_ID, how="inner", suffix="__after")
    change_exprs = [(_cmp_str(pl.col(c)).ne_missing(_cmp_str(pl.col(f"{c}__after")))).alias(f"{c}__chg") for c in flat_common]
    changes = joined.select([pl.col(ROW_ID)] + change_exprs) if change_exprs else joined.select(ROW_ID)
    for c in flat_common:
        n = int(changes[f"{c}__chg"].sum())
        if n:
            result["changed_columns"][c] = n
            result["changed_cells"] += n
    chg_cols = [f"{c}__chg" for c in flat_common if c in result["changed_columns"]]
    changed_ids = changes.filter(pl.any_horizontal(chg_cols))[ROW_ID].to_list() if chg_cols else []
    removed_ids = before.join(after.select(ROW_ID), on=ROW_ID, how="anti")[ROW_ID].to_list()
    result["removed_row_ids"] = removed_ids[:row_limit]
    result["changed_row_ids"] = changed_ids[:row_limit]

    # Build the sample: changed rows first, then removed rows, then context rows.
    pick: list[int] = []
    for rid in changed_ids[: row_limit // 2] + removed_ids[: row_limit // 3]:
        if rid not in pick:
            pick.append(rid)
    for rid in before[ROW_ID].head(row_limit * 2).to_list():
        if len(pick) >= row_limit:
            break
        if rid not in pick:
            pick.append(rid)
    pick.sort()
    order = pl.DataFrame({ROW_ID: pl.Series(pick, dtype=before.schema[ROW_ID])})
    b = order.join(before, on=ROW_ID, how="left")
    a = order.join(after, on=ROW_ID, how="left")
    result["before_rows"] = frame_rows(b, row_limit)
    result["after_rows"] = frame_rows(a, row_limit)
    cells = []
    for row in changes.filter(pl.col(ROW_ID).is_in(pick)).iter_rows(named=True):
        for c in result["changed_columns"]:
            if row.get(f"{c}__chg"):
                cells.append({"row_id": row[ROW_ID], "column": c})
    result["changed_cells_sample"] = cells
    return result


def preview_step(base: pl.DataFrame, steps: list[TransformStep], step_id: str | None, ctx: TransformContext,
                 row_limit: int = 60, draft: TransformStep | None = None) -> dict:
    """Before = pipeline up to (not including) the step; After = including it.
    `draft` previews an unsaved step appended after `step_id` (or at the end)."""
    active = [s for s in steps if s.enabled]
    if draft is not None:
        idx = next((i for i, s in enumerate(active) if s.id == step_id), len(active) - 1) if step_id else len(active) - 1
        before_steps, target = active[: idx + 1], [draft]
    elif step_id:
        idx = next((i for i, s in enumerate(steps) if s.id == step_id), None)
        if idx is None:
            raise TransformError("Step not found")
        before_steps = [s for s in steps[:idx] if s.enabled]
        target = [steps[idx].model_copy(update={"enabled": True})]
    else:
        before_steps, target = [], active
    before, r1 = apply_steps(base, before_steps, ctx)
    after, r2 = apply_steps(before, target, ctx)
    diff = diff_frames(before, after, row_limit)
    return {
        "before": {"columns": columns_meta(before), "rows": diff.pop("before_rows"), "metrics": light_quality(before)},
        "after": {"columns": columns_meta(after), "rows": diff.pop("after_rows"), "metrics": light_quality(after)},
        "changes": diff,
        "step_results": r1 + r2,
        "error": next((r for r in r2 if r.get("status") == "error"), None),
    }


def run_all(base: pl.DataFrame, steps: list[TransformStep], ctx: TransformContext) -> tuple[pl.DataFrame, list[dict]]:
    return apply_steps(base, steps, ctx)


LoadFn = Callable[[str], pl.DataFrame]
