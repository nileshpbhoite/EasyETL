"""SQL data-quality rules.

A DQ rule written as SQL is a single boolean predicate in Databricks SQL, e.g.

    to_date(order_date) <= current_date() AND amount > 0

The same predicate becomes the Lakeflow expectation when deployed. Locally (previews, DQ scores before deploy)
it's translated to a Polars expression with Spark-like coercion (a string column compared with a number is
cast to a number, with a date is parsed as a date). NULL results count as *passing* in both places, matching
how EasyETL generates the Databricks code (`COALESCE((rule), TRUE)`): use a not-null rule for missing values.

Validation is strict: one expression only, no queries/subqueries/statements, only known columns and a
whitelisted set of functions.
"""
from __future__ import annotations

import difflib
import logging
import re
from datetime import date, datetime
from typing import Callable

import polars as pl
import sqlglot
from sqlglot import exp

from ..profiling.semantic import date_expr, numeric_expr

logging.getLogger("sqlglot").setLevel(logging.ERROR)  # plain English is tried as SQL first; don't log its parse fallback


class DQSqlError(ValueError):
    pass


# Node types a predicate may contain (functions are listed separately below).
_STRUCTURE = (exp.And, exp.Or, exp.Not, exp.Paren, exp.EQ, exp.NEQ, exp.GT, exp.GTE, exp.LT, exp.LTE, exp.Is, exp.In, exp.Between,
              exp.Like, exp.ILike, exp.RegexpLike, exp.Column, exp.Identifier, exp.Literal, exp.Boolean, exp.Null, exp.DataType,
              exp.Add, exp.Sub, exp.Mul, exp.Div, exp.Mod, exp.Neg, exp.Case, exp.If, exp.Var, exp.Tuple)
_FUNCS = (exp.Cast, exp.TryCast, exp.Coalesce, exp.Length, exp.Upper, exp.Lower, exp.Trim, exp.Abs, exp.Round, exp.CurrentDate,
          exp.CurrentTimestamp, exp.TsOrDsToDate, exp.StrToDate, exp.Year, exp.Month, exp.Day, exp.DateDiff, exp.RegexpReplace,
          exp.Substring, exp.Concat, exp.StartsWith, exp.Anonymous, *(getattr(exp, n) for n in ("Contains", "EndsWith") if hasattr(exp, n)))
_ANON = {"isnull", "isnotnull", "endswith", "contains", "nvl", "ifnull", "ltrim", "rtrim", "lcase", "ucase", "len"}
FUNCTION_NAMES = sorted({"length", "char_length", "upper", "lower", "trim", "ltrim", "rtrim", "abs", "round", "coalesce", "nvl", "ifnull",
                         "current_date", "current_timestamp", "to_date", "year", "month", "day", "datediff", "regexp_replace", "substring",
                         "concat", "startswith", "endswith", "contains", "isnull", "isnotnull", "cast", "try_cast"})
_SIMPLE_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _parse(sql: str) -> exp.Expression:
    text = (sql or "").strip().rstrip(";").strip()
    if not text:
        raise DQSqlError("Write a condition, e.g. amount > 0.")
    if ";" in text:
        raise DQSqlError("Only one condition is allowed — remove the ';'.")
    try:
        tree = sqlglot.parse_one(text, read="databricks")
    except sqlglot.errors.ParseError as e:
        raise DQSqlError(f"That isn't valid SQL: {str(e).splitlines()[0][:160]}") from e
    if tree is None:
        raise DQSqlError("Write a condition, e.g. amount > 0.")
    for node in tree.walk():
        if isinstance(node, (exp.Select, exp.Subquery, exp.Query, exp.Table, exp.From)) or isinstance(node, exp.DDL) or isinstance(node, exp.DML):
            raise DQSqlError("A rule is a condition on the row's columns — queries and statements aren't allowed.")
        if isinstance(node, exp.Anonymous):
            if str(node.this).lower() not in _ANON:
                raise DQSqlError(f"The function '{node.this}' isn't supported in rules. Supported: {', '.join(FUNCTION_NAMES)}.")
            continue
        if isinstance(node, _FUNCS) or isinstance(node, _STRUCTURE):
            continue
        name = node.key.replace("_", " ")
        raise DQSqlError(f"'{name}' isn't supported in data quality rules. Supported functions: {', '.join(FUNCTION_NAMES)}.")
    return tree


def _quote(name: str) -> exp.Identifier:
    return exp.to_identifier(name, quoted=not _SIMPLE_IDENT.match(name))


def validate(sql: str, columns: list[str]) -> tuple[str, list[str]]:
    """Return (normalized Databricks SQL, columns used). Raises DQSqlError with a user-friendly message."""
    tree = _parse(sql)
    lookup = {c.lower(): c for c in columns}
    squashed = {re.sub(r"[\s_]+", "", c.lower()): c for c in columns}
    used: list[str] = []
    for col in list(tree.find_all(exp.Column)):
        name = col.name
        real = lookup.get(name.lower()) or squashed.get(re.sub(r"[\s_]+", "", name.lower()))
        if not real:
            close = difflib.get_close_matches(name, columns, n=1, cutoff=0.6)
            hint = f" Did you mean '{close[0]}'?" if close else ""
            raise DQSqlError(f"There's no column '{name}'.{hint}")
        col.set("table", None)
        col.set("this", _quote(real))
        if real not in used:
            used.append(real)
    if isinstance(tree, (exp.Column, exp.Literal)) and not isinstance(tree, exp.Boolean):
        raise DQSqlError("A rule must be a true/false condition, e.g. email IS NOT NULL.")
    return tree.sql(dialect="databricks"), used


def rename_columns(sql: str, rename: Callable[[str], str]) -> str:
    """Rewrite column references (used when transformations rename columns after a rule was written)."""
    try:
        tree = sqlglot.parse_one(sql, read="databricks")
    except sqlglot.errors.ParseError:
        return sql
    for col in list(tree.find_all(exp.Column)):
        col.set("this", _quote(rename(col.name)))
    return tree.sql(dialect="databricks")


def pyspark_code(sql: str, name: str = "rule") -> str:
    """Runnable PySpark for the rule (what EasyETL's generated pipeline does for every rule)."""
    safe = re.sub(r"\W+", "_", name.lower()).strip("_")[:40] or "rule"
    body = sql.replace('"""', '\\"\\"\\"')
    return (
        "from pyspark.sql import functions as F\n\n"
        f'passes_{safe} = F.coalesce(F.expr("""{body}"""), F.lit(True))\n\n'
        f"checked = df.withColumn(\"_dq_{safe}\", passes_{safe})\n"
        f"failures = checked.filter(~F.col(\"_dq_{safe}\"))\n"
    )


# ------------------------------------------------------------------ Polars translation
_NUM = (pl.Float64, pl.Float32, pl.Int64, pl.Int32, pl.Int16, pl.Int8, pl.UInt64, pl.UInt32, pl.UInt16, pl.UInt8)


class _T:
    def __init__(self, expr: pl.Expr, kind: str):
        self.e, self.k = expr, kind  # kind: str | num | date | ts | bool | null


def _kind_of(dtype: pl.DataType) -> str:
    if dtype in _NUM or isinstance(dtype, pl.Decimal):
        return "num"
    if dtype == pl.Date:
        return "date"
    if isinstance(dtype, pl.Datetime):
        return "ts"
    if dtype == pl.Boolean:
        return "bool"
    return "str"


def _as(t: _T, kind: str) -> pl.Expr:
    if t.k == kind or t.k == "null":
        return t.e
    if kind == "num":
        return numeric_expr(t.e) if t.k == "str" else t.e.cast(pl.Float64, strict=False)
    if kind == "date":
        return date_expr(t.e) if t.k == "str" else t.e.cast(pl.Date, strict=False)
    if kind == "ts":
        return t.e.cast(pl.Datetime, strict=False) if t.k == "date" else date_expr(t.e).cast(pl.Datetime) if t.k == "str" else t.e
    if kind == "str":
        return t.e.cast(pl.Utf8)
    if kind == "bool":
        return t.e.cast(pl.Utf8).str.to_lowercase().is_in(["true", "1", "yes", "y"]) if t.k == "str" else t.e.cast(pl.Boolean, strict=False)
    return t.e


def _common(a: _T, b: _T) -> str:
    kinds = {a.k, b.k} - {"null"}
    for k in ("ts", "date", "num", "bool"):
        if k in kinds:
            return "date" if k == "ts" and "date" in kinds else k
    return "str"


def _like_to_regex(pattern: str) -> str:
    out = "".join(".*" if ch == "%" else "." if ch == "_" else re.escape(ch) for ch in pattern)
    return f"^{out}$"


def _lit_str(node: exp.Expression) -> str:
    if isinstance(node, exp.Literal):
        return node.this
    raise DQSqlError("This function needs a text value in quotes.")


def to_polars(sql: str, schema: dict[str, pl.DataType]) -> pl.Expr:
    """Boolean Polars expression; True where the record passes. NULL → pass."""
    tree = _parse(sql)
    return _as(_tr(tree, schema), "bool").fill_null(True)


def _tr(n: exp.Expression, schema: dict[str, pl.DataType]) -> _T:  # noqa: C901 — a flat dispatcher reads best here
    t = lambda x: _tr(x, schema)  # noqa: E731
    if isinstance(n, exp.Paren):
        return t(n.this)
    if isinstance(n, exp.Column):
        if n.name not in schema:
            raise DQSqlError(f"There's no column '{n.name}'.")
        return _T(pl.col(n.name), _kind_of(schema[n.name]))
    if isinstance(n, exp.Boolean):
        return _T(pl.lit(bool(n.this)), "bool")
    if isinstance(n, exp.Null):
        return _T(pl.lit(None), "null")
    if isinstance(n, exp.Literal):
        if n.is_string:
            return _T(pl.lit(n.this), "str")
        v = float(n.this)
        return _T(pl.lit(int(v) if v.is_integer() and "." not in n.this else v), "num")
    if isinstance(n, exp.Neg):
        return _T(-_as(t(n.this), "num"), "num")
    if isinstance(n, exp.And):
        return _T(_as(t(n.this), "bool") & _as(t(n.expression), "bool"), "bool")
    if isinstance(n, exp.Or):
        return _T(_as(t(n.this), "bool") | _as(t(n.expression), "bool"), "bool")
    if isinstance(n, exp.Not):
        return _T(~_as(t(n.this), "bool"), "bool")
    if isinstance(n, (exp.EQ, exp.NEQ, exp.GT, exp.GTE, exp.LT, exp.LTE)):
        a, b = t(n.this), t(n.expression)
        k = _common(a, b)
        x, y = _as(a, k), _as(b, k)
        if k == "str" and isinstance(n, (exp.EQ, exp.NEQ)):
            x, y = x.str.strip_chars(), y.str.strip_chars()
        op = {exp.EQ: x.eq, exp.NEQ: x.ne, exp.GT: x.gt, exp.GTE: x.ge, exp.LT: x.lt, exp.LTE: x.le}[type(n)]
        return _T(op(y), "bool")
    if isinstance(n, exp.Is):
        return _T(t(n.this).e.is_null(), "bool")
    if isinstance(n, exp.In):
        a = t(n.this)
        vals = [v for v in n.expressions]
        lits = [t(v) for v in vals]
        k = _common(a, lits[0]) if lits else a.k
        if k == "num":
            return _T(_as(a, "num").is_in([float(v.this) for v in vals if isinstance(v, exp.Literal)]), "bool")
        return _T(_as(a, "str").str.strip_chars().is_in([str(v.this) for v in vals if isinstance(v, exp.Literal)]), "bool")
    if isinstance(n, exp.Between):
        a, lo, hi = t(n.this), t(n.args["low"]), t(n.args["high"])
        k = _common(a, lo)
        return _T((_as(a, k) >= _as(lo, k)) & (_as(a, k) <= _as(hi, k)), "bool")
    if isinstance(n, (exp.Like, exp.ILike)):
        a = _as(t(n.this), "str")
        rx = _like_to_regex(_lit_str(n.expression))
        return _T(a.str.contains(("(?i)" if isinstance(n, exp.ILike) else "") + rx), "bool")
    if isinstance(n, exp.RegexpLike):
        return _T(_as(t(n.this), "str").str.contains(_lit_str(n.expression)), "bool")
    if isinstance(n, (exp.Add, exp.Sub, exp.Mul, exp.Div, exp.Mod)):
        a, b = _as(t(n.this), "num"), _as(t(n.expression), "num")
        return _T({exp.Add: a + b, exp.Sub: a - b, exp.Mul: a * b, exp.Div: a / b, exp.Mod: a % b}[type(n)], "num")
    if isinstance(n, (exp.Cast, exp.TryCast)):
        to = n.args["to"].this
        a = t(n.this)
        if to in (exp.DataType.Type.DATE,):
            return _T(_as(a, "date"), "date")
        if to in (exp.DataType.Type.TIMESTAMP, exp.DataType.Type.TIMESTAMPNTZ, exp.DataType.Type.TIMESTAMPLTZ):
            return _T(_as(a, "ts"), "ts")
        if to in (exp.DataType.Type.BOOLEAN,):
            return _T(_as(a, "bool"), "bool")
        if to in (exp.DataType.Type.VARCHAR, exp.DataType.Type.TEXT, exp.DataType.Type.CHAR, exp.DataType.Type.NVARCHAR):
            return _T(_as(a, "str"), "str")
        num = _as(a, "num")
        if to in (exp.DataType.Type.INT, exp.DataType.Type.BIGINT, exp.DataType.Type.SMALLINT, exp.DataType.Type.TINYINT):
            num = num.cast(pl.Int64, strict=False)
        return _T(num, "num")
    if isinstance(n, (exp.TsOrDsToDate, exp.StrToDate)):
        return _T(_as(t(n.this), "date"), "date")
    if isinstance(n, exp.CurrentDate):
        return _T(pl.lit(date.today()), "date")
    if isinstance(n, exp.CurrentTimestamp):
        return _T(pl.lit(datetime.now()), "ts")
    if isinstance(n, (exp.Year, exp.Month, exp.Day)):
        d = _as(t(n.this), "date")
        return _T({exp.Year: d.dt.year(), exp.Month: d.dt.month(), exp.Day: d.dt.day()}[type(n)].cast(pl.Float64), "num")
    if isinstance(n, exp.DateDiff):
        return _T((_as(t(n.this), "date") - _as(t(n.expression), "date")).dt.total_days().cast(pl.Float64), "num")
    if isinstance(n, exp.Length):
        return _T(_as(t(n.this), "str").str.len_chars().cast(pl.Float64), "num")
    if isinstance(n, exp.Upper):
        return _T(_as(t(n.this), "str").str.to_uppercase(), "str")
    if isinstance(n, exp.Lower):
        return _T(_as(t(n.this), "str").str.to_lowercase(), "str")
    if isinstance(n, exp.Trim):
        return _T(_as(t(n.this), "str").str.strip_chars(), "str")
    if isinstance(n, exp.Abs):
        return _T(_as(t(n.this), "num").abs(), "num")
    if isinstance(n, exp.Round):
        dec = int(n.args["decimals"].this) if n.args.get("decimals") is not None else 0
        return _T(_as(t(n.this), "num").round(dec), "num")
    if isinstance(n, exp.Coalesce):
        parts = [t(n.this)] + [t(x) for x in n.expressions]
        k = next((p.k for p in parts if p.k != "null"), "str")
        return _T(pl.coalesce([_as(p, k) for p in parts]), k)
    if isinstance(n, exp.RegexpReplace):
        rep = _lit_str(n.args["replacement"]) if n.args.get("replacement") is not None else ""
        return _T(_as(t(n.this), "str").str.replace_all(_lit_str(n.expression), rep), "str")
    if isinstance(n, exp.Substring):
        start = int(n.args["start"].this) if n.args.get("start") is not None else 1
        length = int(n.args["length"].this) if n.args.get("length") is not None else None
        return _T(_as(t(n.this), "str").str.slice(max(start - 1, 0), length), "str")
    if isinstance(n, exp.Concat):
        return _T(pl.concat_str([_as(t(x), "str") for x in n.expressions]), "str")
    if isinstance(n, exp.StartsWith):
        return _T(_as(t(n.this), "str").str.starts_with(_lit_str(n.expression)), "bool")
    if type(n).__name__ == "EndsWith":
        return _T(_as(t(n.this), "str").str.ends_with(_lit_str(n.expression)), "bool")
    if type(n).__name__ == "Contains":
        return _T(_as(t(n.this), "str").str.contains(_lit_str(n.expression), literal=True), "bool")
    if isinstance(n, exp.If):
        cond = _as(t(n.this), "bool")
        yes, no = t(n.args["true"]), t(n.args["false"]) if n.args.get("false") is not None else _T(pl.lit(None), "null")
        k = yes.k if yes.k != "null" else no.k
        return _T(pl.when(cond).then(_as(yes, k)).otherwise(_as(no, k)), k)
    if isinstance(n, exp.Case):
        branches = n.args.get("ifs") or []
        default = t(n.args["default"]) if n.args.get("default") is not None else _T(pl.lit(None), "null")
        kind = next((t(b.args["true"]).k for b in branches if t(b.args["true"]).k != "null"), default.k)
        chain = None
        for b in branches:
            cond, val = _as(t(b.this), "bool"), _as(t(b.args["true"]), kind)
            chain = pl.when(cond).then(val) if chain is None else chain.when(cond).then(val)
        return _T(chain.otherwise(_as(default, kind)) if chain is not None else _as(default, kind), kind)
    if isinstance(n, exp.Anonymous):
        fn = str(n.this).lower()
        args = n.expressions
        if fn == "isnull":
            return _T(t(args[0]).e.is_null(), "bool")
        if fn == "isnotnull":
            return _T(t(args[0]).e.is_not_null(), "bool")
        if fn in ("endswith", "contains"):
            s = _as(t(args[0]), "str")
            v = _lit_str(args[1])
            return _T(s.str.ends_with(v) if fn == "endswith" else s.str.contains(v, literal=True), "bool")
        if fn in ("nvl", "ifnull"):
            a, b = t(args[0]), t(args[1])
            k = a.k if a.k != "null" else b.k
            return _T(pl.coalesce([_as(a, k), _as(b, k)]), k)
        if fn in ("ltrim", "rtrim"):
            s = _as(t(args[0]), "str")
            return _T(s.str.strip_chars_start() if fn == "ltrim" else s.str.strip_chars_end(), "str")
        if fn in ("lcase", "ucase"):
            s = _as(t(args[0]), "str")
            return _T(s.str.to_lowercase() if fn == "lcase" else s.str.to_uppercase(), "str")
        if fn == "len":
            return _T(_as(t(args[0]), "str").str.len_chars().cast(pl.Float64), "num")
    raise DQSqlError(f"'{n.key}' isn't supported in data quality rules.")


def evaluate(df: pl.DataFrame, sql: str) -> pl.Series:
    """Boolean Series of pass/fail for each row."""
    schema = dict(df.schema)
    return df.select(to_polars(sql, schema).alias("ok"))["ok"]
