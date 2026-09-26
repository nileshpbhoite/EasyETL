"""The transformation library.

Each transformation is declared once with:
  • a `TransformSpec` — drives the visual configuration panel in the UI (no code for the user), and
  • a Polars implementation — powers instant Before/After previews.
The same metadata is interpreted on Databricks by the EasyETL runtime (app/deploy/runtime) with Spark.
"""
from __future__ import annotations

import base64
import difflib
import hashlib
import hmac
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable, Literal

import polars as pl
from pydantic import BaseModel, Field

from ..profiling.semantic import (
    COUNTRIES,
    EMAIL_RE,
    bool_expr,
    country_lookup,
    date_expr,
    datetime_expr,
    normalize_phone,
    numeric_expr,
    percent_expr,
)
from . import expressions


# ============================================================================ spec model
class ParamSpec(BaseModel):
    name: str
    label: str
    type: Literal["column", "columns", "text", "number", "select", "boolean", "mapping", "conditions", "sort_keys",
                  "aggregations", "expression", "dataset", "datasets", "column_types", "case_rules", "bins", "schema_map",
                  "survivorship", "rename_map", "column_order"]
    required: bool = False
    default: Any = None
    options: list[dict[str, str]] = Field(default_factory=list)
    column_kind: Literal["any", "text", "numeric", "date", "nested"] = "any"
    help: str | None = None
    advanced: bool = False
    placeholder: str | None = None


class TransformSpec(BaseModel):
    id: str
    category: str
    label: str
    description: str
    icon: str = "wand"
    params: list[ParamSpec] = Field(default_factory=list)
    row_preserving: bool = True
    destructive: bool = False
    multi_dataset: bool = False
    keywords: list[str] = Field(default_factory=list)


@dataclass
class TransformContext:
    load_dataset: Callable[[str], pl.DataFrame] | None = None
    secret_key: bytes = b"easyetl-dev-key"
    today: date = field(default_factory=date.today)


class TransformError(ValueError):
    pass


Impl = Callable[[pl.DataFrame, dict, TransformContext], pl.DataFrame]
REGISTRY: dict[str, tuple[TransformSpec, Impl]] = {}

CATEGORIES = [
    ("clean", "Clean & Standardize", "sparkles"), ("types", "Data Types", "binary"), ("text", "Text", "type"),
    ("datetime", "Date & Time", "calendar"), ("missing", "Missing Values", "circle-dashed"), ("duplicates", "Duplicates", "copy"),
    ("filter", "Filter & Sort", "filter"), ("join", "Joins & Merge", "merge"), ("aggregate", "Aggregate", "sigma"),
    ("pivot", "Pivot / Unpivot", "table"), ("schema", "Schema & Structure", "columns"), ("derived", "Derived Columns", "function"),
    ("enrich", "Enrichment", "globe"), ("quality", "Data Quality", "shield-check"), ("pii", "PII & Governance", "lock"),
]


def transform(id: str, category: str, label: str, description: str, params: list[ParamSpec] | None = None, **kw):
    def deco(fn: Impl) -> Impl:
        REGISTRY[id] = (TransformSpec(id=id, category=category, label=label, description=description, params=params or [], **kw), fn)
        return fn

    return deco


def P(name: str, label: str, type: str, **kw) -> ParamSpec:  # noqa: A002
    return ParamSpec(name=name, label=label, type=type, **kw)


def opts(*pairs: tuple[str, str] | str) -> list[dict[str, str]]:
    return [{"value": p, "label": p.replace("_", " ").capitalize()} if isinstance(p, str) else {"value": p[0], "label": p[1]} for p in pairs]


# ---------------------------------------------------------------- helpers
def _cols(df: pl.DataFrame, p: dict, key: str = "columns") -> list[str]:
    cols = p.get(key) or ([p["column"]] if p.get("column") else [])
    if isinstance(cols, str):
        cols = [cols]
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise TransformError(f"Column(s) not found: {', '.join(missing)}")
    return cols


def _str_cols(df: pl.DataFrame, p: dict) -> list[str]:
    cols = _cols(df, p)
    if not cols:
        cols = [c for c, t in df.schema.items() if t == pl.Utf8 and c != "__row_id"]
    return [c for c in cols if df.schema[c] == pl.Utf8]


def _out(p: dict, default: str) -> str:
    return (p.get("output") or "").strip() or default


def _s(col: str) -> pl.Expr:
    return pl.col(col).cast(pl.Utf8)


def _is_blank(col: str) -> pl.Expr:
    return pl.col(col).is_null() | (pl.col(col).cast(pl.Utf8).str.strip_chars() == "")


def _typed_compare(df: pl.DataFrame, col: str, value: Any) -> tuple[pl.Expr, Any]:
    """Pick numeric/date/string comparison automatically based on the value the user typed."""
    dtype = df.schema[col]
    if dtype.is_numeric():
        return pl.col(col), float(value)
    if dtype in (pl.Date,) or isinstance(dtype, pl.Datetime):
        return pl.col(col).cast(pl.Date), date.fromisoformat(str(value)[:10])
    try:
        return numeric_expr(col), float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        pass
    try:
        return date_expr(col), date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return _s(col), str(value)


def condition_expr(df: pl.DataFrame, cond: dict) -> pl.Expr:
    col, op, val, val2 = cond.get("column"), cond.get("op", "equals"), cond.get("value"), cond.get("value2")
    if col not in df.columns:
        raise TransformError(f"Column '{col}' not found")
    s = _s(col)
    case = cond.get("case_sensitive", False)
    sv = str(val) if val is not None else ""
    if op == "is_null":
        return _is_blank(col)
    if op == "is_not_null":
        return ~_is_blank(col)
    if op in ("equals", "not_equals"):
        if df.schema[col].is_numeric():
            e = pl.col(col) == float(val)
        else:
            e = (s == sv) if case else (s.str.to_lowercase().str.strip_chars() == sv.lower().strip())
        return e if op == "equals" else ~e.fill_null(False)
    if op in ("contains", "starts_with", "ends_with"):
        base = s if case else s.str.to_lowercase()
        needle = sv if case else sv.lower()
        return {"contains": base.str.contains(needle, literal=True), "starts_with": base.str.starts_with(needle),
                "ends_with": base.str.ends_with(needle)}[op]
    if op == "not_contains":
        return ~(s.str.to_lowercase().str.contains(sv.lower(), literal=True)).fill_null(False)
    if op in ("in_list", "not_in_list"):
        items = [x.strip().lower() for x in (val if isinstance(val, list) else sv.split(","))]
        e = s.str.to_lowercase().str.strip_chars().is_in(items)
        return e if op == "in_list" else ~e.fill_null(False)
    if op == "matches":
        return s.str.contains(sv)
    if op in ("gt", "gte", "lt", "lte", "between"):
        e, v = _typed_compare(df, col, val)
        if op == "between":
            _, v2 = _typed_compare(df, col, val2)
            return e.is_between(v, v2)
        return {"gt": e > v, "gte": e >= v, "lt": e < v, "lte": e <= v}[op]
    raise TransformError(f"Unknown condition '{op}'")


def combine_conditions(df: pl.DataFrame, conditions: list[dict], logic: str = "and") -> pl.Expr:
    exprs = [condition_expr(df, c).fill_null(False) for c in conditions]
    if not exprs:
        return pl.lit(True)
    out = exprs[0]
    for e in exprs[1:]:
        out = (out & e) if logic == "and" else (out | e)
    return out


CONDITION_OPS = opts(("equals", "equals"), ("not_equals", "does not equal"), ("gt", "greater than"), ("gte", "at least"),
                     ("lt", "less than"), ("lte", "at most"), ("between", "between"), ("contains", "contains"),
                     ("not_contains", "does not contain"), ("starts_with", "starts with"), ("ends_with", "ends with"),
                     ("in_list", "is one of"), ("not_in_list", "is not one of"), ("is_null", "is empty"),
                     ("is_not_null", "is not empty"), ("matches", "matches pattern"))
TYPE_OPTIONS = opts(("string", "Text"), ("integer", "Whole number"), ("decimal", "Decimal"), ("boolean", "True / False"),
                    ("date", "Date"), ("timestamp", "Date & time"), ("currency", "Currency amount"), ("percentage", "Percentage"))

# ============================================================================ Clean & Standardize
@transform("trim_whitespace", "clean", "Trim whitespace", "Remove leading and trailing spaces.",
           [P("columns", "Columns", "columns", column_kind="text", help="Leave empty to apply to all text columns.")], keywords=["strip", "spaces"])
def _trim(df, p, ctx):
    return df.with_columns([pl.col(c).str.strip_chars() for c in _str_cols(df, p)])


@transform("remove_whitespace", "clean", "Remove all whitespace", "Remove every space character (useful for codes and IDs).",
           [P("columns", "Columns", "columns", column_kind="text", required=True)])
def _rmws(df, p, ctx):
    return df.with_columns([pl.col(c).str.replace_all(r"\s+", "") for c in _str_cols(df, p)])


@transform("uppercase", "clean", "UPPERCASE", "Convert text to upper case.", [P("columns", "Columns", "columns", column_kind="text", required=True)])
def _upper(df, p, ctx):
    return df.with_columns([pl.col(c).str.to_uppercase() for c in _str_cols(df, p)])


@transform("lowercase", "clean", "lowercase", "Convert text to lower case.", [P("columns", "Columns", "columns", column_kind="text", required=True)])
def _lower(df, p, ctx):
    return df.with_columns([pl.col(c).str.to_lowercase() for c in _str_cols(df, p)])


@transform("titlecase", "clean", "Title Case", "Capitalize Each Word — ideal for names and cities.",
           [P("columns", "Columns", "columns", column_kind="text", required=True)])
def _title(df, p, ctx):
    def fix(s: str | None) -> str | None:
        if s is None:
            return None
        s = re.sub(r"\s+", " ", s.strip())
        return re.sub(r"(^|[\s\-'’])([a-zà-ÿ])", lambda m: m.group(1) + m.group(2).upper(), s.lower())

    return df.with_columns([pl.col(c).map_elements(fix, return_dtype=pl.Utf8) for c in _str_cols(df, p)])


@transform("standardize_values", "clean", "Standardize values", "Merge variations of the same value (e.g. 'retail', 'Retail ', 'RETAIL') into one canonical value.",
           [P("column", "Column", "column", column_kind="text", required=True),
            P("mapping", "Custom mapping", "mapping", help="Optional. Leave empty to auto-group by case/spacing/punctuation.", advanced=True),
            P("case", "Output case", "select", default="most_common", options=opts(("most_common", "Most common variant"), ("title", "Title Case"), ("upper", "UPPERCASE"), ("lower", "lowercase")))])
def _stdvals(df, p, ctx):
    col = _cols(df, p)[0]
    mapping = {str(k).strip().lower(): v for k, v in (p.get("mapping") or {}).items()}
    key = pl.col(col).cast(pl.Utf8).str.strip_chars().str.to_lowercase().str.replace_all(r"[^\w]", "")
    counts = df.select(key.alias("k"), pl.col(col).str.strip_chars().alias("v")).drop_nulls().group_by(["k", "v"]).len().sort("len", descending=True)
    canonical: dict[str, str] = {}
    for k, v, _ in counts.rows():
        canonical.setdefault(k, v)
    case = p.get("case", "most_common")
    conv = {"title": str.title, "upper": str.upper, "lower": str.lower}.get(case, lambda x: x)

    def fix(v: str | None) -> str | None:
        if v is None:
            return None
        raw = v.strip().lower()
        if raw in mapping:
            return mapping[raw]
        k = re.sub(r"[^\w]", "", raw)
        return conv(canonical.get(k, v.strip()))

    return df.with_columns(pl.col(col).map_elements(fix, return_dtype=pl.Utf8))


@transform("replace_values", "clean", "Replace values", "Replace specific values with new ones.",
           [P("column", "Column", "column", required=True), P("mapping", "Replace → with", "mapping", required=True)])
def _replace_vals(df, p, ctx):
    col = _cols(df, p)[0]
    mapping = {str(k): v for k, v in (p.get("mapping") or {}).items()}
    return df.with_columns(_s(col).replace(mapping).alias(col))


@transform("find_replace", "clean", "Find and replace", "Find text inside values and replace it.",
           [P("columns", "Columns", "columns", column_kind="text", required=True), P("find", "Find", "text", required=True),
            P("replace", "Replace with", "text", default=""), P("match_case", "Match case", "boolean", default=False),
            P("whole_word", "Whole words only", "boolean", default=False, advanced=True)])
def _findrep(df, p, ctx):
    find = re.escape(str(p.get("find", "")))
    if p.get("whole_word"):
        find = rf"\b{find}\b"
    if not p.get("match_case"):
        find = "(?i)" + find
    rep = str(p.get("replace") or "").replace("$", "$$")
    return df.with_columns([pl.col(c).str.replace_all(find, rep) for c in _str_cols(df, p)])


@transform("remove_special_characters", "clean", "Remove special characters", "Keep only letters, numbers and spaces.",
           [P("columns", "Columns", "columns", column_kind="text", required=True),
            P("keep", "Also keep", "text", default="", placeholder="e.g. -_.@", help="Extra characters to keep.")])
def _rmspecial(df, p, ctx):
    keep = re.escape(p.get("keep") or "")
    return df.with_columns([pl.col(c).str.replace_all(rf"[^\w\s{keep}]", "") for c in _str_cols(df, p)])


@transform("normalize_strings", "clean", "Normalize text", "Fix unicode variants, collapse repeated spaces and trim.",
           [P("columns", "Columns", "columns", column_kind="text")])
def _normalize(df, p, ctx):
    return df.with_columns([pl.col(c).str.normalize("NFKC").str.replace_all(r"\s+", " ").str.strip_chars() for c in _str_cols(df, p)])


@transform("clean_punctuation", "clean", "Clean punctuation", "Remove stray punctuation and repeated symbols.",
           [P("columns", "Columns", "columns", column_kind="text", required=True)])
def _punct(df, p, ctx):
    return df.with_columns([pl.col(c).str.replace_all(r"([!?.,;:])\1+", "$1").str.replace_all(r"^[\p{P}\s]+|[\p{P}\s]+$", "")
                            for c in _str_cols(df, p)])


@transform("standardize_codes", "clean", "Standardize codes", "Make IDs and codes consistent: trim, remove spaces, fix case, optional zero-padding.",
           [P("columns", "Columns", "columns", column_kind="text", required=True),
            P("case", "Case", "select", default="upper", options=opts("upper", "lower", ("keep", "Keep as is"))),
            P("pad_length", "Pad to length", "number", advanced=True, help="Left-pad numeric codes with zeros.")])
def _codes(df, p, ctx):
    out = []
    for c in _str_cols(df, p):
        e = pl.col(c).str.replace_all(r"\s+", "")
        e = e.str.to_uppercase() if p.get("case", "upper") == "upper" else e.str.to_lowercase() if p.get("case") == "lower" else e
        if p.get("pad_length"):
            e = e.str.zfill(int(p["pad_length"]))
        out.append(e)
    return df.with_columns(out)


@transform("standardize_phone", "clean", "Standardize phone numbers", "Convert phone numbers to one international format (E.164, e.g. +15551234567).",
           [P("column", "Phone column", "column", column_kind="text", required=True),
            P("default_country", "Default country", "select", default="US", options=[{"value": c["iso2"], "label": c["name"]} for c in COUNTRIES]),
            P("country_column", "Country column (optional)", "column", advanced=True, help="Use each row's country to interpret local numbers."),
            P("invalid", "Invalid numbers", "select", default="null", options=opts(("null", "Set to empty"), ("keep", "Keep original")))])
def _phone(df, p, ctx):
    col = _cols(df, p)[0]
    default = p.get("default_country", "US")
    ccol = p.get("country_column")
    keep = p.get("invalid") == "keep"

    def fix(row: dict) -> str | None:
        v = row[col]
        country = default
        if ccol and row.get(ccol):
            c = country_lookup(row[ccol])
            country = c["iso2"] if c else default
        out = normalize_phone(v, country)
        return out if out or not keep else v

    fields = [col] + ([ccol] if ccol and ccol in df.columns else [])
    return df.with_columns(pl.struct(fields).map_elements(fix, return_dtype=pl.Utf8).alias(col))


@transform("validate_email", "clean", "Clean email addresses", "Trim and lower-case emails; empty out values that aren't valid addresses.",
           [P("column", "Email column", "column", column_kind="text", required=True),
            P("invalid", "Invalid emails", "select", default="null", options=opts(("null", "Set to empty"), ("flag", "Keep and add a flag column"), ("keep", "Keep")))])
def _email(df, p, ctx):
    col = _cols(df, p)[0]
    clean = pl.col(col).str.strip_chars().str.to_lowercase().str.replace_all(r"\s+", "")
    valid = clean.str.contains(EMAIL_RE)
    mode = p.get("invalid", "null")
    if mode == "null":
        return df.with_columns(pl.when(valid).then(clean).otherwise(None).alias(col))
    if mode == "flag":
        return df.with_columns(clean.alias(col), valid.fill_null(False).alias(f"{col}_is_valid"))
    return df.with_columns(clean.alias(col))


@transform("standardize_country", "clean", "Standardize country names", "Map 'USA', 'U.S.', 'United States' … to one standard value.",
           [P("column", "Country column", "column", column_kind="text", required=True),
            P("output_format", "Output as", "select", default="name", options=opts(("name", "Country name"), ("iso2", "ISO code (US)"), ("iso3", "ISO-3 code (USA)"))),
            P("unknown", "Unrecognized values", "select", default="keep", options=opts(("keep", "Keep original"), ("null", "Set to empty")))])
def _country(df, p, ctx):
    col = _cols(df, p)[0]
    fmt = p.get("output_format", "name")
    keep = p.get("unknown", "keep") == "keep"

    def fix(v: str | None) -> str | None:
        c = country_lookup(v)
        if c:
            return c[fmt]
        return v.strip() if (v and keep) else None

    return df.with_columns(pl.col(col).map_elements(fix, return_dtype=pl.Utf8))


@transform("standardize_boolean", "clean", "Standardize Yes/No values", "Convert Yes/No, Y/N, 1/0, TRUE/false into true/false.",
           [P("columns", "Columns", "columns", required=True)])
def _bool(df, p, ctx):
    return df.with_columns([bool_expr(c).alias(c) for c in _cols(df, p)])


# ============================================================================ Data Types
def cast_expr(col: str, to: str, dtype: pl.DataType, fmt: str | None = None) -> pl.Expr:
    src = pl.col(col)
    if to == "string":
        return src.cast(pl.Utf8)
    if to in ("integer",):
        return (numeric_expr(col) if dtype == pl.Utf8 else src.cast(pl.Float64)).round(0).cast(pl.Int64, strict=False)
    if to in ("decimal", "currency"):
        return (numeric_expr(col) if dtype == pl.Utf8 else src.cast(pl.Float64, strict=False)).round(2 if to == "currency" else 6)
    if to == "percentage":
        return percent_expr(col) if dtype == pl.Utf8 else src.cast(pl.Float64)
    if to == "boolean":
        return bool_expr(col) if dtype != pl.Boolean else src
    if to == "date":
        if dtype == pl.Date:
            return src
        if isinstance(dtype, pl.Datetime):
            return src.dt.date()
        return date_expr(col, [fmt] if fmt else None)
    if to == "timestamp":
        if isinstance(dtype, pl.Datetime):
            return src
        return datetime_expr(col)
    raise TransformError(f"Unknown type '{to}'")


@transform("convert_types", "types", "Convert data types", "Convert columns to the right type — text, number, decimal, date, true/false, currency or percentage.",
           [P("conversions", "Conversions", "column_types", required=True, help="Pick a column and the type it should become."),
            P("date_format", "Date format hint", "select", default="", advanced=True,
              options=opts(("", "Detect automatically"), ("%Y-%m-%d", "2024-12-31"), ("%m/%d/%Y", "12/31/2024"), ("%d/%m/%Y", "31/12/2024"), ("%d.%m.%Y", "31.12.2024")))],
           keywords=["cast", "type", "date", "decimal", "integer"])
def _convert(df, p, ctx):
    exprs = []
    for conv in p.get("conversions") or []:
        col, to = conv.get("column"), conv.get("to")
        if col not in df.columns:
            raise TransformError(f"Column '{col}' not found")
        exprs.append(cast_expr(col, to, df.schema[col], p.get("date_format") or None).alias(col))
    return df.with_columns(exprs)


# ============================================================================ Text
@transform("split_column", "text", "Split column", "Split one column into several using a delimiter.",
           [P("column", "Column", "column", column_kind="text", required=True), P("delimiter", "Delimiter", "text", default=" ", required=True),
            P("into", "New column names", "text", placeholder="first_part, second_part", help="Comma-separated; leave empty for automatic names."),
            P("keep_original", "Keep original column", "boolean", default=True)])
def _split(df, p, ctx):
    col = _cols(df, p)[0]
    names = [n.strip() for n in (p.get("into") or "").split(",") if n.strip()]
    if not names:
        n = int(df.select(pl.col(col).str.split(p.get("delimiter", " ")).list.len().max()).item() or 2)
        names = [f"{col}_{i + 1}" for i in range(min(n, 6))]
    parts = pl.col(col).str.split(p.get("delimiter", " "))
    last = len(names) - 1
    exprs = [parts.list.get(i, null_on_oob=True).str.strip_chars().alias(nm) if i < last else
             parts.list.slice(i).list.join(p.get("delimiter", " ")).str.strip_chars().alias(nm) for i, nm in enumerate(names)]
    out = df.with_columns(exprs).with_columns([pl.when(pl.col(n) == "").then(None).otherwise(pl.col(n)).alias(n) for n in names])
    return out if p.get("keep_original", True) else out.drop(col)


@transform("merge_columns", "text", "Merge columns", "Combine several columns into one (e.g. First + Last name → Full name).",
           [P("columns", "Columns to combine", "columns", required=True), P("separator", "Separator", "text", default=" "),
            P("output", "New column name", "text", required=True, default="full_name")])
def _merge(df, p, ctx):
    cols = _cols(df, p)
    return df.with_columns(pl.concat_str([pl.col(c).cast(pl.Utf8).str.strip_chars() for c in cols], separator=p.get("separator", " "), ignore_nulls=True).alias(_out(p, "merged")))


@transform("extract_substring", "text", "Extract part of text", "Take characters by position.",
           [P("column", "Column", "column", required=True), P("start", "Start at character", "number", default=1),
            P("length", "Number of characters", "number", default=3), P("output", "New column name", "text")])
def _substr(df, p, ctx):
    col = _cols(df, p)[0]
    return df.with_columns(_s(col).str.slice(max(int(p.get("start") or 1) - 1, 0), int(p.get("length") or 1)).alias(_out(p, f"{col}_part")))


@transform("extract_before", "text", "Extract before delimiter", "Keep the text before a character (e.g. email username).",
           [P("column", "Column", "column", required=True), P("delimiter", "Delimiter", "text", default="@", required=True), P("output", "New column name", "text")])
def _before(df, p, ctx):
    col = _cols(df, p)[0]
    return df.with_columns(_s(col).str.split(p["delimiter"]).list.first().alias(_out(p, f"{col}_before")))


@transform("extract_after", "text", "Extract after delimiter", "Keep the text after a character (e.g. email domain).",
           [P("column", "Column", "column", required=True), P("delimiter", "Delimiter", "text", default="@", required=True), P("output", "New column name", "text")])
def _after(df, p, ctx):
    col = _cols(df, p)[0]
    d = p["delimiter"]
    return df.with_columns(pl.when(_s(col).str.contains(d, literal=True)).then(_s(col).str.split(d).list.slice(1).list.join(d)).otherwise(None).alias(_out(p, f"{col}_after")))


@transform("regex_replace", "text", "Pattern replace", "Replace text matching a pattern. Pick a common pattern or enter your own.",
           [P("columns", "Columns", "columns", column_kind="text", required=True),
            P("pattern", "Pattern", "select", required=True, options=opts((r"\d", "Digits"), (r"[^\d]", "Everything except digits"), (r"\s+", "Whitespace runs"),
                                                                         (r"[^\w\s]", "Punctuation"), (r"\(.*?\)", "Text in parentheses")),
              help="Choose a preset or type a custom pattern."),
            P("replacement", "Replace with", "text", default="")])
def _rxrep(df, p, ctx):
    return df.with_columns([pl.col(c).str.replace_all(p["pattern"], (p.get("replacement") or "").replace("$", "$$")) for c in _str_cols(df, p)])


@transform("regex_extract", "text", "Pattern extract", "Pull out the part of the text that matches a pattern.",
           [P("column", "Column", "column", required=True),
            P("pattern", "Pattern", "select", required=True, options=opts((r"(\d+)", "First number"), (r"([A-Za-z]+)", "First word"),
                                                                         (r"@(.+)$", "Email domain"), (r"(\d{4})", "Four-digit year"), (r"([A-Z]{2,3})", "Uppercase code"))),
            P("output", "New column name", "text")])
def _rxext(df, p, ctx):
    col = _cols(df, p)[0]
    pat = p["pattern"] if "(" in p["pattern"] else f"({p['pattern']})"
    return df.with_columns(_s(col).str.extract(pat, 1).alias(_out(p, f"{col}_extract")))


@transform("add_prefix", "text", "Add prefix", "Add text to the start of each value.",
           [P("columns", "Columns", "columns", required=True), P("value", "Prefix", "text", required=True)])
def _prefix(df, p, ctx):
    return df.with_columns([pl.when(pl.col(c).is_not_null()).then(pl.lit(p["value"]) + _s(c)).alias(c) for c in _cols(df, p)])


@transform("add_suffix", "text", "Add suffix", "Add text to the end of each value.",
           [P("columns", "Columns", "columns", required=True), P("value", "Suffix", "text", required=True)])
def _suffix(df, p, ctx):
    return df.with_columns([pl.when(pl.col(c).is_not_null()).then(_s(c) + pl.lit(p["value"])).alias(c) for c in _cols(df, p)])


@transform("text_length", "text", "Text length", "Count the characters in each value.",
           [P("column", "Column", "column", required=True), P("output", "New column name", "text")])
def _len(df, p, ctx):
    col = _cols(df, p)[0]
    return df.with_columns(_s(col).str.len_chars().alias(_out(p, f"{col}_length")))


# ============================================================================ Date & Time
def _as_date(df: pl.DataFrame, col: str, day_first: bool = False) -> pl.Expr:
    t = df.schema[col]
    if t == pl.Date:
        return pl.col(col)
    if isinstance(t, pl.Datetime):
        return pl.col(col).dt.date()
    return date_expr(col, day_first=day_first)


@transform("parse_date", "datetime", "Parse dates", "Understand dates written in many formats (2024-01-31, 01/31/2024, 31 Jan 2024…) and store them as real dates.",
           [P("columns", "Date columns", "columns", required=True),
            P("day_first", "Ambiguous dates are day-first (31/01)", "boolean", default=False, advanced=True)], keywords=["date", "standardize"])
def _parse_date(df, p, ctx):
    return df.with_columns([_as_date(df, c, bool(p.get("day_first"))).alias(c) for c in _cols(df, p)])


@transform("standardize_date", "datetime", "Standardize date format", "Rewrite dates as text in one consistent format.",
           [P("column", "Column", "column", required=True),
            P("format", "Output format", "select", default="%Y-%m-%d", options=opts(("%Y-%m-%d", "2024-12-31 (ISO)"), ("%m/%d/%Y", "12/31/2024"),
                                                                                     ("%d/%m/%Y", "31/12/2024"), ("%d %b %Y", "31 Dec 2024")))])
def _std_date(df, p, ctx):
    col = _cols(df, p)[0]
    return df.with_columns(_as_date(df, col).dt.strftime(p.get("format", "%Y-%m-%d")).alias(col))


@transform("extract_date_part", "datetime", "Extract date part", "Create a column with the year, month, quarter, day or weekday.",
           [P("column", "Date column", "column", required=True),
            P("part", "Part", "select", default="year", options=opts("year", "month", "quarter", "day", ("day_of_week", "Day of week"), ("week", "Week of year"), ("month_name", "Month name"))),
            P("output", "New column name", "text")])
def _date_part(df, p, ctx):
    col = _cols(df, p)[0]
    d = _as_date(df, col)
    part = p.get("part", "year")
    expr = {"year": d.dt.year(), "month": d.dt.month(), "quarter": d.dt.quarter(), "day": d.dt.day(), "day_of_week": d.dt.strftime("%A"),
            "week": d.dt.week(), "month_name": d.dt.strftime("%B")}[part]
    return df.with_columns(expr.alias(_out(p, f"{col}_{part}")))


@transform("fiscal_period", "datetime", "Fiscal year / quarter", "Calculate fiscal year and quarter using your company's fiscal start month.",
           [P("column", "Date column", "column", required=True),
            P("start_month", "Fiscal year starts in", "select", default="1", options=[{"value": str(i), "label": date(2000, i, 1).strftime("%B")} for i in range(1, 13)]),
            P("part", "Calculate", "select", default="fiscal_year", options=opts(("fiscal_year", "Fiscal year"), ("fiscal_quarter", "Fiscal quarter"))),
            P("output", "New column name", "text")])
def _fiscal(df, p, ctx):
    col = _cols(df, p)[0]
    d = _as_date(df, col)
    start = int(p.get("start_month") or 1)
    shifted = (d.dt.month() - start) % 12
    fy = d.dt.year() + pl.when(d.dt.month() >= start).then(1 if start > 1 else 0).otherwise(0)
    if p.get("part") == "fiscal_quarter":
        expr = pl.lit("FQ") + ((shifted // 3) + 1).cast(pl.Utf8)
    else:
        expr = pl.lit("FY") + fy.cast(pl.Utf8)
    return df.with_columns(expr.alias(_out(p, f"{col}_{p.get('part', 'fiscal_year')}")))


@transform("date_difference", "datetime", "Date difference", "Time between two dates (or between a date and today).",
           [P("start_column", "Start date", "column", required=True), P("end_column", "End date", "column", help="Leave empty to use today."),
            P("unit", "Unit", "select", default="days", options=opts("days", "weeks", "months", "years")), P("output", "New column name", "text", default="days_between")])
def _datediff(df, p, ctx):
    start = _as_date(df, p["start_column"])
    end = _as_date(df, p["end_column"]) if p.get("end_column") else pl.lit(ctx.today)
    days = (end - start).dt.total_days()
    unit = p.get("unit", "days")
    expr = {"days": days, "weeks": days // 7, "months": (days / 30.4375).floor().cast(pl.Int64), "years": (days / 365.25).floor().cast(pl.Int64)}[unit]
    return df.with_columns(expr.alias(_out(p, f"{unit}_between")))


@transform("calculate_age", "datetime", "Calculate age", "Age in whole years from a birth date.",
           [P("column", "Date of birth column", "column", required=True), P("output", "New column name", "text", default="age")])
def _age(df, p, ctx):
    col = _cols(df, p)[0]
    d = _as_date(df, col)
    today = ctx.today
    before = (d.dt.month() > today.month) | ((d.dt.month() == today.month) & (d.dt.day() > today.day))
    return df.with_columns((pl.lit(today.year) - d.dt.year() - before.cast(pl.Int32)).alias(_out(p, "age")))


@transform("convert_timezone", "datetime", "Convert time zone", "Convert timestamps from one time zone to another.",
           [P("column", "Timestamp column", "column", required=True),
            P("from_tz", "From", "select", default="UTC", options=opts("UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo")),
            P("to_tz", "To", "select", default="America/New_York", options=opts("UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo"))])
def _tz(df, p, ctx):
    col = _cols(df, p)[0]
    t = df.schema[col]
    ts = pl.col(col) if isinstance(t, pl.Datetime) else datetime_expr(col)
    return df.with_columns(ts.dt.replace_time_zone(p.get("from_tz", "UTC"), ambiguous="earliest", non_existent="null")
                           .dt.convert_time_zone(p.get("to_tz", "UTC")).dt.replace_time_zone(None).alias(col))


@transform("to_timestamp", "datetime", "Convert to timestamp", "Turn text or epoch numbers into timestamps.",
           [P("column", "Column", "column", required=True),
            P("source", "Values are", "select", default="text", options=opts(("text", "Date/time text"), ("epoch_s", "Epoch seconds"), ("epoch_ms", "Epoch milliseconds")))])
def _to_ts(df, p, ctx):
    col = _cols(df, p)[0]
    src = p.get("source", "text")
    if src == "text":
        return df.with_columns(datetime_expr(col).alias(col))
    n = numeric_expr(col).cast(pl.Int64)
    return df.with_columns(pl.from_epoch(n, time_unit="s" if src == "epoch_s" else "ms").alias(col))


# ============================================================================ Missing values
@transform("flag_missing", "missing", "Flag missing values", "Add a true/false column showing where values are missing.",
           [P("columns", "Columns", "columns", required=True)])
def _flag_missing(df, p, ctx):
    return df.with_columns([_is_blank(c).alias(f"{c}_is_missing") for c in _cols(df, p)])


@transform("drop_missing", "missing", "Remove records with missing values", "Remove rows where the selected columns are empty.",
           [P("columns", "Columns", "columns", required=True), P("how", "Remove when", "select", default="any", options=opts(("any", "Any selected column is empty"), ("all", "All selected columns are empty")))],
           row_preserving=False, destructive=True)
def _drop_missing(df, p, ctx):
    cols = _cols(df, p)
    blanks = [_is_blank(c) for c in cols]
    mask = pl.any_horizontal(blanks) if p.get("how", "any") == "any" else pl.all_horizontal(blanks)
    return df.filter(~mask)


def _fill(df: pl.DataFrame, p: dict, value_fn: Callable[[str], Any]) -> pl.DataFrame:
    exprs = []
    for c in _cols(df, p):
        v = value_fn(c)
        target = pl.col(c)
        if df.schema[c] == pl.Utf8:
            exprs.append(pl.when(_is_blank(c)).then(pl.lit(None if v is None else str(v))).otherwise(target).alias(c))
        else:
            exprs.append(target.fill_null(v).alias(c))
    return df.with_columns(exprs)


@transform("fill_constant", "missing", "Replace with a value", "Fill missing values with a fixed value (e.g. 'Unknown').",
           [P("columns", "Columns", "columns", required=True), P("value", "Value", "text", required=True, default="Unknown")])
def _fill_const(df, p, ctx):
    return _fill(df, p, lambda c: p.get("value"))


@transform("fill_zero", "missing", "Replace with zero", "Fill missing numbers with 0.", [P("columns", "Columns", "columns", column_kind="numeric", required=True)])
def _fill_zero(df, p, ctx):
    return _fill(df, p, lambda c: 0)


def _stat(df: pl.DataFrame, c: str, fn: str) -> Any:
    nums = df.select(numeric_expr(c) if df.schema[c] == pl.Utf8 else pl.col(c).cast(pl.Float64)).to_series().drop_nulls()
    if not nums.len():
        return None
    v = {"mean": nums.mean(), "median": nums.median()}[fn]
    return round(float(v), 2)


@transform("fill_mean", "missing", "Replace with average", "Fill missing numbers with the column average.", [P("columns", "Columns", "columns", column_kind="numeric", required=True)])
def _fill_mean(df, p, ctx):
    return _fill(df, p, lambda c: _stat(df, c, "mean"))


@transform("fill_median", "missing", "Replace with median", "Fill missing numbers with the middle value — robust to outliers.", [P("columns", "Columns", "columns", column_kind="numeric", required=True)])
def _fill_median(df, p, ctx):
    return _fill(df, p, lambda c: _stat(df, c, "median"))


@transform("fill_mode", "missing", "Replace with most common", "Fill missing values with the most frequent value.", [P("columns", "Columns", "columns", required=True)])
def _fill_mode(df, p, ctx):
    def mode(c: str) -> Any:
        s = df[c].drop_nulls()
        if s.dtype == pl.Utf8:
            s = s.filter(s.str.strip_chars() != "")
        vc = s.value_counts(sort=True)
        return vc[c][0] if vc.height else None

    return _fill(df, p, mode)


@transform("forward_fill", "missing", "Fill down (forward fill)", "Copy the previous row's value into empty cells.",
           [P("columns", "Columns", "columns", required=True), P("order_by", "Order by", "column", advanced=True)])
def _ffill(df, p, ctx):
    cols = _cols(df, p)
    base = df.sort(p["order_by"]) if p.get("order_by") else df
    out = base.with_columns([pl.when(_is_blank(c)).then(None).otherwise(pl.col(c)).fill_null(strategy="forward").alias(c) for c in cols])
    return out.sort("__row_id") if p.get("order_by") and "__row_id" in out.columns else out


@transform("backward_fill", "missing", "Fill up (backward fill)", "Copy the next row's value into empty cells.",
           [P("columns", "Columns", "columns", required=True), P("order_by", "Order by", "column", advanced=True)])
def _bfill(df, p, ctx):
    cols = _cols(df, p)
    base = df.sort(p["order_by"]) if p.get("order_by") else df
    out = base.with_columns([pl.when(_is_blank(c)).then(None).otherwise(pl.col(c)).fill_null(strategy="backward").alias(c) for c in cols])
    return out.sort("__row_id") if p.get("order_by") and "__row_id" in out.columns else out


@transform("smart_impute", "missing", "AI-assisted imputation", "Fill gaps using similar records: the most common value (text) or median (numbers) within related groups.",
           [P("column", "Column to fill", "column", required=True),
            P("group_by", "Similar records share", "columns", help="e.g. Country + Segment. AI suggests the most predictive columns.")], keywords=["impute", "ai"])
def _impute(df, p, ctx):
    col = _cols(df, p)[0]
    groups = [g for g in (p.get("group_by") or []) if g in df.columns and g != col]
    is_num = df.schema[col].is_numeric() or (df.schema[col] == pl.Utf8 and df.select(numeric_expr(col).is_not_null().mean()).item() > 0.9)
    clean = pl.when(_is_blank(col)).then(None).otherwise(pl.col(col))
    if is_num:
        num = numeric_expr(col) if df.schema[col] == pl.Utf8 else pl.col(col)
        fill = num.median().over(groups) if groups else num.median()
        filled = pl.coalesce([num, fill, num.median()])
        return df.with_columns((filled.round(2).cast(pl.Utf8) if df.schema[col] == pl.Utf8 else filled).alias(col))
    fill = clean.drop_nulls().mode().first().over(groups) if groups else clean.drop_nulls().mode().first()
    return df.with_columns(pl.coalesce([clean, fill, clean.drop_nulls().mode().first()]).alias(col))


# ============================================================================ Duplicates
def _quality_rank(df: pl.DataFrame) -> pl.Expr:
    cols = [c for c in df.columns if c != "__row_id" and not isinstance(df.schema[c], (pl.Struct, pl.List))]
    return pl.sum_horizontal([(~_is_blank(c)).cast(pl.Int32) for c in cols])


@transform("flag_duplicates", "duplicates", "Flag duplicates", "Mark records that appear more than once.",
           [P("columns", "Match on", "columns", help="Leave empty to compare entire rows."), P("output", "Flag column name", "text", default="is_duplicate")])
def _flag_dups(df, p, ctx):
    cols = _cols(df, p) or [c for c in df.columns if c != "__row_id"]
    return df.with_columns(pl.struct(cols).is_duplicated().alias(_out(p, "is_duplicate")))


@transform("remove_duplicates", "duplicates", "Remove duplicates", "Keep one record per key using a survivorship rule.",
           [P("columns", "Match on", "columns", help="Leave empty to remove exact duplicate rows."),
            P("keep", "Keep", "select", default="first", options=opts(("first", "First occurrence"), ("last", "Last occurrence"), ("latest", "Most recent (by date)"),
                                                                     ("highest_quality", "Most complete record"))),
            P("order_by", "Date column (for 'Most recent')", "column", column_kind="date")],
           row_preserving=False, destructive=True, keywords=["dedupe", "deduplicate", "unique"])
def _remove_dups(df, p, ctx):
    cols = _cols(df, p) or [c for c in df.columns if c != "__row_id"]
    keep = p.get("keep", "first")
    if keep in ("first", "last"):
        return df.unique(subset=cols, keep=keep, maintain_order=True)
    if keep == "latest":
        oc = p.get("order_by")
        if not oc or oc not in df.columns:
            raise TransformError("Choose the date column that identifies the most recent record.")
        order = _as_date(df, oc) if df.schema[oc] == pl.Utf8 else pl.col(oc)
        ranked = df.with_columns(order.alias("__order")).sort("__order", descending=True, nulls_last=True)
    else:
        ranked = df.with_columns(_quality_rank(df).alias("__order")).sort("__order", descending=True)
    out = ranked.unique(subset=cols, keep="first", maintain_order=True).drop("__order")
    return out.sort("__row_id") if "__row_id" in out.columns else out


def _norm_key(v: Any) -> str:
    s = unicodedata.normalize("NFKD", str(v or "")).encode("ascii", "ignore").decode().lower()
    tokens = sorted(re.findall(r"[a-z0-9]+", s))
    return " ".join(tokens)


@transform("fuzzy_duplicates", "duplicates", "Find similar records (fuzzy)", "Detect near-duplicates such as 'Jon Smith' vs 'John  Smith'.",
           [P("columns", "Compare", "columns", required=True), P("threshold", "Similarity", "number", default=90, help="0–100. Higher = stricter."),
            P("action", "Then", "select", default="flag", options=opts(("flag", "Flag them (add a group column)"), ("remove", "Keep one per group")))],
           keywords=["similar", "near duplicate", "match"])
def _fuzzy(df, p, ctx):
    cols = _cols(df, p)
    th = float(p.get("threshold") or 90) / 100
    keys = df.select(pl.concat_str([_s(c) for c in cols], separator=" ", ignore_nulls=True).alias("k"))["k"].to_list()
    norm = [_norm_key(k) for k in keys]
    group = list(range(len(norm)))
    blocks: dict[str, list[int]] = {}
    for i, k in enumerate(norm):
        blocks.setdefault(k[:2], []).append(i)
    canon: dict[str, int] = {}
    for idxs in blocks.values():
        reps: list[int] = []
        for i in idxs:
            k = norm[i]
            if k in canon:
                group[i] = canon[k]
                continue
            match = next((r for r in reps[-200:] if difflib.SequenceMatcher(None, norm[r], k).ratio() >= th), None)
            group[i] = group[match] if match is not None else i
            canon[k] = group[i]
            if match is None:
                reps.append(i)
    out = df.with_columns(pl.Series("similar_group", group, dtype=pl.Int64))
    if p.get("action") == "remove":
        out = out.unique(subset=["similar_group"], keep="first", maintain_order=True).drop("similar_group")
    else:
        sizes = out.group_by("similar_group").len()
        out = out.join(sizes, on="similar_group", how="left").with_columns((pl.col("len") > 1).alias("has_similar")).drop("len")
    return out


@transform("survivorship", "duplicates", "Merge duplicates (survivorship)", "Combine duplicate records into one golden record, choosing the best value per column.",
           [P("columns", "Records match on", "columns", required=True),
            P("rules", "Per-column rules", "survivorship", help="Default: first non-empty value."),
            P("order_by", "Recency column", "column", column_kind="date", advanced=True)], row_preserving=False, destructive=True, keywords=["golden record", "mdm"])
def _survive(df, p, ctx):
    keys = _cols(df, p)
    rules = p.get("rules") or {}
    work = df
    if p.get("order_by") in df.columns:
        oc = p["order_by"]
        work = df.with_columns((_as_date(df, oc) if df.schema[oc] == pl.Utf8 else pl.col(oc)).alias("__recency")).sort("__recency", descending=True, nulls_last=True)
    aggs = []
    for c in df.columns:
        if c in keys:
            continue
        rule = rules.get(c, "first_non_null")
        clean = pl.when(_is_blank(c)).then(None).otherwise(pl.col(c)) if df.schema[c] == pl.Utf8 else pl.col(c)
        if rule == "max":
            aggs.append((numeric_expr(c) if df.schema[c] == pl.Utf8 else pl.col(c)).max().alias(c))
        elif rule == "min":
            aggs.append((numeric_expr(c) if df.schema[c] == pl.Utf8 else pl.col(c)).min().alias(c))
        elif rule == "most_common":
            aggs.append(clean.drop_nulls().mode().first().alias(c))
        elif rule == "longest":
            aggs.append(clean.sort_by(clean.cast(pl.Utf8).str.len_chars(), descending=True, nulls_last=True).first().alias(c))
        else:
            aggs.append(clean.drop_nulls().first().alias(c))
    out = work.group_by(keys, maintain_order=True).agg(aggs)
    if "__recency" in out.columns:
        out = out.drop("__recency")
    return out.select([c for c in df.columns if c in out.columns])


# ============================================================================ Filter & Sort
@transform("filter_rows", "filter", "Filter rows", "Keep or remove records using simple conditions (AND / OR).",
           [P("conditions", "Conditions", "conditions", required=True), P("logic", "Match", "select", default="and", options=opts(("and", "All conditions (AND)"), ("or", "Any condition (OR)"))),
            P("mode", "Then", "select", default="keep", options=opts(("keep", "Keep matching rows"), ("remove", "Remove matching rows")))],
           row_preserving=False, destructive=True, keywords=["where", "condition"])
def _filter(df, p, ctx):
    mask = combine_conditions(df, p.get("conditions") or [], p.get("logic", "and"))
    return df.filter(mask if p.get("mode", "keep") == "keep" else ~mask)


@transform("sort_rows", "filter", "Sort", "Sort by one or more columns.", [P("keys", "Sort by", "sort_keys", required=True)], row_preserving=False)
def _sort(df, p, ctx):
    keys = p.get("keys") or []
    if not keys:
        return df
    exprs, desc = [], []
    for k in keys:
        c = k["column"]
        if c not in df.columns:
            raise TransformError(f"Column '{c}' not found")
        num = df.schema[c] == pl.Utf8 and df.select(numeric_expr(c).is_not_null().mean()).item() > 0.9
        exprs.append(numeric_expr(c) if num else pl.col(c))
        desc.append(bool(k.get("descending")))
    return df.sort(exprs, descending=desc, nulls_last=True)


@transform("limit_rows", "filter", "Keep first N rows", "Keep only the first N records (e.g. for top-N lists).",
           [P("n", "Number of rows", "number", default=100, required=True)], row_preserving=False, destructive=True)
def _limit(df, p, ctx):
    return df.head(int(p.get("n") or 100))


# ============================================================================ Joins & Merge
def _load(ctx: TransformContext, dataset_id: str | None) -> pl.DataFrame:
    if not dataset_id or not ctx.load_dataset:
        raise TransformError("Choose the dataset to combine with.")
    other = ctx.load_dataset(dataset_id)
    return other.drop("__row_id") if "__row_id" in other.columns else other


def _key_list(v: Any) -> list[str]:
    return [v] if isinstance(v, str) else list(v or [])


@transform("join", "join", "Join datasets", "Combine columns from another dataset by matching keys.",
           [P("right_dataset", "Join with", "dataset", required=True), P("left_on", "Match this column", "columns", required=True),
            P("right_on", "…to this column in the other dataset", "columns", required=True),
            P("how", "Join type", "select", default="left", options=opts(("inner", "Inner — only matches"), ("left", "Left — keep all rows from this dataset"),
                                                                        ("right", "Right — keep all rows from the other"), ("full", "Full outer — keep everything"),
                                                                        ("cross", "Cross — every combination"), ("semi", "Keep rows that have a match"), ("anti", "Keep rows with NO match"))),
            P("columns", "Columns to bring in", "columns", help="Leave empty to bring all columns.", advanced=True)],
           row_preserving=False, multi_dataset=True, keywords=["merge", "lookup", "combine"])
def _join(df, p, ctx):
    right = _load(ctx, p.get("right_dataset"))
    how = p.get("how", "left")
    if how == "cross":
        return df.join(right, how="cross", suffix="_right")
    lo, ro = _key_list(p.get("left_on")), _key_list(p.get("right_on"))
    if len(lo) != len(ro) or not lo:
        raise TransformError("Pick the same number of matching columns on both sides.")
    if p.get("columns"):
        right = right.select(list(dict.fromkeys(ro + [c for c in p["columns"] if c in right.columns])))
    left = df.with_columns([_s(c).str.strip_chars().alias(c) for c in lo])
    right = right.with_columns([_s(c).str.strip_chars().alias(c) for c in ro])
    return left.join(right, left_on=lo, right_on=ro, how=how, suffix="_right", coalesce=True)


@transform("lookup", "join", "Lookup values", "Bring in selected columns from a reference dataset (like VLOOKUP).",
           [P("right_dataset", "Lookup dataset", "dataset", required=True), P("left_on", "Match column", "column", required=True),
            P("right_on", "Lookup key", "column", required=True), P("columns", "Return columns", "columns", required=True)],
           multi_dataset=True, keywords=["vlookup", "reference"])
def _lookup(df, p, ctx):
    right = _load(ctx, p.get("right_dataset"))
    ro = p["right_on"]
    cols = [c for c in p.get("columns") or [] if c in right.columns and c != ro]
    right = right.select([ro] + cols).with_columns(_s(ro).str.strip_chars().str.to_lowercase().alias("__k")).unique("__k", keep="first").drop(ro)
    out = df.with_columns(_s(p["left_on"]).str.strip_chars().str.to_lowercase().alias("__k")).join(right, on="__k", how="left", suffix="_lookup")
    return out.drop("__k")


@transform("fuzzy_join", "join", "Fuzzy join", "Match records whose keys are similar but not identical (case, spacing, punctuation, word order).",
           [P("right_dataset", "Join with", "dataset", required=True), P("left_on", "Match column", "column", required=True),
            P("right_on", "Other column", "column", required=True), P("how", "Join type", "select", default="left", options=opts("left", "inner"))],
           row_preserving=False, multi_dataset=True)
def _fuzzy_join(df, p, ctx):
    right = _load(ctx, p.get("right_dataset"))
    lk = df[p["left_on"]].map_elements(_norm_key, return_dtype=pl.Utf8).alias("__fk")
    rk = right[p["right_on"]].map_elements(_norm_key, return_dtype=pl.Utf8).alias("__fk")
    right = right.with_columns(rk).unique("__fk", keep="first")
    return df.with_columns(lk).join(right, on="__fk", how=p.get("how", "left"), suffix="_right").drop("__fk")


@transform("union", "join", "Union (append, distinct)", "Stack rows from other datasets and remove exact duplicates.",
           [P("datasets", "Datasets to append", "datasets", required=True)], row_preserving=False, multi_dataset=True)
def _union(df, p, ctx):
    frames = [df.drop("__row_id") if "__row_id" in df.columns else df] + [_load(ctx, d) for d in p.get("datasets") or []]
    return pl.concat(frames, how="diagonal_relaxed").unique(maintain_order=True)


@transform("union_all", "join", "Union all (append)", "Stack rows from other datasets, keeping everything.",
           [P("datasets", "Datasets to append", "datasets", required=True)], row_preserving=False, multi_dataset=True)
def _union_all(df, p, ctx):
    frames = [df.drop("__row_id") if "__row_id" in df.columns else df] + [_load(ctx, d) for d in p.get("datasets") or []]
    return pl.concat(frames, how="diagonal_relaxed")


# ============================================================================ Aggregate
AGG_FUNCS = opts("count", ("count_distinct", "Distinct count"), "sum", ("mean", "Average"), "min", "max", "median",
                 ("p25", "25th percentile"), ("p75", "75th percentile"), ("p90", "90th percentile"), ("p95", "95th percentile"),
                 ("std", "Standard deviation"), "first", "last")


def agg_expr(df: pl.DataFrame, a: dict) -> pl.Expr:
    col, fn = a.get("column"), a.get("fn", "count")
    alias = a.get("alias") or (f"{fn}_{col}" if col else fn)
    if fn == "count":
        return (pl.col(col).count() if col else pl.len()).alias(alias)
    if col not in df.columns:
        raise TransformError(f"Column '{col}' not found")
    if fn == "count_distinct":
        return pl.col(col).n_unique().alias(alias)
    if fn in ("first", "last"):
        return getattr(pl.col(col), fn)().alias(alias)
    num = numeric_expr(col) if df.schema[col] == pl.Utf8 else pl.col(col)
    if fn in ("min", "max") and df.schema[col] == pl.Date:
        num = pl.col(col)
    if fn.startswith("p") and fn[1:].isdigit():
        return num.quantile(int(fn[1:]) / 100).alias(alias)
    return getattr(num, fn)().alias(alias)


@transform("aggregate", "aggregate", "Group & summarize", "Group records and calculate totals, averages, counts and more.",
           [P("group_by", "Group by", "columns"), P("aggregations", "Calculations", "aggregations", required=True)],
           row_preserving=False, keywords=["group by", "sum", "count", "average", "summarize"])
def _aggregate(df, p, ctx):
    aggs = [agg_expr(df, a) for a in p.get("aggregations") or []]
    if not aggs:
        raise TransformError("Add at least one calculation.")
    groups = [g for g in (p.get("group_by") or [])]
    for g in groups:
        if g not in df.columns:
            raise TransformError(f"Column '{g}' not found")
    return df.group_by(groups, maintain_order=True).agg(aggs) if groups else df.select(aggs)


@transform("window", "aggregate", "Window calculation", "Running totals, rankings, previous/next values and share-of-total — without losing rows.",
           [P("partition_by", "Within each", "columns"), P("order_by", "Ordered by", "column"),
            P("fn", "Calculation", "select", default="row_number", options=opts(("row_number", "Row number"), ("rank", "Rank"), ("dense_rank", "Dense rank"),
                                                                              ("running_sum", "Running total"), ("running_avg", "Running average"),
                                                                              ("moving_avg", "Moving average"), ("lag", "Previous value"), ("lead", "Next value"),
                                                                              ("pct_of_total", "% of total"))),
            P("column", "Value column", "column"), P("window_size", "Window size", "number", default=3, advanced=True),
            P("output", "New column name", "text")], keywords=["rank", "running total", "lag"])
def _window(df, p, ctx):
    part = p.get("partition_by") or []
    fn = p.get("fn", "row_number")
    col = p.get("column")
    oc = p.get("order_by")
    work = df
    if oc:
        key = _as_date(df, oc) if df.schema[oc] == pl.Utf8 and df.select(date_expr(oc).is_not_null().mean()).item() > 0.8 else (
            numeric_expr(oc) if df.schema[oc] == pl.Utf8 else pl.col(oc))
        work = df.with_columns(key.alias("__ord")).sort("__ord", nulls_last=True)
    val = (numeric_expr(col) if col and df.schema[col] == pl.Utf8 else pl.col(col)) if col else None

    def over(e: pl.Expr) -> pl.Expr:
        return e.over(part) if part else e

    if fn == "row_number":
        e = over(pl.int_range(1, pl.len() + 1))
    elif fn in ("rank", "dense_rank"):
        base = pl.col("__ord") if oc else val
        e = over(base.rank(method="min" if fn == "rank" else "dense"))
    elif fn == "running_sum":
        e = over(val.cum_sum())
    elif fn == "running_avg":
        e = over(val.cum_sum() / pl.int_range(1, pl.len() + 1))
    elif fn == "moving_avg":
        e = over(val.rolling_mean(int(p.get("window_size") or 3), min_samples=1))
    elif fn == "lag":
        e = over(pl.col(col).shift(1))
    elif fn == "lead":
        e = over(pl.col(col).shift(-1))
    elif fn == "pct_of_total":
        e = over(val / val.sum() * 100).round(2)
    else:
        raise TransformError(f"Unknown calculation '{fn}'")
    out = work.with_columns(e.alias(_out(p, fn)))
    if "__ord" in out.columns:
        out = out.drop("__ord")
    return out.sort("__row_id") if "__row_id" in out.columns else out


# ============================================================================ Pivot / Unpivot
@transform("pivot", "pivot", "Pivot", "Turn row values into columns (e.g. one column per month).",
           [P("index", "Rows", "columns", required=True), P("columns", "Columns from", "column", required=True),
            P("values", "Values", "column", required=True), P("agg", "Combine with", "select", default="sum", options=opts("sum", ("mean", "Average"), "count", "min", "max", "first"))],
           row_preserving=False)
def _pivot(df, p, ctx):
    vcol = p["values"]
    agg = p.get("agg", "sum")
    work = df.drop("__row_id") if "__row_id" in df.columns else df
    if agg != "count" and agg != "first" and work.schema[vcol] == pl.Utf8:
        work = work.with_columns(numeric_expr(vcol).alias(vcol))
    col = p["columns"] if isinstance(p["columns"], str) else p["columns"][0]
    return work.pivot(on=col, index=_key_list(p["index"]), values=vcol, aggregate_function="len" if agg == "count" else agg)


@transform("unpivot", "pivot", "Unpivot", "Turn columns into rows (wide → long).",
           [P("id_columns", "Keep as identifiers", "columns", required=True), P("value_columns", "Columns to unpivot", "columns"),
            P("variable_name", "Name column", "text", default="attribute"), P("value_name", "Value column", "text", default="value")], row_preserving=False)
def _unpivot(df, p, ctx):
    work = df.drop("__row_id") if "__row_id" in df.columns else df
    return work.unpivot(index=p["id_columns"], on=p.get("value_columns") or None,
                        variable_name=p.get("variable_name") or "attribute", value_name=p.get("value_name") or "value")


@transform("melt", "pivot", "Melt", "Same as unpivot — reshape many measure columns into name/value pairs.",
           [P("id_columns", "Keep as identifiers", "columns", required=True), P("value_columns", "Columns to melt", "columns")], row_preserving=False)
def _melt(df, p, ctx):
    return _unpivot(df, {**p, "variable_name": "variable", "value_name": "value"}, ctx)


@transform("crosstab", "pivot", "Cross-tab", "Count combinations of two columns in a matrix.",
           [P("row", "Rows", "column", required=True), P("column", "Columns", "column", required=True)], row_preserving=False)
def _crosstab(df, p, ctx):
    return df.group_by([p["row"], p["column"]]).len().pivot(on=p["column"], index=p["row"], values="len").fill_null(0).sort(p["row"])


# ============================================================================ Schema & Structure
@transform("rename_columns", "schema", "Rename columns", "Give columns clear business names.", [P("mapping", "Old name → new name", "rename_map", required=True)])
def _rename(df, p, ctx):
    mapping = {k: v for k, v in (p.get("mapping") or {}).items() if k in df.columns and v and k != v}
    return df.rename(mapping)


def to_snake(name: str) -> str:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name.strip())
    s = re.sub(r"[^\w]+", "_", s).strip("_").lower()
    return re.sub(r"_+", "_", s) or "column"


@transform("standardize_column_names", "schema", "Standardize column names", "Rename every column to consistent snake_case (e.g. 'Customer ID' → customer_id). Recommended for the Lakehouse.",
           [P("style", "Style", "select", default="snake", options=opts(("snake", "snake_case"), ("lower", "lowercase")))], keywords=["snake case", "naming"])
def _snake(df, p, ctx):
    mapping, seen = {}, set()
    for c in df.columns:
        if c == "__row_id":
            continue
        new = to_snake(c) if p.get("style", "snake") == "snake" else c.lower()
        while new in seen:
            new += "_2"
        seen.add(new)
        if new != c:
            mapping[c] = new
    return df.rename(mapping)


@transform("drop_columns", "schema", "Remove columns", "Remove columns you don't need.", [P("columns", "Columns", "columns", required=True)], destructive=True)
def _drop(df, p, ctx):
    return df.drop(_cols(df, p))


@transform("select_columns", "schema", "Keep only selected columns", "Keep only the columns you pick.", [P("columns", "Columns", "columns", required=True)], destructive=True)
def _select(df, p, ctx):
    cols = _cols(df, p)
    return df.select((["__row_id"] if "__row_id" in df.columns else []) + cols)


@transform("add_column", "schema", "Add column", "Add a column with a fixed value (e.g. source system name).",
           [P("output", "Column name", "text", required=True), P("value", "Value", "text", default=""),
            P("value_type", "Value is", "select", default="text", options=opts("text", "number", ("current_timestamp", "Load timestamp")))])
def _add_col(df, p, ctx):
    vt = p.get("value_type", "text")
    if vt == "current_timestamp":
        from datetime import datetime, timezone

        v = pl.lit(datetime.now(timezone.utc).replace(tzinfo=None))
    elif vt == "number":
        v = pl.lit(float(p.get("value") or 0))
    else:
        v = pl.lit(p.get("value", ""))
    return df.with_columns(v.alias(_out(p, "new_column")))


@transform("reorder_columns", "schema", "Reorder columns", "Drag columns into the order you want.", [P("order", "Column order", "column_order", required=True)])
def _reorder(df, p, ctx):
    first = [c for c in p.get("order") or [] if c in df.columns]
    return df.select(first + [c for c in df.columns if c not in first])


def _flatten_once(df: pl.DataFrame, cols: list[str], sep: str) -> pl.DataFrame:
    for c in cols:
        if isinstance(df.schema[c], pl.Struct):
            fields = df.schema[c].fields
            df = df.with_columns([pl.col(c).struct.field(f.name).alias(f"{c}{sep}{f.name}") for f in fields]).drop(c)
    return df


@transform("flatten", "schema", "Flatten nested data (JSON / XML)", "Turn nested objects into regular columns (owner.customer_id → owner_customer_id).",
           [P("columns", "Nested columns", "columns", column_kind="nested", help="Leave empty to flatten everything."),
            P("separator", "Name separator", "text", default="_", advanced=True),
            P("arrays", "Lists of values", "select", default="join", options=opts(("join", "Join into text (a, b, c)"), ("keep", "Keep as list"), ("count", "Count items")))],
           keywords=["json", "xml", "nested", "struct", "unnest"])
def _flatten(df, p, ctx):
    sep = p.get("separator") or "_"
    targets = p.get("columns") or [c for c, t in df.schema.items() if isinstance(t, (pl.Struct, pl.List))]
    for _ in range(8):
        structs = [c for c in df.columns if isinstance(df.schema[c], pl.Struct) and any(c == t or c.startswith(t + sep) for t in targets)]
        if not structs:
            break
        df = _flatten_once(df, structs, sep)
    mode = p.get("arrays", "join")
    arrays = [c for c in df.columns if isinstance(df.schema[c], pl.List) and any(c == t or c.startswith(t + sep) for t in targets)]
    exprs = []
    for c in arrays:
        inner = df.schema[c].inner
        if isinstance(inner, pl.Struct) or mode == "keep":
            continue
        exprs.append(pl.col(c).list.len().alias(c) if mode == "count" else pl.col(c).cast(pl.List(pl.Utf8)).list.join(", ").alias(c))
    return df.with_columns(exprs) if exprs else df


@transform("explode", "schema", "Explode list into rows", "Create one row per item in a list (e.g. one row per part used in a service).",
           [P("column", "List column", "column", column_kind="nested", required=True)], row_preserving=False)
def _explode(df, p, ctx):
    col = _cols(df, p)[0]
    dtype = df.schema[col]
    if isinstance(dtype, pl.Struct):  # e.g. XML <Parts><Part/>…</Parts> → the single list inside
        lists = [f.name for f in dtype.fields if isinstance(f.dtype, pl.List)]
        if not lists:
            raise TransformError(f"'{col}' doesn't contain a list to explode.")
        df = df.with_columns(pl.col(col).struct.field(lists[0]).alias(col))
    out = df.explode(col)
    return _flatten_once(out, [col], "_") if isinstance(out.schema[col], pl.Struct) else out


@transform("extract_field", "schema", "Extract nested field", "Pull one value out of a nested object.",
           [P("column", "Nested column", "column", column_kind="nested", required=True), P("path", "Field path", "text", required=True, placeholder="engine.type"),
            P("output", "New column name", "text")])
def _extract_field(df, p, ctx):
    col = _cols(df, p)[0]
    e = pl.col(col)
    for part in p["path"].split("."):
        e = e.struct.field(part)
    return df.with_columns(e.alias(_out(p, f"{col}_{p['path'].replace('.', '_')}")))


@transform("schema_mapping", "schema", "Map to target schema", "Map source columns to a target schema with names and types in one step.",
           [P("mappings", "Mappings", "schema_map", required=True), P("drop_unmapped", "Remove unmapped columns", "boolean", default=False)], keywords=["mapping", "target"])
def _schema_map(df, p, ctx):
    exprs, keep = [], ["__row_id"] if "__row_id" in df.columns else []
    for m in p.get("mappings") or []:
        src, tgt, typ = m.get("source"), m.get("target") or m.get("source"), m.get("type")
        if src not in df.columns:
            raise TransformError(f"Column '{src}' not found")
        exprs.append((cast_expr(src, typ, df.schema[src]) if typ else pl.col(src)).alias(tgt))
        keep.append(tgt)
    out = df.with_columns(exprs)
    if p.get("drop_unmapped"):
        out = out.select(list(dict.fromkeys(keep)))
    else:
        renamed_sources = {m["source"] for m in p.get("mappings") or [] if m.get("target") and m.get("target") != m.get("source")}
        out = out.drop([c for c in renamed_sources if c in out.columns])
    return out


@transform("schema_evolution_align", "schema", "Align schema variants", "Merge columns that are the same field under different names (e.g. CustomerID vs CustomerId).",
           [P("target", "Keep column", "column", required=True), P("sources", "Merge values from", "columns", required=True)], keywords=["schema drift", "evolution"])
def _align(df, p, ctx):
    tgt = p["target"]
    srcs = [c for c in p.get("sources") or [] if c in df.columns and c != tgt]
    return df.with_columns(pl.coalesce([pl.when(_is_blank(c)).then(None).otherwise(pl.col(c)) for c in [tgt] + srcs]).alias(tgt)).drop(srcs)


# ============================================================================ Derived columns
@transform("derive_column", "derived", "Formula column", "Build a new column with the visual formula builder — arithmetic, text, dates, IF/ELSE.",
           [P("output", "New column name", "text", required=True), P("expression", "Formula", "expression", required=True)], keywords=["calculate", "formula", "computed"])
def _derive(df, p, ctx):
    node = p.get("expression")
    problems = expressions.validate(node, df.columns)
    if problems:
        raise TransformError(" ".join(problems))
    schema = dict(df.schema)
    return df.with_columns(expressions.to_polars(node, schema).alias(_out(p, "new_column")))


@transform("conditional_column", "derived", "Rules column (IF / CASE)", "Assign values using rules: IF conditions THEN value, otherwise a default.",
           [P("output", "New column name", "text", required=True), P("rules", "Rules", "case_rules", required=True), P("default", "Otherwise", "text", default="")],
           keywords=["if", "case", "when", "segment", "bucket"])
def _conditional(df, p, ctx):
    rules = p.get("rules") or []
    if not rules:
        raise TransformError("Add at least one rule.")
    expr = None
    for r in rules:
        cond = combine_conditions(df, r.get("conditions") or [], r.get("logic", "and"))
        expr = pl.when(cond).then(pl.lit(r.get("value"))) if expr is None else expr.when(cond).then(pl.lit(r.get("value")))
    default = p.get("default")
    return df.with_columns(expr.otherwise(pl.lit(default if default not in ("", None) else None)).alias(_out(p, "segment")))


# ============================================================================ Enrichment
@transform("map_codes", "enrich", "Code mapping", "Translate codes into descriptions (e.g. 'A' → 'Active').",
           [P("column", "Code column", "column", required=True), P("mapping", "Code → description", "mapping", required=True),
            P("output", "New column name", "text"), P("default", "Unmapped codes", "text", placeholder="Leave empty to keep the code")])
def _map_codes(df, p, ctx):
    col = _cols(df, p)[0]
    mapping = {str(k).strip().lower(): v for k, v in (p.get("mapping") or {}).items()}
    default = p.get("default")
    key = _s(col).str.strip_chars().str.to_lowercase()
    return df.with_columns(key.replace_strict(mapping, default=pl.lit(default) if default else _s(col), return_dtype=pl.Utf8).alias(_out(p, f"{col}_description")))


@transform("enrich_country", "enrich", "Country enrichment", "Add ISO codes, region and currency for each country.",
           [P("column", "Country column", "column", required=True),
            P("attributes", "Add", "columns", default=["iso2", "region", "currency"],
              options=opts(("iso2", "ISO code"), ("iso3", "ISO-3 code"), ("region", "Region"), ("currency", "Currency"), ("dial", "Dialing code")))])
def _enrich_country(df, p, ctx):
    col = _cols(df, p)[0]
    attrs = p.get("attributes") or ["iso2", "region", "currency"]
    exprs = [pl.col(col).map_elements(lambda v, a=a: (country_lookup(v) or {}).get(a), return_dtype=pl.Utf8).alias(f"{to_snake(col)}_{a}") for a in attrs]
    return df.with_columns(exprs)


FX_TO_USD = {"USD": 1.0, "EUR": 1.08, "GBP": 1.27, "CAD": 0.73, "JPY": 0.0067, "INR": 0.012, "AUD": 0.66, "CHF": 1.12, "MXN": 0.055, "BRL": 0.18, "CNY": 0.14}


@transform("currency_conversion", "enrich", "Currency conversion", "Convert amounts into one reporting currency using reference exchange rates.",
           [P("amount_column", "Amount", "column", required=True), P("currency_column", "Currency code column", "column", required=True),
            P("target", "Convert to", "select", default="USD", options=opts(*FX_TO_USD.keys())), P("output", "New column name", "text")])
def _fx(df, p, ctx):
    amt, cur, tgt = p["amount_column"], p["currency_column"], p.get("target", "USD")
    rate_to_usd = _s(cur).str.strip_chars().str.to_uppercase().replace_strict(FX_TO_USD, default=None, return_dtype=pl.Float64)
    num = numeric_expr(amt) if df.schema[amt] == pl.Utf8 else pl.col(amt)
    return df.with_columns((num * rate_to_usd / FX_TO_USD[tgt]).round(2).alias(_out(p, f"{to_snake(amt)}_{tgt.lower()}")))


@transform("classify_ranges", "enrich", "Business classification (ranges)", "Put numbers into named bands, e.g. revenue tiers or age groups.",
           [P("column", "Value column", "column", required=True), P("bins", "Bands", "bins", required=True), P("output", "New column name", "text")],
           keywords=["tier", "band", "bucket", "segment"])
def _classify(df, p, ctx):
    col = _cols(df, p)[0]
    num = numeric_expr(col) if df.schema[col] == pl.Utf8 else pl.col(col)
    expr = None
    for b in p.get("bins") or []:
        lo = float(b["min"]) if b.get("min") not in (None, "") else float("-inf")
        hi = float(b["max"]) if b.get("max") not in (None, "") else float("inf")
        cond = (num >= lo) & (num < hi)
        expr = pl.when(cond).then(pl.lit(b["label"])) if expr is None else expr.when(cond).then(pl.lit(b["label"]))
    if expr is None:
        raise TransformError("Add at least one band.")
    return df.with_columns(expr.otherwise(None).alias(_out(p, f"{col}_band")))


@transform("reference_lookup", "enrich", "Master data lookup", "Validate and enrich values against a reference / master dataset.",
           [P("column", "Column", "column", required=True), P("right_dataset", "Reference dataset", "dataset", required=True),
            P("right_on", "Reference key", "column", required=True), P("columns", "Attributes to add", "columns"),
            P("flag", "Add 'found in reference' flag", "boolean", default=True)], multi_dataset=True)
def _ref_lookup(df, p, ctx):
    out = _lookup(df, {"right_dataset": p["right_dataset"], "left_on": p["column"], "right_on": p["right_on"], "columns": p.get("columns") or []}, ctx)
    if p.get("flag", True):
        right = _load(ctx, p["right_dataset"])
        keys = right[p["right_on"]].cast(pl.Utf8).str.strip_chars().str.to_lowercase().unique().to_list()
        out = out.with_columns(_s(p["column"]).str.strip_chars().str.to_lowercase().is_in(keys).alias(f"{p['column']}_in_reference"))
    return out


# ============================================================================ Data Quality
@transform("remove_invalid", "quality", "Remove invalid records", "Drop (or quarantine) records that fail a validity check.",
           [P("column", "Column", "column", required=True),
            P("check", "Check", "select", default="email", options=opts(("email", "Valid email"), ("phone", "Valid phone"), ("date", "Valid date"), ("number", "Valid number"),
                                                                       ("not_null", "Not empty"), ("non_negative", "Not negative"), ("in_reference", "Known country"))),
            P("action", "Invalid records", "select", default="remove", options=opts(("remove", "Remove"), ("flag", "Keep and flag")))],
           row_preserving=False, destructive=True)
def _remove_invalid(df, p, ctx):
    col = _cols(df, p)[0]
    check = p.get("check", "email")
    s = _s(col).str.strip_chars()
    valid = {
        "email": s.str.contains(EMAIL_RE),
        "phone": s.str.replace_all(r"\D", "").str.len_chars().is_between(7, 15),
        "date": _as_date(df, col).is_not_null(),
        "number": (numeric_expr(col) if df.schema[col] == pl.Utf8 else pl.col(col)).is_not_null(),
        "not_null": ~_is_blank(col),
        "non_negative": (numeric_expr(col) if df.schema[col] == pl.Utf8 else pl.col(col)) >= 0,
        "in_reference": s.map_elements(lambda v: country_lookup(v) is not None, return_dtype=pl.Boolean),
    }[check]
    if check not in ("not_null",):
        valid = valid | _is_blank(col) if check != "non_negative" else valid.fill_null(True)
    valid = valid.fill_null(False)
    if p.get("action") == "flag":
        return df.with_columns(valid.alias(f"{col}_is_valid"))
    return df.filter(valid)


@transform("clip_outliers", "quality", "Cap outliers", "Limit extreme values to a sensible range (IQR method).",
           [P("column", "Column", "column", column_kind="numeric", required=True), P("factor", "Sensitivity", "number", default=3, advanced=True)])
def _clip(df, p, ctx):
    col = _cols(df, p)[0]
    num = numeric_expr(col) if df.schema[col] == pl.Utf8 else pl.col(col).cast(pl.Float64)
    stats = df.select(num.quantile(0.25).alias("q1"), num.quantile(0.75).alias("q3")).row(0)
    q1, q3 = stats
    if q1 is None:
        return df
    k = float(p.get("factor") or 3)
    lo, hi = q1 - k * (q3 - q1), q3 + k * (q3 - q1)
    clipped = num.clip(lo, hi).round(2)
    return df.with_columns((clipped.cast(pl.Utf8) if df.schema[col] == pl.Utf8 else clipped).alias(col))


# ============================================================================ PII / Governance
def _mask_value(v: str | None, style: str) -> str | None:
    if v is None:
        return None
    if style == "full":
        return "••••••"
    if style == "email" and "@" in v:
        user, dom = v.split("@", 1)
        return (user[:1] + "•••@" + dom) if user else "•••@" + dom
    if len(v) <= 4:
        return "•" * len(v)
    return "•" * (len(v) - 4) + v[-4:]


@transform("mask", "pii", "Mask", "Hide sensitive values while keeping them recognizable (e.g. •••••4567).",
           [P("columns", "Columns", "columns", required=True),
            P("style", "Style", "select", default="partial", options=opts(("partial", "Show last 4 characters"), ("email", "Email (j•••@domain.com)"), ("full", "Hide completely")))])
def _mask(df, p, ctx):
    style = p.get("style", "partial")
    return df.with_columns([_s(c).map_elements(lambda v: _mask_value(v, style), return_dtype=pl.Utf8).alias(c) for c in _cols(df, p)])


@transform("hash", "pii", "Hash", "Replace values with an irreversible SHA-256 fingerprint — still joinable, never readable.",
           [P("columns", "Columns", "columns", required=True), P("salted", "Use organization salt", "boolean", default=True, advanced=True)])
def _hash(df, p, ctx):
    salt = ctx.secret_key if p.get("salted", True) else b""

    def h(v: str | None) -> str | None:
        return None if v is None else hashlib.sha256(salt + v.encode()).hexdigest()

    return df.with_columns([_s(c).map_elements(h, return_dtype=pl.Utf8).alias(c) for c in _cols(df, p)])


@transform("tokenize", "pii", "Tokenize", "Swap values for consistent tokens (tok_…); authorized services can re-identify via the token vault.",
           [P("columns", "Columns", "columns", required=True)])
def _tokenize(df, p, ctx):
    def t(v: str | None) -> str | None:
        return None if v is None else "tok_" + hmac.new(ctx.secret_key, v.encode(), hashlib.sha256).hexdigest()[:16]

    return df.with_columns([_s(c).map_elements(t, return_dtype=pl.Utf8).alias(c) for c in _cols(df, p)])


@transform("encrypt", "pii", "Encrypt", "Encrypt values (AES). Only users with the key can decrypt.", [P("columns", "Columns", "columns", required=True)])
def _encrypt(df, p, ctx):
    from cryptography.fernet import Fernet

    key = base64.urlsafe_b64encode(hashlib.sha256(ctx.secret_key).digest())
    f = Fernet(key)
    return df.with_columns([_s(c).map_elements(lambda v: None if v is None else "enc:" + f.encrypt(v.encode()).decode()[:44], return_dtype=pl.Utf8).alias(c)
                            for c in _cols(df, p)])


@transform("restrict", "pii", "Restrict (remove from output)", "Exclude the column from downstream tables. It stays only in the secured Bronze layer.",
           [P("columns", "Columns", "columns", required=True)], destructive=True)
def _restrict(df, p, ctx):
    return df.drop(_cols(df, p))


# ============================================================================ public API
def list_specs() -> list[dict]:
    order = {c[0]: i for i, c in enumerate(CATEGORIES)}
    specs = sorted((s for s, _ in REGISTRY.values()), key=lambda s: order.get(s.category, 99))
    return [s.model_dump() for s in specs]


def get(type_: str) -> tuple[TransformSpec, Impl]:
    if type_ not in REGISTRY:
        raise TransformError(f"Unknown transformation '{type_}'")
    return REGISTRY[type_]


def validate_params(type_: str, params: dict, columns: list[str]) -> list[str]:
    """Deterministic validation used by the policy engine before any step is accepted."""
    spec, _ = get(type_)
    problems = []
    other_side = {"right_on", "columns"} if spec.multi_dataset else set()
    for ps in spec.params:
        v = params.get(ps.name)
        if ps.required and (v is None or v == "" or v == [] or v == {}):
            problems.append(f"'{ps.label}' is required.")
            continue
        if ps.name in other_side or ps.name == "attributes":
            continue
        if ps.type == "column" and v and v not in columns:
            problems.append(f"Column '{v}' doesn't exist.")
        if ps.type == "columns" and isinstance(v, list):
            missing = [c for c in v if c not in columns]
            if missing:
                problems.append(f"Column(s) not found: {', '.join(missing)}.")
    if type_ == "derive_column" and params.get("expression"):
        problems += expressions.validate(params["expression"], columns)
    if type_ == "convert_types":
        for conv in params.get("conversions") or []:
            if conv.get("column") not in columns:
                problems.append(f"Column '{conv.get('column')}' doesn't exist.")
    return problems


def describe_step(type_: str, params: dict) -> str:
    """Plain-English one-liner for review screens and lineage."""
    spec, _ = get(type_)
    cols = params.get("columns") or ([params["column"]] if params.get("column") else [])
    target = f" on {', '.join(cols[:3])}{'…' if len(cols) > 3 else ''}" if cols else ""
    if type_ == "convert_types":
        conv = params.get("conversions") or []
        return f"Convert {len(conv)} column type{'s' if len(conv) != 1 else ''} ({', '.join(c['column'] + ' → ' + c['to'] for c in conv[:3])}{'…' if len(conv) > 3 else ''})"
    if type_ == "derive_column":
        return f"Create {params.get('output')} = {expressions.describe(params.get('expression') or {})}"
    if type_ == "filter_rows":
        conds = params.get("conditions") or []
        return f"{'Keep' if params.get('mode', 'keep') == 'keep' else 'Remove'} rows where " + f" {params.get('logic', 'and').upper()} ".join(
            f"{c.get('column')} {c.get('op', '').replace('_', ' ')} {c.get('value') if c.get('value') is not None else ''}".strip() for c in conds)
    if type_ == "join":
        return f"{params.get('how', 'left').title()} join on {', '.join(_key_list(params.get('left_on')))}"
    if type_ == "remove_duplicates":
        return f"Remove duplicates by {', '.join(cols) or 'entire row'} (keep {params.get('keep', 'first').replace('_', ' ')})"
    return f"{spec.label}{target}"
