"""The deterministic expert engine ("heuristic AI provider").

It interprets profiling facts and produces structured insights and recommendations — the same JSON an LLM
provider must produce. Every statement is traceable to a profiled fact, which keeps explanations honest.
"""
from __future__ import annotations

import re
from typing import Any

import polars as pl

from ..engine.metadata import (
    AccessPolicy,
    DatasetRef,
    Insight,
    PiiField,
    PipelineMetadata,
    QualityRule,
    Recommendation,
    TableDesign,
)
from ..profiling.semantic import country_lookup
from ..transforms.library import to_snake

ENTITY_KEYWORDS = [
    ("customer", ["customer", "client", "kna1", "account", "contact", "buyer"]),
    ("order", ["order", "sales", "vbak", "invoice", "transaction", "opportunit"]),
    ("vehicle", ["vehicle", "car", "fleet", "inventory"]),
    ("service", ["service", "repair", "maintenance", "work_order"]),
    ("product", ["product", "material", "mara", "item", "sku"]),
    ("employee", ["employee", "worker", "staff", "sales_rep", "rep"]),
    ("incident", ["incident", "case", "ticket"]),
    ("dealer", ["dealer", "store", "branch", "location"]),
    ("recall", ["recall"]),
    ("lead", ["lead", "campaign", "prospect"]),
]
ENTITY_TABLE = {"customer": "customer_master", "order": "orders", "vehicle": "vehicle_master", "service": "service_history",
                "product": "product_master", "employee": "employee_master", "incident": "incidents", "dealer": "dealer_master",
                "recall": "recalls", "lead": "leads"}
DATE_HINTS = ("date", "_at", "_on", "time", "modified", "updated", "created", "since", "dt")


def detect_entity(ds: DatasetRef, profile: dict | None) -> str:
    name = ds.name.lower()
    for entity, words in ENTITY_KEYWORDS:
        if any(w in name for w in words):
            return entity
    cols = " ".join(c["name"].lower() for c in (profile or {}).get("columns", []))
    for entity, words in ENTITY_KEYWORDS:
        if any(f"{w}_id" in cols or f"{w}id" in cols for w in words[:1]):
            return entity
    return "record"


def _col(profile: dict, name: str) -> dict | None:
    return next((c for c in profile["columns"] if c["name"] == name), None)


def _cols_of(profile: dict, *types: str) -> list[dict]:
    return [c for c in profile["columns"] if c["semantic_type"] in types]


def _pk(profile: dict) -> dict | None:
    c = profile.get("primary_key_candidates") or []
    return c[0] if c else None


def _recency_column(profile: dict) -> str | None:
    dates = [c for c in profile["columns"] if c["semantic_type"] in ("date", "timestamp") and not c.get("pii")]
    for pref in ("modified", "updated", "signup", "created", "date"):
        for c in dates:
            if pref in c["name"].lower():
                return c["name"]
    return dates[0]["name"] if dates else None


def _country_col(profile: dict) -> str | None:
    c = _cols_of(profile, "country")
    return c[0]["name"] if c else None


def _pct(n: float) -> str:
    return f"{n:.1f}%" if n < 10 else f"{n:.0f}%"


# =========================================================================== relationships
def _norm_name(n: str) -> str:
    return re.sub(r"[^a-z0-9]", "", n.lower())


def detect_relationships(meta: PipelineMetadata, frames: dict[str, pl.DataFrame]) -> list[dict]:
    """Foreign-key discovery: name similarity + value containment between identifier columns."""
    from ..transforms.library import get

    flat: dict[str, pl.DataFrame] = {}
    for ds_id, df in frames.items():
        try:
            flat[ds_id] = get("flatten")[1](df, {"separator": "."}, None)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001
            flat[ds_id] = df
    pks: dict[str, str] = {}
    for ds_id, prof in meta.analysis.profiles.items():
        pk = _pk(prof)
        if pk:
            pks[ds_id] = pk["column"]
    rels = []
    for parent_id, pk_col in pks.items():
        parent = flat.get(parent_id)
        if parent is None or pk_col not in parent.columns:
            continue
        parent_vals = set(parent[pk_col].cast(pl.Utf8).drop_nulls().str.strip_chars().str.to_uppercase().unique().to_list())
        if not parent_vals:
            continue
        parent_ds = meta.dataset(parent_id)
        pnorm = _norm_name(pk_col)
        for child_id, child in flat.items():
            if child_id == parent_id:
                continue
            for col in child.columns:
                if col == "__row_id" or child.schema[col] != pl.Utf8:
                    continue
                leaf = _norm_name(col.split(".")[-1])
                entity = meta.analysis.entities.get(parent_id, "")
                name_match = leaf == pnorm or (entity and leaf in (f"{entity}id", f"{entity}ref", f"{entity}key")) or (pnorm.endswith("id") and leaf == pnorm)
                if not name_match and leaf not in ("vin",):
                    continue
                vals = child[col].cast(pl.Utf8).drop_nulls().str.strip_chars().str.to_uppercase()
                vals = vals.filter(vals != "")
                if not vals.len():
                    continue
                uniq = set(vals.unique().to_list())
                match = len(uniq & parent_vals) / len(uniq)
                if match < 0.5:
                    continue
                orphan_rows = int((~vals.is_in(list(parent_vals))).sum())
                rels.append({
                    "from_dataset": child_id, "from_column": col, "to_dataset": parent_id, "to_column": pk_col,
                    "match_pct": round(match * 100, 1), "orphan_rows": orphan_rows,
                    "cardinality": "many-to-one", "confidence": round(min(0.99, 0.5 + match / 2), 2),
                    "label": f"{meta.dataset(child_id).name}.{col} → {parent_ds.name if parent_ds else parent_id}.{pk_col}",
                })
    rels.sort(key=lambda r: -r["match_pct"])
    return rels


# =========================================================================== insights
def build_insights(meta: PipelineMetadata) -> list[Insight]:
    out: list[Insight] = []
    for ds in meta.selected_datasets():
        prof = meta.analysis.profiles.get(ds.id)
        if not prof:
            continue
        entity = meta.analysis.entities.get(ds.id, "record")
        n = prof["row_count"]
        label = {"customer": "customer master data", "order": "sales order transactions", "vehicle": "a vehicle registry",
                 "service": "service / maintenance history", "product": "product master data", "employee": "employee records",
                 "incident": "support incidents", "dealer": "dealer / location master data", "recall": "vehicle recall notices",
                 "lead": "marketing leads"}.get(entity, "operational records")
        out.append(Insight(dataset_id=ds.id, severity="info", title=f"{ds.name} appears to represent {label}.",
                           detail=f"{n:,} records × {prof['column_count']} columns. Quality score {prof['quality']['score']:.0f}%.", confidence=0.85))
        pk = _pk(prof)
        if pk:
            out.append(Insight(dataset_id=ds.id, severity="success", title=f"{pk['column']} appears to be the primary key with {pk['confidence'] * 100:.1f}% confidence.",
                               detail=pk["reason"], confidence=pk["confidence"]))
            if pk["duplicates"]:
                out.append(Insight(dataset_id=ds.id, severity="warning", title=f"{pk['duplicates']:,} records share a {pk['column']} with another record.",
                                   detail=f"{prof['duplicate_rows']:,} of them are exact duplicate rows."))
        elif prof["duplicate_rows"]:
            out.append(Insight(dataset_id=ds.id, severity="warning", title=f"{prof['duplicate_rows']:,} exact duplicate records found."))
        for c in prof["columns"]:
            if c["is_nested"]:
                continue
            name, st = c["name"], c["semantic_type"]
            if c["null_pct"] >= 1 and st != "empty":
                out.append(Insight(dataset_id=ds.id, severity="warning" if c["null_pct"] > 10 else "info",
                                   title=f"{name} has {_pct(c['null_pct'])} missing values.", detail=f"{c['null_count']:,} empty cells."))
            if c.get("invalid_count"):
                ex = ", ".join(f"'{e}'" for e in c.get("invalid_examples", [])[:3])
                out.append(Insight(dataset_id=ds.id, severity="warning", title=f"{c['invalid_count']:,} {name} values are invalid.", detail=f"Examples: {ex}"))
            if st == "phone" and c.get("pattern_count", 1) > 2:
                out.append(Insight(dataset_id=ds.id, severity="warning", title=f"{name} contains inconsistent formats.",
                                   detail=f"{c['pattern_count']} different formats; the most common covers only {_pct(c.get('pattern_consistency', 0))}. Country codes are mixed."))
            if st in ("date", "date_of_birth") and c.get("pattern_count", 1) > 1 and c["dtype"] == "String":
                out.append(Insight(dataset_id=ds.id, severity="warning", title=f"{name} uses {c['pattern_count']} different date formats.",
                                   detail=f"Range {c.get('date_min')} → {c.get('date_max')}."))
            if st == "country":
                canon = {(country_lookup(t["value"]) or {}).get("name", t["value"]) for t in c.get("top_values", [])}
                if c.get("distinct_count", 0) > len(canon):
                    out.append(Insight(dataset_id=ds.id, severity="warning", title=f"{name} uses {c['distinct_count']} spellings for {len(canon)} countries.",
                                       detail="e.g. " + ", ".join(f"'{t['value']}'" for t in c.get("top_values", [])[:4])))
            if st in ("category", "boolean") and c.get("case_variant_values"):
                out.append(Insight(dataset_id=ds.id, severity="info", title=f"{name} has {c['case_variant_values']} values that differ only by case or spacing."))
            if c.get("negative_count") and st in ("currency", "decimal", "integer") and any(k in name.lower() for k in ("price", "amount", "revenue", "cost", "qty", "quantity")):
                out.append(Insight(dataset_id=ds.id, severity="critical", title=f"{name} has {c['negative_count']} negative values.",
                                   detail="Negative prices/amounts are usually data entry errors."))
            if c.get("outlier_count") and c["outlier_count"] > 0 and st in ("currency", "decimal"):
                out.append(Insight(dataset_id=ds.id, severity="info", title=f"{name} has {c['outlier_count']} statistical outliers.",
                                   detail=f"Typical range {c['outlier_bounds'][0]:,} – {c['outlier_bounds'][1]:,}."))
        text_typed = [c["name"] for c in prof["columns"] if c["dtype"] == "String" and c["semantic_type"] in ("integer", "decimal", "currency", "percentage", "boolean", "date", "date_of_birth", "timestamp")]
        if text_typed:
            out.append(Insight(dataset_id=ds.id, severity="info", title=f"{len(text_typed)} columns are stored as text but contain numbers, dates or yes/no values.",
                               detail=", ".join(text_typed[:6])))
        if prof["nested_columns"]:
            out.append(Insight(dataset_id=ds.id, severity="info", title=f"{len(prof['nested_columns'])} nested structures found ({', '.join(prof['nested_columns'][:4])}).",
                               detail="They can be flattened into regular columns automatically."))
        lowered: dict[str, list[str]] = {}
        for c in prof["columns"]:
            lowered.setdefault(_norm_name(c["name"]), []).append(c["name"])
        for variants in lowered.values():
            if len(variants) > 1:
                out.append(Insight(dataset_id=ds.id, severity="warning", title=f"Schema inconsistency: {' and '.join(variants)} are the same field.",
                                   detail="Some records use a different field name. They should be merged."))
        if prof["pii_columns"]:
            out.append(Insight(dataset_id=ds.id, severity="info", title=f"{len(prof['pii_columns'])} columns contain personal or sensitive data.",
                               detail=", ".join(prof["pii_columns"][:8])))
    for r in meta.analysis.relationships:
        out.append(Insight(dataset_id=r["from_dataset"], severity="success", title=f"Relationship found: {r['label']}",
                           detail=f"{r['match_pct']}% of values match." + (f" {r['orphan_rows']:,} rows reference records that don't exist." if r["orphan_rows"] else ""),
                           confidence=r["confidence"]))
    return out


# =========================================================================== transformation recommendations
def _rec(ds: DatasetRef, title: str, reason: str, impact: str, conf: float, benefit: str, explanation: str, transform: dict,
         *, preselect: bool = True, destructive: bool = False, rows: int | None = None, cols: list[str] | None = None, area: str = "transformation") -> Recommendation:
    return Recommendation(area=area, title=title, reason=reason, impact=impact, confidence=round(conf, 2), expected_benefit=benefit,
                          explanation=explanation, dataset_id=ds.id, action={"kind": "add_transform", "transform": transform},
                          preselected=preselect, destructive=destructive, affected_rows=rows, affected_columns=cols or [])


def recommend_transformations(meta: PipelineMetadata) -> list[Recommendation]:
    recs: list[Recommendation] = []
    for ds in meta.selected_datasets():
        prof = meta.analysis.profiles.get(ds.id)
        if not prof:
            continue
        n = max(prof["row_count"], 1)
        cols = {c["name"]: c for c in prof["columns"]}
        # 1. schema variants (CustomerID vs CustomerId)
        groups: dict[str, list[str]] = {}
        for c in prof["columns"]:
            groups.setdefault(_norm_name(c["name"]), []).append(c["name"])
        for variants in groups.values():
            if len(variants) > 1:
                keep = min(variants, key=lambda v: cols[v]["null_pct"])
                others = [v for v in variants if v != keep]
                recs.append(_rec(ds, f"Merge schema variants of {keep}", f"{', '.join(others)} hold the same field under a different name ({cols[others[0]]['null_pct']:.0f}% vs {cols[keep]['null_pct']:.0f}% empty).",
                                 "high", 0.95, "Completes the field and removes a confusing duplicate column.",
                                 "Source systems sometimes rename a field between exports (schema drift). Merging keeps one consistent column.",
                                 {"type": "schema_evolution_align", "params": {"target": keep, "sources": others}}, cols=variants))
        # 2. nested structures
        if prof["nested_columns"]:
            recs.append(_rec(ds, f"Flatten {len(prof['nested_columns'])} nested structures", f"{', '.join(prof['nested_columns'][:4])} contain nested objects/lists that most analytics tools can't query directly.",
                             "high", 0.93, "Every nested attribute becomes a regular, queryable column.",
                             "Nested JSON/XML is kept intact in Bronze; Silver gets a flat, analytics-ready structure.",
                             {"type": "flatten", "params": {"columns": prof["nested_columns"], "arrays": "join"}}, cols=prof["nested_columns"]))
        # 3. duplicates
        pk = _pk(prof)
        if pk and pk["duplicates"]:
            recency = _recency_column(prof)
            keep = "latest" if recency else "highest_quality"
            recs.append(_rec(ds, f"Remove duplicate {pk['column']} records", f"{pk['duplicates']:,} duplicate records detected ({prof['duplicate_rows']:,} exact copies).",
                             "high", min(0.97, pk["confidence"]), f"Guarantees one record per {pk['column']} so counts and joins are correct.",
                             f"{pk['column']} should be unique. We keep the {'most recent record (by ' + recency + ')' if recency else 'most complete record'} for each key — "
                             "the others are older or partial copies.",
                             {"type": "remove_duplicates", "params": {"columns": [pk["column"]], "keep": keep, **({"order_by": recency} if recency else {})}},
                             destructive=True, rows=pk["duplicates"], cols=[pk["column"]]))
        elif prof["duplicate_rows"]:
            recs.append(_rec(ds, "Remove exact duplicate records", f"{prof['duplicate_rows']:,} rows are exact copies of another row.", "high", 0.97,
                             "Prevents double counting.", "Identical rows add no information and inflate totals.",
                             {"type": "remove_duplicates", "params": {"columns": [], "keep": "first"}}, destructive=True, rows=prof["duplicate_rows"]))
        country_col = _country_col(prof)
        for c in prof["columns"]:
            if c["is_nested"]:
                continue
            name, st = c["name"], c["semantic_type"]
            if st == "identifier" and c.get("pattern_count", 1) > 1 and (c.get("whitespace_issues") or c.get("all_lower_count")):
                bad = (c.get("whitespace_issues") or 0) + (c.get("all_lower_count") or 0)
                if bad and bad < n * 0.5:
                    recs.append(_rec(ds, f"Standardize {name} codes", f"{bad:,} values have extra spaces or different casing (e.g. ' c10001').",
                                     "high", 0.9, "Keys match reliably across systems — joins stop silently dropping records.",
                                     "Identifiers must be byte-for-byte identical to join. We trim and upper-case them.",
                                     {"type": "standardize_codes", "params": {"columns": [name], "case": "upper"}}, rows=bad, cols=[name]))
            if st == "phone" and c.get("pattern_count", 1) > 2:
                inconsistent = 100 - (c.get("pattern_consistency") or 0)
                params: dict[str, Any] = {"column": name, "default_country": "US", "invalid": "null"}
                if country_col:
                    params["country_column"] = country_col
                recs.append(_rec(ds, f"Standardize {name.replace('_', ' ').lower()} numbers", f"{_pct(inconsistent)} of phone numbers use inconsistent formats ({c['pattern_count']} variants).",
                                 "medium", 0.9, "One international format (E.164) — ready for CRM, SMS and deduplication.",
                                 "Numbers like '(555) 123-4567', '555.123.4567' and '+1 555 123 4567' are the same. We convert all of them to +15551234567"
                                 + (f", using {country_col} to interpret local numbers." if country_col else "."),
                                 {"type": "standardize_phone", "params": params}, cols=[name]))
            if st == "email" and (c.get("invalid_count") or c.get("all_upper_count") or c.get("whitespace_issues")):
                recs.append(_rec(ds, f"Clean {name} addresses", f"{c.get('invalid_count', 0):,} invalid and {c.get('all_upper_count', 0):,} upper-case emails found.",
                                 "medium", 0.92, "Valid, lower-case emails improve matching and deliverability.",
                                 "Emails are case-insensitive, so we lower-case them. Values that can't be an email address (e.g. 'n/a', 'john@') are emptied rather than kept as bad data.",
                                 {"type": "validate_email", "params": {"column": name, "invalid": "null"}}, rows=c.get("invalid_count"), cols=[name]))
            if st == "email" and c["null_pct"] >= 1:
                recs.append(_rec(ds, f"Handle missing {name} values", f"{c['null_pct']:.1f}% of records have no {name}.", "low", 0.8,
                                 "Missing contact details become visible and reportable instead of silently empty.",
                                 "An email can't be guessed, so instead of inventing values we add a flag column that downstream teams can filter on.",
                                 {"type": "flag_missing", "params": {"columns": [name]}}, cols=[name]))
            if st in ("date", "date_of_birth") and c["dtype"] == "String":
                recs.append(_rec(ds, f"Standardize {name} dates", f"{c.get('pattern_count', 1)} different date formats detected.", "medium", 0.9,
                                 "Real date values — sortable, filterable and usable in time-based analysis.",
                                 "Dates like '03/12/1985', '12 Mar 1985' and '1985-03-12' are parsed into one true date type.",
                                 {"type": "parse_date", "params": {"columns": [name]}}, cols=[name]))
            if st == "country" and c.get("distinct_count", 0) > 1:
                canon = {(country_lookup(t["value"]) or {}).get("name", t["value"]) for t in c.get("top_values", [])}
                if c["distinct_count"] > len(canon):
                    recs.append(_rec(ds, f"Standardize {name.lower()} names", f"{c['distinct_count']} different spellings for {len(canon)} countries (e.g. 'USA', 'U.S.A.', 'United States').",
                                     "medium", 0.93, "Correct country totals and reliable geographic reporting.",
                                     "Each variant is mapped to its official name using the ISO 3166 reference list.",
                                     {"type": "standardize_country", "params": {"column": name, "output_format": "name"}}, cols=[name]))
            if st in ("category",) and c.get("case_variant_values"):
                recs.append(_rec(ds, f"Standardize {name} values", f"{c['case_variant_values']} values differ only by case or spacing (e.g. 'retail' vs 'Retail').",
                                 "low", 0.88, "Categories group correctly in reports.", "Variants are merged into their most common spelling.",
                                 {"type": "standardize_values", "params": {"column": name, "case": "title"}}, cols=[name]))
            if st == "person_name" and (c.get("whitespace_issues") or c.get("all_upper_count") or c.get("all_lower_count")):
                bad = (c.get("whitespace_issues") or 0) + (c.get("all_upper_count") or 0) + (c.get("all_lower_count") or 0)
                if bad:
                    recs.append(_rec(ds, f"Clean up {name.replace('_', ' ').lower()}s", f"{bad:,} names have extra spaces or ALL-CAPS / lower-case formatting.",
                                     "low", 0.85, "Consistent, presentable names.", "We trim spaces and apply Title Case.",
                                     {"type": "titlecase", "params": {"columns": [name]}}, cols=[name]))
            if st in ("currency", "decimal", "integer") and c.get("negative_count") and any(k in name.lower() for k in ("price", "amount", "revenue", "cost", "qty", "quantity")):
                recs.append(_rec(ds, f"Remove invalid records (negative {name})", f"{c['negative_count']} records have a negative {name}.", "medium", 0.82,
                                 "Revenue and margin reports stop being understated.", "A negative price is almost always a data-entry error; these rows are removed from Silver (Bronze keeps them).",
                                 {"type": "remove_invalid", "params": {"column": name, "check": "non_negative", "action": "remove"}}, destructive=True, rows=c["negative_count"], cols=[name]))
            if st == "category" and c["null_pct"] >= 2 and c["null_pct"] < 30:
                group = [country_col] if country_col and country_col != name else []
                recs.append(_rec(ds, f"Fill missing {name} values (AI-assisted)", f"{c['null_pct']:.1f}% of {name} is empty.", "low", 0.72,
                                 "Fewer 'unknown' buckets in reports.", f"We use the most common {name} among similar records" + (f" (same {country_col})." if group else "."),
                                 {"type": "smart_impute", "params": {"column": name, "group_by": group}}, preselect=False, cols=[name]))
        # 4. type conversion (numbers/booleans stored as text)
        conversions = []
        for c in prof["columns"]:
            if c["dtype"] != "String" or c["is_nested"]:
                continue
            st = c["semantic_type"]
            to = {"integer": "integer", "decimal": "decimal", "currency": "currency", "percentage": "percentage", "boolean": "boolean", "timestamp": "timestamp"}.get(st)
            if to and not (st == "integer" and c["name"].lower() in ("postal_code", "zip")):
                conversions.append({"column": c["name"], "to": to})
        if conversions:
            recs.append(_rec(ds, f"Convert {len(conversions)} data types", f"{', '.join(x['column'] for x in conversions[:4])}{'…' if len(conversions) > 4 else ''} are stored as text.",
                             "medium", 0.9, "Correct sorting, math and compact storage in Delta.",
                             "Values like '$1,234.50', '15%' and 'Yes' are converted to real numbers and true/false values.",
                             {"type": "convert_types", "params": {"conversions": conversions}}, cols=[x["column"] for x in conversions]))
        # 5. derived columns
        dob = next((c for c in prof["columns"] if c["semantic_type"] == "date_of_birth"), None)
        if dob:
            recs.append(_rec(ds, "Create Customer_Age" if meta.analysis.entities.get(ds.id) == "customer" else "Create Age", f"{dob['name']} is available — age is one of the most-used segmentation attributes.",
                             "low", 0.86, "Ready-made column for segmentation and analytics.", f"Age = whole years between {dob['name']} and today.",
                             {"type": "calculate_age", "params": {"column": dob["name"], "output": "customer_age" if meta.analysis.entities.get(ds.id) == "customer" else "age"}}, cols=[dob["name"]]))
        # 6. whitespace everywhere
        ws = [c["name"] for c in prof["columns"] if c.get("whitespace_issues") and c["semantic_type"] not in ("person_name", "email", "identifier")]
        if ws:
            recs.append(_rec(ds, "Trim extra spaces", f"{len(ws)} columns contain leading/trailing spaces.", "low", 0.95, "Clean values that match and group correctly.",
                             "Invisible spaces make 'USA' and ' USA ' look different to a computer.", {"type": "trim_whitespace", "params": {"columns": ws}}, cols=ws))
        # 7. naming convention
        if any(to_snake(c["name"]) != c["name"] for c in prof["columns"]):
            recs.append(_rec(ds, "Standardize column names to snake_case", "Column names mix upper/lower case and spaces.", "low", 0.8,
                             "Consistent Lakehouse naming — easy to query in SQL and BI tools.", "Unity Catalog best practice is lower_snake_case names.",
                             {"type": "standardize_column_names", "params": {"style": "snake"}}, preselect=False))
    order = {"high": 0, "medium": 1, "low": 2}
    recs.sort(key=lambda r: (order[r.impact], -r.confidence))
    return recs


# =========================================================================== quality rules
def recommend_quality_rules(meta: PipelineMetadata) -> list[QualityRule]:
    rules: list[QualityRule] = []
    for ds in meta.selected_datasets():
        prof = meta.analysis.profiles.get(ds.id)
        if not prof:
            continue
        pk = _pk(prof)
        if pk:
            rules.append(QualityRule(dataset_id=ds.id, column=pk["column"], dimension="completeness", rule="not_null", on_fail="quarantine", origin="ai",
                                     description=f"{pk['column']} must not be empty"))
            rules.append(QualityRule(dataset_id=ds.id, column=pk["column"], dimension="uniqueness", rule="unique", on_fail="warn", origin="ai",
                                     description=f"{pk['column']} must be unique"))
        for c in prof["columns"]:
            if c["is_nested"]:
                continue
            name, st = c["name"], c["semantic_type"]
            if st == "email":
                rules.append(QualityRule(dataset_id=ds.id, column=name, dimension="validity", rule="email", origin="ai", description=f"{name} must be a valid email"))
            elif st == "phone":
                rules.append(QualityRule(dataset_id=ds.id, column=name, dimension="validity", rule="phone", origin="ai", description=f"{name} must be a valid phone number"))
            elif st == "country":
                rules.append(QualityRule(dataset_id=ds.id, column=name, dimension="consistency", rule="in_reference", params={"reference": "iso_countries"}, origin="ai",
                                         description=f"{name} must exist in the ISO country reference list"))
            elif st in ("currency", "decimal", "integer") and any(k in name.lower() for k in ("price", "amount", "revenue", "cost", "quantity", "qty", "points")):
                rules.append(QualityRule(dataset_id=ds.id, column=name, dimension="range", rule="range", params={"min": 0}, on_fail="drop", origin="ai",
                                         description=f"{name} >= 0"))
            elif st == "date_of_birth":
                rules.append(QualityRule(dataset_id=ds.id, column=name, dimension="accuracy", rule="range", params={"min": "1900-01-01", "max": "today"}, origin="ai",
                                         description=f"{name} must be between 1900 and today"))
    for r in meta.analysis.relationships:
        rules.append(QualityRule(dataset_id=r["from_dataset"], column=r["from_column"], dimension="referential_integrity", rule="in_dataset",
                                 params={"dataset_id": r["to_dataset"], "column": r["to_column"]}, origin="ai",
                                 description=f"{r['from_column']} must exist in {meta.dataset(r['to_dataset']).name}.{r['to_column']}"))
    return rules


# =========================================================================== ingestion
def recommend_ingestion(meta: PipelineMetadata) -> dict:
    src = meta.source
    cat = src.category
    datasets = meta.selected_datasets()
    total_rows = sum(d.row_count or 0 for d in datasets)
    inc_field = next((d.incremental_field for d in datasets if d.incremental_field), None)
    cdc = any(d.cdc_capable for d in datasets)
    notes: list[str] = []
    formats = {d.format for d in datasets}
    if cat in ("file", "cloud_storage"):
        engine, mode = "auto_loader", "incremental"
        rationale = ("Recommended because this is a recurring file-based source and incremental ingestion is appropriate. "
                     "Auto Loader picks up only new files, tracks what's been processed and adapts when columns are added.")
        schema_evo = "rescue" if formats & {"json", "xml"} else "add_new_columns"
        notes.append("New files dropped into the landing folder are processed automatically.")
        if formats & {"json", "xml"}:
            notes.append("Unexpected fields in JSON/XML are kept in a rescued-data column instead of failing the load.")
        frequency = "daily"
    elif cat == "database":
        if cdc:
            engine, mode = "lakeflow_connect", "incremental"
            rationale = ("Recommended because the database supports Change Data Capture. Lakeflow Connect reads only inserts, updates and deletes "
                         "— minimal load on the source and near-real-time freshness.")
        else:
            engine, mode = "jdbc", "incremental" if inc_field else "full"
            rationale = (f"JDBC batch reads with incremental loading on '{inc_field}'." if inc_field else "JDBC batch reads with a full refresh (no reliable change column found).")
        schema_evo, frequency = "add_new_columns", "hourly" if cdc else "daily"
    elif cat == "application":
        engine, mode = "lakeflow_connect", "incremental"
        rationale = (f"Recommended because {src.name or 'this application'} has a managed Lakeflow Connect connector — Databricks handles the API, "
                     "rate limits, schema changes and incremental sync for you.")
        schema_evo, frequency = "add_new_columns", "hourly"
    elif cat == "api":
        engine, mode = "rest_api", "incremental" if inc_field else "full"
        rationale = ("Recommended because the source is a REST API. A scheduled serverless job pages through the API"
                     + (f" and only requests records changed since the last run ('{inc_field}')." if inc_field else "."))
        schema_evo, frequency = "rescue", "hourly"
    else:
        engine, mode, rationale, schema_evo, frequency = "batch", "full", "Batch processing.", "add_new_columns", "daily"
    compute = "serverless"
    partition: list[str] = []
    if total_rows > 50_000_000:
        compute = "large"
        notes.append("Large volume detected — a dedicated larger compute tier is recommended.")
    alternatives = [e for e in ["auto_loader", "lakeflow_connect", "batch", "streaming", "jdbc", "rest_api"] if e != engine]
    return {
        "engine": engine, "recommended_engine": engine, "rationale": rationale, "mode": mode, "incremental_field": inc_field,
        "cdc": bool(cdc and engine == "lakeflow_connect"), "frequency": frequency, "schema_evolution": schema_evo,
        "file_handling": "process_new_only", "partition_by": partition, "compute": compute, "retries": 3, "retry_delay_minutes": 5,
        "on_error": "quarantine", "checkpointing": True, "notes": notes, "alternatives": alternatives,
    }


# =========================================================================== lakehouse
def _slug(s: str) -> str:
    return to_snake(re.sub(r"[›>]", " ", s))[:60]


def design_lakehouse(meta: PipelineMetadata) -> dict:
    src_slug = _slug(meta.source.name or meta.source.connector or "source")
    tables: list[TableDesign] = []
    silver_by_entity: dict[str, TableDesign] = {}
    rationale: list[str] = []
    for ds in meta.selected_datasets():
        prof = meta.analysis.profiles.get(ds.id, {})
        entity = meta.analysis.entities.get(ds.id, "record")
        prefix = "" if meta.source.category == "file" else f"{src_slug}_"
        bronze = TableDesign(layer="bronze", name=f"{prefix}{_slug(ds.name)}_raw", description=f"Raw copy of {ds.name}, exactly as received, with load metadata.",
                             source_datasets=[ds.id], business_entity=entity, columns=[{"name": c["name"], "type": "string"} for c in prof.get("columns", [])])
        tables.append(bronze)
        base_name = ENTITY_TABLE.get(entity, _slug(ds.name))
        name = base_name if base_name not in {t.name for t in tables if t.layer == "silver"} else f"{base_name}_{_slug(ds.name)}"
        pk = _pk(prof) if prof else None
        recency = _recency_column(prof) if prof else None
        cluster = [to_snake(pk["column"])] if pk else []
        if recency and entity in ("order", "service", "incident"):
            cluster = [to_snake(recency)] + cluster
        silver = TableDesign(layer="silver", name=name, description=f"Cleaned, validated and standardized {entity} records.",
                             source_datasets=[ds.id], source_tables=[bronze.name], primary_key=[to_snake(pk["column"])] if pk else [],
                             cluster_by=cluster[:2], business_entity=entity,
                             partition_by=[to_snake(recency)] if (ds.row_count or 0) > 100_000_000 and recency else [])
        tables.append(silver)
        silver_by_entity.setdefault(entity, silver)
    rationale.append("Bronze keeps an immutable raw copy of every source for audit and replay.")
    rationale.append("Silver applies your approved transformations and data-quality rules — one clean table per business entity.")
    rationale.append("Liquid clustering on keys and dates instead of static partitions: faster queries with no tuning.")

    # Gold business models
    cust, orders = silver_by_entity.get("customer"), silver_by_entity.get("order")
    veh, svc = silver_by_entity.get("vehicle"), silver_by_entity.get("service")
    if cust and (orders or veh or svc):
        sources = [t for t in (cust, orders, veh, svc) if t]
        tables.append(TableDesign(layer="gold", name="customer_360", business_entity="customer",
                                  description="One row per customer with lifetime value, order history, vehicles owned and service activity.",
                                  source_tables=[t.name for t in sources], primary_key=cust.primary_key, cluster_by=cust.primary_key,
                                  gold_logic={"type": "entity_360", "base": cust.name, "key": cust.primary_key[:1],
                                              "related": [{"table": t.name, "entity": t.business_entity} for t in sources[1:]]}))
        rationale.append("customer_360 combines customers with their orders, vehicles and services into a single analytics-ready model.")
    if orders:
        tables.append(TableDesign(layer="gold", name="sales_daily_summary", business_entity="order",
                                  description="Daily revenue, order count and average order value by product category and channel.",
                                  source_tables=[orders.name], gold_logic={"type": "time_summary", "base": orders.name, "grain": "day"}))
    if svc:
        tables.append(TableDesign(layer="gold", name="service_kpis", business_entity="service",
                                  description="Monthly service volume, cost and most common service types.",
                                  source_tables=[svc.name], gold_logic={"type": "time_summary", "base": svc.name, "grain": "month"}))
    if veh and not cust:
        tables.append(TableDesign(layer="gold", name="fleet_overview", business_entity="vehicle", description="Vehicle counts by make, model, year and powertrain.",
                                  source_tables=[veh.name], gold_logic={"type": "dimension_summary", "base": veh.name}))
    if not any(t.layer == "gold" for t in tables):
        for s in [t for t in tables if t.layer == "silver"][:2]:
            tables.append(TableDesign(layer="gold", name=f"{s.name}_summary", business_entity=s.business_entity,
                                      description=f"Business-ready summary of {s.name}.", source_tables=[s.name], gold_logic={"type": "dimension_summary", "base": s.name}))
    rels = []
    sil = {t.source_datasets[0]: t for t in tables if t.layer == "silver" and t.source_datasets}
    for r in meta.analysis.relationships:
        a, b = sil.get(r["from_dataset"]), sil.get(r["to_dataset"])
        if a and b:
            rels.append({"from_table": a.name, "from_column": to_snake(r["from_column"].replace(".", "_")), "to_table": b.name,
                         "to_column": to_snake(r["to_column"]), "type": "foreign_key"})
    return {"tables": [t.model_dump() for t in tables], "relationships": rels, "rationale": rationale}


# =========================================================================== governance
PII_DEFAULT_ACTION = {"email": "mask", "phone": "mask", "date_of_birth": "mask", "government_id": "tokenize", "financial": "encrypt",
                      "address": "tag", "postal_code": "tag", "person_name": "tag"}


def recommend_governance(meta: PipelineMetadata) -> dict:
    pii: list[PiiField] = []
    for ds in meta.selected_datasets():
        prof = meta.analysis.profiles.get(ds.id)
        if not prof:
            continue
        for c in prof["columns"]:
            if c.get("pii"):
                pii.append(PiiField(dataset_id=ds.id, column=c["name"], category=c["pii"]["category"], confidence=c["pii"]["confidence"],
                                    action=PII_DEFAULT_ACTION.get(c["pii"]["category"], "tag")))
    policies = [AccessPolicy(group="data_engineers", privilege="ALL_PRIVILEGES", scope="all"),
                AccessPolicy(group="data_analysts", privilege="SELECT", scope="silver"),
                AccessPolicy(group="data_analysts", privilege="SELECT", scope="gold"),
                AccessPolicy(group="business_users", privilege="SELECT", scope="gold")]
    domain = next(iter(meta.analysis.entities.values()), "general")
    tags = {"domain": domain, "source_system": meta.source.name or meta.source.connector or "unknown",
            "classification": "confidential" if pii else "internal", "managed_by": "easyetl"}
    return {"pii": [p.model_dump() for p in pii], "access_policies": [a.model_dump() for a in policies], "tags": tags,
            "unity_catalog": True, "audit": True, "lineage": True, "column_masks": bool(pii)}
