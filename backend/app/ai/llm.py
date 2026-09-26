"""Optional LLM provider (Claude via the Anthropic SDK).

The LLM only ever sees *profile metadata* (statistics, patterns, a few sample values) — never full datasets —
and must answer with a strict JSON schema. Its output then goes through the policy engine like any other
recommendation. If the provider is not configured or fails, the deterministic engine is used.
"""
from __future__ import annotations

import json
import logging
from typing import Literal

from pydantic import BaseModel, Field

from ..core.config import get_settings
from ..engine.metadata import Insight, PipelineMetadata, Recommendation
from ..transforms.library import REGISTRY

log = logging.getLogger("easyetl.ai")

SYSTEM_PROMPT = """You are the recommendation engine inside EasyETL, a no-code data modernization platform that deploys to Databricks.
You receive deterministic profiling facts for one or more datasets. Interpret them for a non-technical business user.

Rules:
- Only state facts that are supported by the profile you were given. Quote the numbers from it.
- Recommendations must use ONLY the transformation types listed in the catalog, with parameters that name existing columns.
- Never produce code, SQL, scripts or free-form commands. Parameters are plain JSON values.
- Explain each recommendation in plain English: why it matters and what changes in the data.
- Prefer a few high-value recommendations over many trivial ones."""


class LLMInsight(BaseModel):
    dataset_id: str
    severity: Literal["info", "success", "warning", "critical"]
    title: str
    detail: str


class LLMRecommendation(BaseModel):
    dataset_id: str
    title: str
    reason: str
    impact: Literal["high", "medium", "low"]
    confidence: float = Field(ge=0, le=1)
    expected_benefit: str
    explanation: str
    transform_type: str
    params_json: str = Field(description="JSON object with the transformation parameters")


class LLMAnalysis(BaseModel):
    insights: list[LLMInsight]
    recommendations: list[LLMRecommendation]


class LLMAnswer(BaseModel):
    answer: str
    suggested_transform_type: str | None = None
    suggested_params_json: str | None = None


def is_enabled() -> bool:
    s = get_settings()
    return s.ai_provider == "anthropic" and bool(s.anthropic_api_key)


def _client():
    import anthropic

    return anthropic.Anthropic(api_key=get_settings().anthropic_api_key, max_retries=2, timeout=90.0)


def _compact_profiles(meta: PipelineMetadata) -> list[dict]:
    out = []
    for ds in meta.selected_datasets():
        p = meta.analysis.profiles.get(ds.id)
        if not p:
            continue
        cols = []
        for c in p["columns"]:
            cols.append({k: c.get(k) for k in ("name", "dtype", "semantic_type", "null_pct", "unique_pct", "invalid_count", "invalid_examples",
                                                  "pattern_count", "pattern_consistency", "min", "max", "negative_count", "outlier_count",
                                                  "case_variant_values", "whitespace_issues", "nested_fields") if c.get(k) not in (None, [], 0)}
                        | {"top_values": [t["value"] for t in (c.get("top_values") or [])[:5]], "pii": (c.get("pii") or {}).get("category")})
        out.append({"dataset_id": ds.id, "name": ds.name, "rows": p["row_count"], "duplicate_rows": p["duplicate_rows"],
                    "primary_key_candidates": p["primary_key_candidates"], "quality": p["quality"], "columns": cols})
    return out


def _catalog() -> list[dict]:
    return [{"type": s.id, "label": s.label, "params": [{"name": ps.name, "type": ps.type, "required": ps.required,
                                                         "options": [o["value"] for o in ps.options][:12]} for ps in s.params]}
            for s, _ in REGISTRY.values()]


def analyze(meta: PipelineMetadata) -> tuple[list[Insight], list[Recommendation]]:
    """Ask Claude for insights + recommendations as validated structured output."""
    import anthropic

    s = get_settings()
    payload = {"datasets": _compact_profiles(meta), "relationships": meta.analysis.relationships, "transformation_catalog": _catalog()}
    try:
        response = _client().messages.parse(
            model=s.anthropic_model,
            max_tokens=16000,
            thinking={"type": "adaptive"},
            output_config={"effort": "medium"},
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": "Profile facts:\n" + json.dumps(payload, default=str)}],
            output_format=LLMAnalysis,
        )
    except anthropic.APIConnectionError as e:
        log.warning("LLM unreachable, using deterministic engine: %s", e)
        return [], []
    except anthropic.RateLimitError as e:
        log.warning("LLM rate limited, using deterministic engine: %s", e)
        return [], []
    except anthropic.APIStatusError as e:
        log.warning("LLM error %s, using deterministic engine", e.status_code)
        return [], []
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return [], []
    parsed: LLMAnalysis = response.parsed_output
    insights = [Insight(dataset_id=i.dataset_id, severity=i.severity, title=i.title, detail=i.detail) for i in parsed.insights]
    recs = []
    for r in parsed.recommendations:
        try:
            params = json.loads(r.params_json or "{}")
        except json.JSONDecodeError:
            continue
        recs.append(Recommendation(dataset_id=r.dataset_id, title=r.title, reason=r.reason, impact=r.impact, confidence=r.confidence,
                                   expected_benefit=r.expected_benefit, explanation=r.explanation, generated_by="llm",
                                   action={"kind": "add_transform", "transform": {"type": r.transform_type, "params": params}}))
    return insights, recs


def answer(question: str, context: dict) -> LLMAnswer | None:
    import anthropic

    s = get_settings()
    try:
        response = _client().messages.parse(
            model=s.anthropic_model,
            max_tokens=8000,
            output_config={"effort": "low"},
            system=SYSTEM_PROMPT + "\nYou are now answering the user's question about their current pipeline. Use only the context provided. "
                                   "If they ask to create or change data, propose ONE transformation from the catalog.",
            messages=[{"role": "user", "content": f"Context:\n{json.dumps(context, default=str)[:60000]}\n\nQuestion: {question}"}],
            output_format=LLMAnswer,
        )
    except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
        log.warning("LLM assistant unavailable: %s", e)
        return None
    if response.stop_reason == "refusal":
        return None
    return response.parsed_output


class LLMDqRule(BaseModel):
    sql: str = Field(description="ONE Databricks SQL boolean predicate that is TRUE when a record passes the rule")
    dimension: Literal["completeness", "uniqueness", "validity", "accuracy", "consistency", "referential_integrity", "range", "pattern", "custom"]
    explanation: str = Field(description="One sentence, plain English, how the condition implements the rule")


DQ_SYSTEM_PROMPT = """You convert a business user's data quality rule into ONE Databricks SQL boolean predicate.
- Output a condition over the row's columns only (no SELECT, subqueries, statements, comments or semicolons).
- Use only the listed columns, spelled exactly as given (backticks for names with spaces).
- Allowed functions: length, upper, lower, trim, ltrim, rtrim, abs, round, coalesce, nvl, current_date, current_timestamp, to_date,
  year, month, day, datediff, regexp_replace, substring, concat, startswith, endswith, contains, isnull, isnotnull, cast, try_cast; operators
  AND OR NOT, comparisons, IN, BETWEEN, LIKE, RLIKE, IS [NOT] NULL, CASE WHEN.
- The predicate is TRUE for a valid record. A NULL result is treated as passing, so add `col IS NOT NULL` when emptiness must fail.
- Use to_date() on text date columns before comparing dates."""


def dq_rule_from_text(text: str, columns: list[str], types: dict[str, str], samples: dict[str, list]) -> dict | None:
    """Plain-English rule → SQL predicate with Claude. The caller validates the SQL (dq_sql.validate) before use."""
    import anthropic

    s = get_settings()
    cols = [{"name": c, "semantic_type": types.get(c), "sample_values": [str(v) for v in (samples.get(c) or [])[:4]]} for c in columns]
    try:
        response = _client().messages.parse(
            model=s.anthropic_model,
            max_tokens=4000,
            output_config={"effort": "low"},
            system=DQ_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": f"Columns:\n{json.dumps(cols, default=str)}\n\nRule: {text}"}],
            output_format=LLMDqRule,
        )
    except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
        log.warning("LLM DQ rule conversion unavailable: %s", e)
        return None
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return None
    out: LLMDqRule = response.parsed_output
    return {"rule": "expression", "params": {"sql": out.sql}, "dimension": out.dimension, "engine": "claude", "explanation": out.explanation}
