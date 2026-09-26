"""Visual expression builder → Polars.

Users build formulas with blocks (column, value, operator, function, IF/ELSE) in the UI. The UI stores a
JSON expression tree; this module validates and evaluates it. No SQL or code is ever typed or executed.

Node shapes:
  {"type": "column", "name": "Date_of_Birth"}
  {"type": "literal", "value": 10}
  {"type": "op", "op": "+", "left": <node>, "right": <node>}
  {"type": "func", "name": "years_between", "args": [<node>, ...]}
  {"type": "if", "condition": <node>, "then": <node>, "else": <node>}
  {"type": "not", "arg": <node>}
"""
from __future__ import annotations

from datetime import date
from typing import Any

import polars as pl

from ..profiling.semantic import date_expr, numeric_expr

OPS = {"+", "-", "*", "/", "%", "==", "!=", ">", "<", ">=", "<=", "and", "or"}

FUNCTIONS: dict[str, dict[str, Any]] = {
    "upper": {"label": "UPPERCASE", "args": 1, "group": "Text"},
    "lower": {"label": "lowercase", "args": 1, "group": "Text"},
    "trim": {"label": "Trim", "args": 1, "group": "Text"},
    "length": {"label": "Text length", "args": 1, "group": "Text"},
    "concat": {"label": "Combine text", "args": -1, "group": "Text"},
    "left": {"label": "First N characters", "args": 2, "group": "Text"},
    "contains": {"label": "Contains", "args": 2, "group": "Text"},
    "replace": {"label": "Replace", "args": 3, "group": "Text"},
    "coalesce": {"label": "First non-empty", "args": -1, "group": "Logic"},
    "is_empty": {"label": "Is empty", "args": 1, "group": "Logic"},
    "to_number": {"label": "To number", "args": 1, "group": "Number"},
    "round": {"label": "Round", "args": 2, "group": "Number"},
    "abs": {"label": "Absolute value", "args": 1, "group": "Number"},
    "floor": {"label": "Round down", "args": 1, "group": "Number"},
    "ceil": {"label": "Round up", "args": 1, "group": "Number"},
    "to_text": {"label": "To text", "args": 1, "group": "Text"},
    "to_date": {"label": "To date", "args": 1, "group": "Date"},
    "today": {"label": "Today", "args": 0, "group": "Date"},
    "year": {"label": "Year of", "args": 1, "group": "Date"},
    "month": {"label": "Month of", "args": 1, "group": "Date"},
    "day": {"label": "Day of", "args": 1, "group": "Date"},
    "quarter": {"label": "Quarter of", "args": 1, "group": "Date"},
    "days_between": {"label": "Days between", "args": 2, "group": "Date"},
    "years_between": {"label": "Years between", "args": 2, "group": "Date"},
    "add_days": {"label": "Add days", "args": 2, "group": "Date"},
}


class ExpressionError(ValueError):
    pass


def validate(node: Any, columns: list[str], depth: int = 0) -> list[str]:
    """Return a list of human-readable problems (empty when valid)."""
    if depth > 40:
        return ["The formula is nested too deeply."]
    if not isinstance(node, dict) or "type" not in node:
        return ["Incomplete formula block."]
    t = node["type"]
    if t == "column":
        return [] if node.get("name") in columns else [f"Column '{node.get('name')}' doesn't exist."]
    if t == "literal":
        return []
    if t == "op":
        if node.get("op") not in OPS:
            return [f"Unknown operator '{node.get('op')}'."]
        return validate(node.get("left"), columns, depth + 1) + validate(node.get("right"), columns, depth + 1)
    if t == "func":
        spec = FUNCTIONS.get(node.get("name", ""))
        if not spec:
            return [f"Unknown function '{node.get('name')}'."]
        args = node.get("args", [])
        if spec["args"] >= 0 and len(args) != spec["args"]:
            return [f"'{spec['label']}' needs {spec['args']} input(s)."]
        return [p for a in args for p in validate(a, columns, depth + 1)]
    if t == "if":
        return (validate(node.get("condition"), columns, depth + 1) + validate(node.get("then"), columns, depth + 1)
                + validate(node.get("else", {"type": "literal", "value": None}), columns, depth + 1))
    if t == "not":
        return validate(node.get("arg"), columns, depth + 1)
    return [f"Unknown block '{t}'."]


def _as_date(e: pl.Expr) -> pl.Expr:
    return date_expr(e.cast(pl.Utf8))


def _num(e: pl.Expr, schema: dict[str, pl.DataType], node: dict) -> pl.Expr:
    if node.get("type") == "column" and schema.get(node["name"]) == pl.Utf8:
        return numeric_expr(e)
    if node.get("type") == "literal" and isinstance(node.get("value"), str):
        try:
            return pl.lit(float(node["value"]))
        except ValueError:
            return e
    return e


def to_polars(node: dict, schema: dict[str, pl.DataType]) -> pl.Expr:
    t = node["type"]
    if t == "column":
        return pl.col(node["name"])
    if t == "literal":
        v = node.get("value")
        return pl.lit(v)
    if t == "not":
        return ~to_polars(node["arg"], schema)
    if t == "if":
        other = node.get("else")
        return pl.when(to_polars(node["condition"], schema)).then(to_polars(node["then"], schema)).otherwise(
            to_polars(other, schema) if other else pl.lit(None))
    if t == "op":
        op = node["op"]
        left, right = to_polars(node["left"], schema), to_polars(node["right"], schema)
        if op in {"+", "-", "*", "/", "%", ">", "<", ">=", "<="}:
            ln, rn = _num(left, schema, node["left"]), _num(right, schema, node["right"])
            return {"+": ln + rn, "-": ln - rn, "*": ln * rn, "/": ln / rn, "%": ln % rn,
                    ">": ln > rn, "<": ln < rn, ">=": ln >= rn, "<=": ln <= rn}[op]
        return {"==": left == right, "!=": left != right, "and": left & right, "or": left | right}[op]
    if t == "func":
        name = node["name"]
        args = [to_polars(a, schema) for a in node.get("args", [])]
        a0 = args[0] if args else None
        if name == "upper":
            return a0.cast(pl.Utf8).str.to_uppercase()
        if name == "lower":
            return a0.cast(pl.Utf8).str.to_lowercase()
        if name == "trim":
            return a0.cast(pl.Utf8).str.strip_chars()
        if name == "length":
            return a0.cast(pl.Utf8).str.len_chars()
        if name == "concat":
            return pl.concat_str([a.cast(pl.Utf8) for a in args], ignore_nulls=True)
        if name == "left":
            return a0.cast(pl.Utf8).str.slice(0, int(node["args"][1].get("value", 1)))
        if name == "contains":
            return a0.cast(pl.Utf8).str.contains(str(node["args"][1].get("value", "")), literal=True)
        if name == "replace":
            return a0.cast(pl.Utf8).str.replace_all(str(node["args"][1].get("value", "")), str(node["args"][2].get("value", "")), literal=True)
        if name == "coalesce":
            return pl.coalesce(args)
        if name == "is_empty":
            return a0.is_null() | (a0.cast(pl.Utf8).str.strip_chars() == "")
        if name == "to_number":
            return numeric_expr(a0)
        if name == "round":
            return _num(a0, schema, node["args"][0]).round(int(node["args"][1].get("value", 0)))
        if name == "abs":
            return _num(a0, schema, node["args"][0]).abs()
        if name == "floor":
            return _num(a0, schema, node["args"][0]).floor()
        if name == "ceil":
            return _num(a0, schema, node["args"][0]).ceil()
        if name == "to_text":
            return a0.cast(pl.Utf8)
        if name == "to_date":
            return _as_date(a0)
        if name == "today":
            return pl.lit(date.today())
        if name in ("year", "month", "day", "quarter"):
            d = _as_date(a0)
            return getattr(d.dt, name)()
        if name == "days_between":
            return (_as_date(args[1]) - _as_date(a0)).dt.total_days()
        if name == "years_between":
            start, end = _as_date(a0), _as_date(args[1])
            years = end.dt.year() - start.dt.year()
            before_bday = (end.dt.month() < start.dt.month()) | ((end.dt.month() == start.dt.month()) & (end.dt.day() < start.dt.day()))
            return years - before_bday.cast(pl.Int32)
        if name == "add_days":
            return _as_date(a0) + pl.duration(days=_num(args[1], schema, node["args"][1]).cast(pl.Int64))
    raise ExpressionError(f"Unsupported block: {node}")


def describe(node: dict) -> str:
    """Plain-English rendering of the formula for explanations and review screens."""
    t = node.get("type")
    if t == "column":
        return node["name"]
    if t == "literal":
        v = node.get("value")
        return f'"{v}"' if isinstance(v, str) else str(v)
    if t == "op":
        words = {"and": "AND", "or": "OR", "==": "=", "!=": "≠"}
        return f"({describe(node['left'])} {words.get(node['op'], node['op'])} {describe(node['right'])})"
    if t == "func":
        spec = FUNCTIONS.get(node["name"], {"label": node["name"]})
        return f"{spec['label']}({', '.join(describe(a) for a in node.get('args', []))})"
    if t == "if":
        return f"IF {describe(node['condition'])} THEN {describe(node['then'])} ELSE {describe(node.get('else') or {'type': 'literal', 'value': None})}"
    if t == "not":
        return f"NOT {describe(node['arg'])}"
    return "?"

