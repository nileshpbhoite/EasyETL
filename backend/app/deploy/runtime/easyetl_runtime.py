"""EasyETL runtime for Databricks (Lakeflow Declarative Pipelines / PySpark).

This module is uploaded to the workspace with the pipeline's metadata JSON. It interprets the same
transformation metadata that EasyETL previews with Polars, so what users approved is exactly what runs.
Nothing in here is user-authored: it is a fixed, versioned library.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable

from pyspark.sql import Column, DataFrame, SparkSession, Window
from pyspark.sql import functions as F

DATE_FORMATS = ["yyyy-MM-dd", "MM/dd/yyyy", "dd MMM yyyy", "yyyy/MM/dd", "dd-MM-yyyy", "MMM dd, yyyy", "dd/MM/yyyy", "yyyyMMdd", "dd.MM.yyyy"]
EMAIL_RE = r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$"
COUNTRY_ALIASES = {
    "United States": ["usa", "us", "u.s.a.", "u.s.", "united states", "united states of america", "america"],
    "United Kingdom": ["uk", "u.k.", "united kingdom", "great britain", "gb", "gbr", "england", "britain"],
    "Germany": ["germany", "de", "deu", "deutschland"],
    "Canada": ["canada", "ca", "can"],
    "France": ["france", "fr", "fra"], "India": ["india", "in", "ind"], "Japan": ["japan", "jp", "jpn"],
}
FX_TO_USD = {"USD": 1.0, "EUR": 1.08, "GBP": 1.27, "CAD": 0.73, "JPY": 0.0067, "INR": 0.012, "AUD": 0.66, "CHF": 1.12}


def load_spec(path: str) -> dict:
    with open(path) as fh:
        return json.load(fh)


# ------------------------------------------------------------------ helpers
def _num(c: str) -> Column:
    return F.regexp_replace(F.trim(F.col(c).cast("string")), r"[$€£¥,\s%]", "").cast("double")


def _date(c: str) -> Column:
    s = F.trim(F.col(c).cast("string"))
    return F.coalesce(*[F.to_date(s, f) for f in DATE_FORMATS], F.to_date(F.to_timestamp(s)))


def _blank(c: str) -> Column:
    return F.col(c).isNull() | (F.trim(F.col(c).cast("string")) == "")


def _conf(key: str) -> str:
    """Secrets arrive through Spark config set from a Databricks secret scope ({{secrets/easyetl/...}}) — never in metadata."""
    return get_spark().conf.get(key, "")


def _cols(p: dict) -> list[str]:
    return p.get("columns") or ([p["column"]] if p.get("column") else [])


def _country_expr(c: str, fmt: str = "name") -> Column:
    key = F.lower(F.trim(F.col(c)))
    expr = None
    for name, aliases in COUNTRY_ALIASES.items():
        cond = key.isin(aliases + [name.lower()])
        expr = F.when(cond, F.lit(name)) if expr is None else expr.when(cond, F.lit(name))
    return expr.otherwise(F.col(c))


def _condition(cond: dict) -> Column:
    c, op, v = cond["column"], cond.get("op", "equals"), cond.get("value")
    s = F.lower(F.trim(F.col(c).cast("string")))
    if op == "is_null":
        return _blank(c)
    if op == "is_not_null":
        return ~_blank(c)
    if op == "equals":
        return s == str(v).lower()
    if op == "not_equals":
        return s != str(v).lower()
    if op == "contains":
        return s.contains(str(v).lower())
    if op == "starts_with":
        return s.startswith(str(v).lower())
    if op == "ends_with":
        return s.endswith(str(v).lower())
    if op in ("in_list", "not_in_list"):
        items = [x.strip().lower() for x in (v if isinstance(v, list) else str(v).split(","))]
        e = s.isin(items)
        return e if op == "in_list" else ~e
    num = _num(c)
    if op == "between":
        return num.between(float(v), float(cond.get("value2")))
    return {"gt": num > float(v), "gte": num >= float(v), "lt": num < float(v), "lte": num <= float(v)}[op]


def _conditions(conds: list[dict], logic: str) -> Column:
    out = None
    for c in conds:
        e = F.coalesce(_condition(c), F.lit(False))
        out = e if out is None else (out & e if logic == "and" else out | e)
    return out if out is not None else F.lit(True)


def _expression(node: dict) -> Column:
    t = node["type"]
    if t == "column":
        return F.col(node["name"])
    if t == "literal":
        return F.lit(node.get("value"))
    if t == "not":
        return ~_expression(node["arg"])
    if t == "if":
        return F.when(_expression(node["condition"]), _expression(node["then"])).otherwise(_expression(node["else"]) if node.get("else") else F.lit(None))
    if t == "op":
        l, r = _expression(node["left"]), _expression(node["right"])
        return {"+": l + r, "-": l - r, "*": l * r, "/": l / r, "%": l % r, "==": l == r, "!=": l != r, ">": l > r, "<": l < r,
                ">=": l >= r, "<=": l <= r, "and": l & r, "or": l | r}[node["op"]]
    args = [_expression(a) for a in node.get("args", [])]
    name = node["name"]
    simple: dict[str, Callable[..., Column]] = {
        "upper": F.upper, "lower": F.lower, "trim": F.trim, "length": F.length, "abs": F.abs, "floor": F.floor, "ceil": F.ceil,
        "year": lambda a: F.year(F.to_date(a)), "month": lambda a: F.month(F.to_date(a)), "day": lambda a: F.dayofmonth(F.to_date(a)),
        "quarter": lambda a: F.quarter(F.to_date(a)), "to_text": lambda a: a.cast("string"), "to_number": lambda a: a.cast("double"),
        "to_date": F.to_date, "is_empty": lambda a: a.isNull() | (F.trim(a) == ""),
    }
    if name in simple:
        return simple[name](*args)
    if name == "concat":
        return F.concat_ws("", *args)
    if name == "coalesce":
        return F.coalesce(*args)
    if name == "today":
        return F.current_date()
    if name == "days_between":
        return F.datediff(F.to_date(args[1]), F.to_date(args[0]))
    if name == "years_between":
        return F.floor(F.months_between(F.to_date(args[1]), F.to_date(args[0])) / 12)
    if name == "add_days":
        return F.date_add(F.to_date(args[0]), args[1].cast("int"))
    if name == "round":
        return F.round(args[0], int(node["args"][1].get("value", 0)))
    raise ValueError(f"Unsupported expression {name}")


# ------------------------------------------------------------------ transformations
def apply_step(df: DataFrame, step: dict, load: Callable[[str], DataFrame]) -> DataFrame:  # noqa: C901 - dispatch table
    t, p = step["type"], step.get("params") or {}
    cols = _cols(p)
    if t == "trim_whitespace":
        targets = cols or [f.name for f in df.schema.fields if f.dataType.simpleString() == "string"]
        return df.select(*[F.trim(F.col(c)).alias(c) if c in targets else F.col(c) for c in df.columns])
    if t in ("uppercase", "lowercase", "remove_whitespace"):
        fn = {"uppercase": F.upper, "lowercase": F.lower, "remove_whitespace": lambda c: F.regexp_replace(c, r"\s+", "")}[t]
        return df.select(*[fn(F.col(c)).alias(c) if c in cols else F.col(c) for c in df.columns])
    if t == "titlecase":
        return df.select(*[F.initcap(F.trim(F.col(c))).alias(c) if c in cols else F.col(c) for c in df.columns])
    if t == "find_replace":
        pat = ("(?i)" if not p.get("match_case") else "") + re.escape(p["find"])
        return df.select(*[F.regexp_replace(F.col(c), pat, p.get("replace") or "").alias(c) if c in cols else F.col(c) for c in df.columns])
    if t in ("remove_special_characters", "regex_replace"):
        pat = p.get("pattern") or rf"[^\w\s{re.escape(p.get('keep') or '')}]"
        return df.select(*[F.regexp_replace(F.col(c), pat, p.get("replacement") or "").alias(c) if c in cols else F.col(c) for c in df.columns])
    if t == "normalize_strings":
        return df.select(*[F.trim(F.regexp_replace(F.col(c), r"\s+", " ")).alias(c) if c in cols else F.col(c) for c in df.columns])
    if t == "standardize_codes":
        fn = F.upper if p.get("case", "upper") == "upper" else F.lower if p.get("case") == "lower" else (lambda x: x)
        return df.select(*[fn(F.regexp_replace(F.col(c), r"\s+", "")).alias(c) if c in cols else F.col(c) for c in df.columns])
    if t == "standardize_values":
        c = p["column"]
        key = F.lower(F.regexp_replace(F.trim(F.col(c)), r"[^\w]", ""))
        w = Window.partitionBy("__k").orderBy(F.desc("__n"))
        canon = df.select(key.alias("__k"), F.trim(F.col(c)).alias("__v")).groupBy("__k", "__v").count().withColumnRenamed("count", "__n") \
            .withColumn("__r", F.row_number().over(w)).filter("__r = 1").select("__k", F.initcap("__v").alias("__canon") if p.get("case") == "title" else F.col("__v").alias("__canon"))
        return df.withColumn("__k", key).join(F.broadcast(canon), "__k", "left").withColumn(c, F.coalesce("__canon", F.col(c))).drop("__k", "__canon")
    if t == "replace_values":
        mapping = p.get("mapping") or {}
        expr = F.col(p["column"])
        for k, v in mapping.items():
            expr = F.when(F.col(p["column"]) == k, F.lit(v)).otherwise(expr)
        return df.withColumn(p["column"], expr)
    if t == "standardize_phone":
        c = p["column"]
        digits = F.regexp_replace(F.col(c), r"\D", "")
        e164 = F.when(F.col(c).startswith("+"), F.concat(F.lit("+"), digits)) \
            .when(F.col(c).startswith("00"), F.concat(F.lit("+"), F.expr(f"substring(regexp_replace(`{c}`, '\\\\D', ''), 3)"))) \
            .when(F.length(digits) == 10, F.concat(F.lit("+1"), digits)) \
            .when((F.length(digits) == 11) & digits.startswith("1"), F.concat(F.lit("+"), digits))
        return df.withColumn(c, e164)
    if t == "validate_email":
        c = p["column"]
        clean = F.lower(F.regexp_replace(F.col(c), r"\s+", ""))
        if p.get("invalid", "null") == "null":
            return df.withColumn(c, F.when(clean.rlike(EMAIL_RE), clean))
        return df.withColumn(c, clean).withColumn(f"{c}_is_valid", F.coalesce(clean.rlike(EMAIL_RE), F.lit(False)))
    if t == "standardize_country":
        return df.withColumn(p["column"], _country_expr(p["column"], p.get("output_format", "name")))
    if t == "standardize_boolean":
        for c in cols:
            s = F.lower(F.trim(F.col(c)))
            df = df.withColumn(c, F.when(s.isin("true", "t", "yes", "y", "1", "on"), True).when(s.isin("false", "f", "no", "n", "0", "off"), False))
        return df
    if t == "convert_types":
        for conv in p.get("conversions") or []:
            c, to = conv["column"], conv["to"]
            expr = {"string": F.col(c).cast("string"), "integer": F.round(_num(c)).cast("bigint"), "decimal": _num(c).cast("decimal(38,6)"),
                    "currency": _num(c).cast("decimal(18,2)"), "percentage": F.when(F.col(c).endswith("%") | (_num(c) > 1), _num(c) / 100).otherwise(_num(c)),
                    "boolean": F.lower(F.trim(F.col(c))).isin("true", "t", "yes", "y", "1"), "date": _date(c), "timestamp": F.to_timestamp(F.col(c))}[to]
            df = df.withColumn(c, expr)
        return df
    if t == "parse_date":
        for c in cols:
            df = df.withColumn(c, _date(c))
        return df
    if t == "standardize_date":
        java = p.get("format", "%Y-%m-%d").replace("%Y", "yyyy").replace("%m", "MM").replace("%d", "dd").replace("%b", "MMM")
        return df.withColumn(p["column"], F.date_format(_date(p["column"]), java))
    if t == "extract_date_part":
        c, part = p["column"], p.get("part", "year")
        d = _date(c)
        expr = {"year": F.year(d), "month": F.month(d), "quarter": F.quarter(d), "day": F.dayofmonth(d), "day_of_week": F.date_format(d, "EEEE"),
                "week": F.weekofyear(d), "month_name": F.date_format(d, "MMMM")}[part]
        return df.withColumn(p.get("output") or f"{c}_{part}", expr)
    if t == "calculate_age":
        return df.withColumn(p.get("output") or "age", F.floor(F.months_between(F.current_date(), _date(p["column"])) / 12).cast("int"))
    if t == "date_difference":
        end = _date(p["end_column"]) if p.get("end_column") else F.current_date()
        days = F.datediff(end, _date(p["start_column"]))
        unit = p.get("unit", "days")
        expr = {"days": days, "weeks": F.floor(days / 7), "months": F.floor(days / 30.4375), "years": F.floor(days / 365.25)}[unit]
        return df.withColumn(p.get("output") or f"{unit}_between", expr)
    if t == "fiscal_period":
        d, start = _date(p["column"]), int(p.get("start_month") or 1)
        shifted = (F.month(d) - start + 12) % 12
        if p.get("part") == "fiscal_quarter":
            expr = F.concat(F.lit("FQ"), (F.floor(shifted / 3) + 1).cast("string"))
        else:
            expr = F.concat(F.lit("FY"), (F.year(d) + F.when(F.month(d) >= start, F.lit(1 if start > 1 else 0)).otherwise(0)).cast("string"))
        return df.withColumn(p.get("output") or f"{p['column']}_{p.get('part', 'fiscal_year')}", expr)
    if t == "flag_missing":
        for c in cols:
            df = df.withColumn(f"{c}_is_missing", _blank(c))
        return df
    if t == "drop_missing":
        blanks = [_blank(c) for c in cols]
        cond = blanks[0]
        for b in blanks[1:]:
            cond = (cond | b) if p.get("how", "any") == "any" else (cond & b)
        return df.filter(~cond)
    if t in ("fill_constant", "fill_zero", "fill_mean", "fill_median", "fill_mode"):
        for c in cols:
            if t == "fill_constant":
                v = F.lit(p.get("value"))
            elif t == "fill_zero":
                v = F.lit(0)
            elif t == "fill_mode":
                row = df.filter(~_blank(c)).groupBy(c).count().orderBy(F.desc("count")).first()
                v = F.lit(row[0] if row else None)
            else:
                agg = F.mean(_num(c)) if t == "fill_mean" else F.percentile_approx(_num(c), 0.5)
                v = F.lit(df.select(agg).first()[0])
            df = df.withColumn(c, F.when(_blank(c), v.cast(df.schema[c].dataType)).otherwise(F.col(c)))
        return df
    if t in ("forward_fill", "backward_fill"):
        order = p.get("order_by") or "__row_id"
        w = Window.orderBy(order).rowsBetween(Window.unboundedPreceding, 0) if t == "forward_fill" else Window.orderBy(order).rowsBetween(0, Window.unboundedFollowing)
        fn = F.last if t == "forward_fill" else F.first
        for c in cols:
            df = df.withColumn(c, fn(F.when(~_blank(c), F.col(c)), ignorenulls=True).over(w))
        return df
    if t == "smart_impute":
        c, groups = p["column"], p.get("group_by") or []
        w = Window.partitionBy(*groups) if groups else Window.partitionBy(F.lit(1))
        mode = F.first(F.when(~_blank(c), F.col(c)), ignorenulls=True).over(w)
        return df.withColumn(c, F.when(_blank(c), mode).otherwise(F.col(c)))
    if t == "remove_duplicates":
        keys = cols or [c for c in df.columns if c not in ("__row_id", "_rescued_data", "_ingested_at")]
        keep = p.get("keep", "first")
        if keep == "first":
            return df.dropDuplicates(keys)
        order = {"last": F.desc("__row_id"), "latest": F.desc_nulls_last(_date(p["order_by"])) if p.get("order_by") else F.desc("__row_id"),
                 "highest_quality": F.desc(sum(F.when(~_blank(c), 1).otherwise(0) for c in df.columns))}[keep]
        w = Window.partitionBy(*keys).orderBy(order)
        return df.withColumn("__rn", F.row_number().over(w)).filter("__rn = 1").drop("__rn")
    if t == "flag_duplicates":
        keys = cols or df.columns
        return df.withColumn(p.get("output") or "is_duplicate", F.count("*").over(Window.partitionBy(*keys)) > 1)
    if t == "filter_rows":
        cond = _conditions(p.get("conditions") or [], p.get("logic", "and"))
        return df.filter(cond if p.get("mode", "keep") == "keep" else ~cond)
    if t == "remove_invalid":
        c, check = p["column"], p.get("check")
        valid = {"email": F.col(c).rlike(EMAIL_RE) | _blank(c), "not_null": ~_blank(c), "non_negative": F.coalesce(_num(c) >= 0, F.lit(True)),
                 "number": _num(c).isNotNull() | _blank(c), "date": _date(c).isNotNull() | _blank(c),
                 "phone": F.length(F.regexp_replace(F.col(c), r"\D", "")).between(7, 15) | _blank(c)}.get(check, F.lit(True))
        return df.filter(valid) if p.get("action", "remove") == "remove" else df.withColumn(f"{c}_is_valid", valid)
    if t == "sort_rows":
        return df.orderBy(*[F.desc(k["column"]) if k.get("descending") else F.asc(k["column"]) for k in p.get("keys") or []])
    if t == "limit_rows":
        return df.limit(int(p.get("n") or 100))
    if t in ("join", "lookup", "fuzzy_join", "reference_lookup"):
        right = load(p["right_dataset"])
        lo = p.get("left_on") if isinstance(p.get("left_on"), list) else [p.get("left_on") or p.get("column")]
        ro = p.get("right_on") if isinstance(p.get("right_on"), list) else [p.get("right_on")]
        if p.get("columns"):
            right = right.select(*dict.fromkeys(ro + p["columns"]))
        cond = [F.upper(F.trim(df[a])) == F.upper(F.trim(right[b])) for a, b in zip(lo, ro)]
        how = {"left": "left", "inner": "inner", "right": "right", "full": "full", "semi": "left_semi", "anti": "left_anti", "cross": "cross"}.get(p.get("how", "left"), "left")
        if how == "cross":
            return df.crossJoin(right)
        out = df.join(right, cond, how)
        return out.drop(*[right[b] for b in ro if b in df.columns]) if how not in ("left_semi", "left_anti") else out
    if t in ("union", "union_all"):
        out = df
        for d in p.get("datasets") or []:
            out = out.unionByName(load(d), allowMissingColumns=True)
        return out.distinct() if t == "union" else out
    if t == "aggregate":
        aggs = []
        for a in p.get("aggregations") or []:
            c, fn = a.get("column"), a.get("fn", "count")
            alias = a.get("alias") or (f"{fn}_{c}" if c else fn)
            if fn == "count":
                aggs.append((F.count(c) if c else F.count("*")).alias(alias))
            elif fn == "count_distinct":
                aggs.append(F.countDistinct(c).alias(alias))
            elif fn.startswith("p") and fn[1:].isdigit():
                aggs.append(F.percentile_approx(_num(c), int(fn[1:]) / 100).alias(alias))
            else:
                f = {"sum": F.sum, "mean": F.avg, "min": F.min, "max": F.max, "median": F.median, "std": F.stddev, "first": F.first, "last": F.last}[fn]
                aggs.append(f(_num(c) if fn not in ("first", "last") else F.col(c)).alias(alias))
        return df.groupBy(*(p.get("group_by") or [])).agg(*aggs)
    if t == "window":
        part, order, fn, c = p.get("partition_by") or [], p.get("order_by"), p.get("fn", "row_number"), p.get("column")
        w = Window.partitionBy(*part).orderBy(order) if order else Window.partitionBy(*part).orderBy(F.monotonically_increasing_id())
        running = w.rowsBetween(Window.unboundedPreceding, 0)
        expr = {"row_number": F.row_number().over(w), "rank": F.rank().over(w), "dense_rank": F.dense_rank().over(w),
                "running_sum": F.sum(_num(c)).over(running) if c else None, "running_avg": F.avg(_num(c)).over(running) if c else None,
                "moving_avg": F.avg(_num(c)).over(w.rowsBetween(-(int(p.get("window_size") or 3) - 1), 0)) if c else None,
                "lag": F.lag(c).over(w) if c else None, "lead": F.lead(c).over(w) if c else None,
                "pct_of_total": (_num(c) / F.sum(_num(c)).over(Window.partitionBy(*part)) * 100) if c else None}[fn]
        return df.withColumn(p.get("output") or fn, expr)
    if t == "pivot":
        c = p["columns"] if isinstance(p["columns"], str) else p["columns"][0]
        agg = {"sum": F.sum, "mean": F.avg, "count": F.count, "min": F.min, "max": F.max, "first": F.first}[p.get("agg", "sum")]
        return df.groupBy(*p["index"]).pivot(c).agg(agg(_num(p["values"]) if p.get("agg") not in ("count", "first") else F.col(p["values"])))
    if t in ("unpivot", "melt"):
        ids = p["id_columns"]
        values = p.get("value_columns") or [c for c in df.columns if c not in ids]
        return df.unpivot(ids, values, p.get("variable_name") or "attribute", p.get("value_name") or "value")
    if t == "crosstab":
        return df.crosstab(p["row"], p["column"])
    if t == "rename_columns":
        for old, new in (p.get("mapping") or {}).items():
            df = df.withColumnRenamed(old, new)
        return df
    if t == "standardize_column_names":
        for c in df.columns:
            new = re.sub(r"_+", "_", re.sub(r"[^\w]+", "_", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", c.strip()))).strip("_").lower()
            df = df.withColumnRenamed(c, new)
        return df
    if t in ("drop_columns", "restrict"):
        return df.drop(*cols)
    if t == "select_columns":
        return df.select(*cols)
    if t == "add_column":
        v = F.current_timestamp() if p.get("value_type") == "current_timestamp" else F.lit(p.get("value"))
        return df.withColumn(p.get("output") or "new_column", v)
    if t == "reorder_columns":
        first = [c for c in p.get("order") or [] if c in df.columns]
        return df.select(*first, *[c for c in df.columns if c not in first])
    if t == "flatten":
        sep = p.get("separator") or "_"
        for _ in range(8):
            structs = [f for f in df.schema.fields if f.dataType.typeName() == "struct"]
            if not structs:
                break
            sel = []
            for f in df.schema.fields:
                if f.dataType.typeName() == "struct":
                    sel += [F.col(f"`{f.name}`.`{sf.name}`").alias(f"{f.name}{sep}{sf.name}") for sf in f.dataType.fields]
                else:
                    sel.append(F.col(f"`{f.name}`"))
            df = df.select(*sel)
        if p.get("arrays", "join") == "join":
            for f in df.schema.fields:
                if f.dataType.typeName() == "array" and f.dataType.elementType.typeName() != "struct":
                    df = df.withColumn(f.name, F.concat_ws(", ", F.col(f.name).cast("array<string>")))
        return df
    if t == "explode":
        return df.withColumn(p["column"], F.explode_outer(p["column"]))
    if t == "extract_field":
        return df.withColumn(p.get("output") or f"{p['column']}_{p['path'].replace('.', '_')}", F.col(f"{p['column']}.{p['path']}"))
    if t == "schema_evolution_align":
        return df.withColumn(p["target"], F.coalesce(*[F.when(~_blank(c), F.col(c)) for c in [p["target"]] + p["sources"]])).drop(*p["sources"])
    if t == "schema_mapping":
        for m in p.get("mappings") or []:
            df = df.withColumnRenamed(m["source"], m.get("target") or m["source"])
        return df
    if t in ("split_column",):
        names = [n.strip() for n in (p.get("into") or "").split(",") if n.strip()] or [f"{p['column']}_1", f"{p['column']}_2"]
        parts = F.split(F.col(p["column"]), re.escape(p.get("delimiter", " ")))
        for i, n in enumerate(names):
            df = df.withColumn(n, F.trim(parts.getItem(i)))
        return df if p.get("keep_original", True) else df.drop(p["column"])
    if t == "merge_columns":
        return df.withColumn(p.get("output") or "merged", F.concat_ws(p.get("separator", " "), *[F.trim(F.col(c)) for c in cols]))
    if t == "extract_substring":
        return df.withColumn(p.get("output") or f"{p['column']}_part", F.substring(p["column"], int(p.get("start") or 1), int(p.get("length") or 1)))
    if t == "extract_before":
        return df.withColumn(p.get("output") or f"{p['column']}_before", F.substring_index(p["column"], p["delimiter"], 1))
    if t == "extract_after":
        return df.withColumn(p.get("output") or f"{p['column']}_after", F.expr(f"substring(`{p['column']}`, instr(`{p['column']}`, '{p['delimiter']}') + 1)"))
    if t == "regex_extract":
        pat = p["pattern"] if "(" in p["pattern"] else f"({p['pattern']})"
        return df.withColumn(p.get("output") or f"{p['column']}_extract", F.regexp_extract(p["column"], pat, 1))
    if t in ("add_prefix", "add_suffix"):
        for c in cols:
            df = df.withColumn(c, F.concat(F.lit(p["value"]), F.col(c)) if t == "add_prefix" else F.concat(F.col(c), F.lit(p["value"])))
        return df
    if t == "text_length":
        return df.withColumn(p.get("output") or f"{p['column']}_length", F.length(p["column"]))
    if t == "derive_column":
        return df.withColumn(p["output"], _expression(p["expression"]))
    if t == "conditional_column":
        expr = None
        for r in p.get("rules") or []:
            cond = _conditions(r.get("conditions") or [], r.get("logic", "and"))
            expr = F.when(cond, F.lit(r["value"])) if expr is None else expr.when(cond, F.lit(r["value"]))
        return df.withColumn(p["output"], expr.otherwise(F.lit(p.get("default") or None)))
    if t == "map_codes":
        expr = F.col(p["column"]) if not p.get("default") else F.lit(p["default"])
        for k, v in (p.get("mapping") or {}).items():
            expr = F.when(F.lower(F.trim(F.col(p["column"]))) == str(k).lower(), F.lit(v)).otherwise(expr)
        return df.withColumn(p.get("output") or f"{p['column']}_description", expr)
    if t == "currency_conversion":
        rate = None
        for code, r in FX_TO_USD.items():
            cond = F.upper(F.trim(F.col(p["currency_column"]))) == code
            rate = F.when(cond, F.lit(r)) if rate is None else rate.when(cond, F.lit(r))
        tgt = p.get("target", "USD")
        return df.withColumn(p.get("output") or f"{p['amount_column']}_{tgt.lower()}", F.round(_num(p["amount_column"]) * rate / FX_TO_USD[tgt], 2))
    if t == "classify_ranges":
        num, expr = _num(p["column"]), None
        for b in p.get("bins") or []:
            cond = F.lit(True)
            if b.get("min") not in (None, ""):
                cond = cond & (num >= float(b["min"]))
            if b.get("max") not in (None, ""):
                cond = cond & (num < float(b["max"]))
            expr = F.when(cond, F.lit(b["label"])) if expr is None else expr.when(cond, F.lit(b["label"]))
        return df.withColumn(p.get("output") or f"{p['column']}_band", expr)
    if t == "enrich_country":
        return df.withColumn(f"{p['column'].lower()}_standard", _country_expr(p["column"]))
    if t == "clip_outliers":
        c = p["column"]
        q1, q3 = df.select(F.percentile_approx(_num(c), [0.25, 0.75])).first()[0]
        k = float(p.get("factor") or 3)
        return df.withColumn(c, F.least(F.greatest(_num(c), F.lit(q1 - k * (q3 - q1))), F.lit(q3 + k * (q3 - q1))))
    if t == "mask":
        style = p.get("style", "partial")
        for c in cols:
            expr = F.lit("••••••") if style == "full" else F.concat(F.expr(f"repeat('•', greatest(length(`{c}`) - 4, 0))"), F.expr(f"right(`{c}`, 4)"))
            df = df.withColumn(c, F.when(F.col(c).isNotNull(), expr))
        return df
    if t == "hash":
        for c in cols:
            df = df.withColumn(c, F.sha2(F.concat(F.lit(_conf("easyetl.hash_salt")), F.col(c)), 256))
        return df
    if t == "tokenize":
        for c in cols:
            df = df.withColumn(c, F.concat(F.lit("tok_"), F.substring(F.sha2(F.col(c), 256), 1, 16)))
        return df
    if t == "encrypt":
        for c in cols:
            df = df.withColumn(c, F.base64(F.aes_encrypt(F.col(c), F.lit(_conf("easyetl.aes_key")))))
        return df
    raise ValueError(f"Transformation '{t}' is not supported by this runtime version")


def apply_steps(df: DataFrame, steps: list[dict], dataset_id: str, load: Callable[[str], DataFrame]) -> DataFrame:
    df = df.withColumn("__row_id", F.monotonically_increasing_id())
    for s in steps:
        if s["dataset_id"] == dataset_id:
            df = apply_step(df, s, load)
    return df.drop("__row_id") if "__row_id" in df.columns else df


# ------------------------------------------------------------------ data quality
# Every rule carries a Databricks SQL predicate ("sql") generated by EasyETL; rules that need more than one row
# (uniqueness, referential integrity) are evaluated with a window / join. NULL results count as passing.
ACTION_RANK = {"flag": 1, "quarantine": 2, "drop": 3, "fail": 4}
ACTIONS_BY_RANK = ["none", "flag", "quarantine", "drop", "fail"]
SEVERITY_WEIGHT = {"critical": 4, "high": 3, "medium": 2, "low": 1}
DQ_COLUMNS = ["_dq_issues", "_dq_action", "_dq_status"]


def dq_rules(spec: dict, dataset_id: str) -> list[dict]:
    out = []
    for r in spec.get("quality_rules", []):
        if r["dataset_id"] != dataset_id or not r.get("enabled", True):
            continue
        action = r.get("on_fail") or "flag"
        out.append({"id": r["id"], "name": (r.get("name") or r.get("description") or r["id"])[:200], "sql": r.get("sql"), "rule": r["rule"],
                    "column": r.get("column"), "params": r.get("params") or {}, "action": "flag" if action == "warn" else action,
                    "severity": r.get("severity", "medium"), "green": float(r.get("threshold_green", 99.0)), "amber": float(r.get("threshold_amber", 95.0))})
    return out


def _rule_passes(df: DataFrame, r: dict, load: Callable[[str], DataFrame]) -> tuple[Column, DataFrame]:
    if r.get("sql"):
        return F.coalesce(F.expr(r["sql"]), F.lit(True)), df
    c = r.get("column")
    if r["rule"] == "unique" and c:
        return F.col(c).isNull() | (F.count(F.lit(1)).over(Window.partitionBy(F.col(c))) == 1), df
    if r["rule"] == "in_dataset" and c:
        p = r["params"]
        flag = f"__ref_{r['id']}"
        keys = (load(p["dataset_id"]).select(F.upper(F.trim(F.col(p["column"]).cast("string"))).alias(f"{flag}_key")).distinct()
                .withColumn(flag, F.lit(True)))
        df = df.join(F.broadcast(keys), F.upper(F.trim(F.col(c).cast("string"))) == F.col(f"{flag}_key"), "left").drop(f"{flag}_key")
        return F.col(c).isNull() | F.col(flag).isNotNull(), df
    return F.lit(True), df


def add_dq_columns(df: DataFrame, rules: list[dict], load: Callable[[str], DataFrame]) -> DataFrame:
    """_dq_issues: names of the rules the record fails; _dq_action: the strictest action among them
    (none/flag/quarantine/drop/fail); _dq_status: PASSED or that action in capitals."""
    checks = []
    for r in rules:
        passes, df = _rule_passes(df, r, load)
        checks.append((r, passes))
    if checks:
        issues = F.filter(F.array(*[F.when(~p, F.lit(r["name"])) for r, p in checks]), lambda x: x.isNotNull())
        rank = F.greatest(F.lit(0), *[F.when(~p, F.lit(ACTION_RANK[r["action"]])).otherwise(F.lit(0)) for r, p in checks])
    else:
        issues, rank = F.array().cast("array<string>"), F.lit(0)
    df = df.withColumn("_dq_issues", issues)
    df = df.withColumn("_dq_action", F.element_at(F.array(*[F.lit(a) for a in ACTIONS_BY_RANK]), rank + 1))
    df = df.withColumn("_dq_status", F.when(F.size("_dq_issues") == 0, F.lit("PASSED")).otherwise(F.upper(F.col("_dq_action"))))
    return df.drop(*[c for c in df.columns if c.startswith("__ref_")])


def dq_results(df: DataFrame, rules: list[dict], table: str) -> DataFrame:
    """One row per rule: failed records, pass rate and Red/Amber/Green status for this pipeline update."""
    spark = get_spark()
    schema = "rule_id string, rule_name string, action string, severity string, green double, amber double, definition string"
    rules_df = spark.createDataFrame([(r["id"], r["name"], r["action"], r["severity"], r["green"], r["amber"], r.get("sql") or r["rule"]) for r in rules], schema)
    failed = df.select(F.explode("_dq_issues").alias("rule_name")).groupBy("rule_name").agg(F.count(F.lit(1)).alias("failed_records"))
    total = df.agg(F.count(F.lit(1)).alias("records"))
    pass_rate = F.when(F.col("records") > 0, F.round((1 - F.col("failed_records") / F.col("records")) * 100, 2)).otherwise(F.lit(100.0))
    return (rules_df.join(failed, "rule_name", "left").crossJoin(total).fillna(0, ["failed_records"])
            .withColumn("pass_rate", pass_rate)
            .withColumn("rag", F.when(F.col("pass_rate") >= F.col("green"), "GREEN").when(F.col("pass_rate") >= F.col("amber"), "AMBER").otherwise("RED"))
            .withColumn("table_name", F.lit(table)).withColumn("evaluated_at", F.current_timestamp()))


def dq_score(results: DataFrame) -> DataFrame:
    """Single-row severity-weighted DQ score for the table."""
    w = F.coalesce(*[F.when(F.col("severity") == k, F.lit(v)) for k, v in SEVERITY_WEIGHT.items()], F.lit(2))
    return (results.withColumn("_w", w)
            .agg((F.sum(F.col("pass_rate") * F.col("_w")) / F.sum("_w")).alias("dq_score"), F.sum("failed_records").alias("dq_issues"),
                 F.sum(F.when(F.col("rag") == "RED", 1).otherwise(0)).alias("red_rules"), F.max("evaluated_at").alias("evaluated_at"))
            .fillna({"dq_score": 100.0, "dq_issues": 0, "red_rules": 0}))


def expectations(spec: dict, dataset_id: str) -> dict[str, dict[str, str]]:
    """Legacy: rule SQL grouped by Lakeflow expectation action (kept for bundles generated before DQ columns)."""
    out: dict[str, dict[str, str]] = {"warn": {}, "drop": {}, "fail": {}}
    for r in dq_rules(spec, dataset_id):
        if r.get("sql"):
            out[{"flag": "warn", "quarantine": "drop", "drop": "drop", "fail": "fail"}[r["action"]]][r["name"]] = f"COALESCE(({r['sql']}), TRUE)"
    return out


def get_spark() -> SparkSession:
    return SparkSession.getActiveSession() or SparkSession.builder.getOrCreate()
