"""Rules / Policy engine.

    Profiler → AI Recommendation Engine → Recommendation JSON → **Policy engine** → Validated metadata → Pipeline generator

AI output is never executed. It's structured data that must pass these deterministic checks before a user can
approve it, and again before it's applied to the metadata document.
"""
from __future__ import annotations

from typing import Any

from ..engine.metadata import PipelineMetadata, QualityRule, Recommendation
from ..transforms.library import REGISTRY, validate_params

ALLOWED_ACTIONS = {"add_transform", "add_quality_rule", "set_pii_action", "set_ingestion", "lakehouse"}
FORBIDDEN_KEYS = {"code", "sql", "python", "script", "exec", "eval", "command", "notebook", "query_text"}
ALLOWED_ENGINES = {"auto_loader", "lakeflow_connect", "batch", "streaming", "jdbc", "rest_api"}
ALLOWED_RULES = {"not_null", "unique", "email", "phone", "regex", "range", "in_set", "in_reference", "in_dataset", "min_length", "expression", "date"}
MAX_PARAM_STRING = 2000


def _scan(obj: Any, path: str = "") -> list[str]:
    problems = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() in FORBIDDEN_KEYS:
                problems.append(f"'{path}{k}' is not an allowed setting (executable content is never accepted).")
            problems += _scan(v, f"{path}{k}.")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            problems += _scan(v, f"{path}{i}.")
    elif isinstance(obj, str) and len(obj) > MAX_PARAM_STRING:
        problems.append(f"'{path.rstrip('.')}' is too long.")
    return problems


def validate_transform(type_: str, params: dict, columns: list[str]) -> list[str]:
    if type_ not in REGISTRY:
        return [f"'{type_}' is not a known transformation."]
    return _scan(params) + validate_params(type_, params, columns)


def validate_quality_rule(rule: QualityRule, meta: PipelineMetadata, columns: list[str]) -> list[str]:
    problems = []
    if rule.rule not in ALLOWED_RULES:
        problems.append(f"Unknown rule type '{rule.rule}'.")
    if not meta.dataset(rule.dataset_id):
        problems.append("Unknown dataset.")
    if rule.column and rule.column not in columns:
        problems.append(f"Column '{rule.column}' doesn't exist.")
    if not 0 <= rule.threshold_amber <= rule.threshold_green <= 100:
        problems.append("RAG thresholds must satisfy 0 ≤ Amber ≤ Green ≤ 100.")
    if rule.rule == "expression":
        # SQL rules pass through the strict predicate validator: one boolean condition, known columns, whitelisted functions.
        from ..engine.dq_sql import DQSqlError, validate

        try:
            rule.params = {**rule.params, "sql": validate(str(rule.params.get("sql") or ""), columns)[0]}
        except DQSqlError as e:
            problems.append(str(e))
        return problems + _scan({k: v for k, v in rule.params.items() if k != "sql"})
    return problems + _scan(rule.params)


def validate_recommendation(rec: Recommendation, meta: PipelineMetadata, columns_by_dataset: dict[str, list[str]]) -> list[str]:
    problems: list[str] = []
    kind = rec.action.get("kind")
    if kind not in ALLOWED_ACTIONS:
        return [f"Action '{kind}' is not allowed."]
    if not 0 <= rec.confidence <= 1:
        problems.append("Confidence must be between 0 and 1.")
    if rec.dataset_id and not meta.dataset(rec.dataset_id):
        problems.append("The recommendation refers to an unknown dataset.")
    cols = columns_by_dataset.get(rec.dataset_id or "", [])
    if kind == "add_transform":
        t = rec.action.get("transform") or {}
        problems += validate_transform(t.get("type", ""), t.get("params") or {}, cols)
    elif kind == "add_quality_rule":
        try:
            rule = QualityRule(**rec.action["rule"])
            problems += validate_quality_rule(rule, meta, cols)
        except Exception as e:  # noqa: BLE001
            problems.append(f"Invalid rule: {e}")
    elif kind == "set_ingestion":
        if rec.action.get("engine") not in ALLOWED_ENGINES:
            problems.append("Unknown ingestion engine.")
    return problems


def filter_valid(recs: list[Recommendation], meta: PipelineMetadata, columns_by_dataset: dict[str, list[str]]) -> tuple[list[Recommendation], list[dict]]:
    ok, rejected = [], []
    for r in recs:
        problems = validate_recommendation(r, meta, columns_by_dataset)
        if problems:
            rejected.append({"title": r.title, "problems": problems, "generated_by": r.generated_by})
        else:
            ok.append(r)
    return ok, rejected
