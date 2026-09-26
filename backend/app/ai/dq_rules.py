"""Plain-English → data quality rule.

    "email must be a valid email address"                 → email rule
    "age between 18 and 120"                              → Age BETWEEN 18 AND 120
    "order date cannot be in the future"                  → to_date(Order_Date) <= current_date()
    "if status is Closed then close date is required"     → NOT (Status = 'Closed') OR (Close_Date IS NOT NULL AND ...)
    "ship date must be after order date"                  → to_date(Ship_Date) > to_date(Order_Date)
    "customer id must be unique, quarantine duplicates"   → unique rule, action quarantine

The deterministic parser understands common business phrasings. When Claude is configured it handles anything
else (grounded in the dataset's column profile). Whatever produced it, the SQL is validated by `dq_sql.validate`
— one boolean predicate on existing columns with whitelisted functions — before it can become a rule.
"""
from __future__ import annotations

import re
from typing import Any

from ..engine import dq_sql

_ACTION_PATTERNS = [
    ("fail", r"\b(fail|stop|abort|halt)\b[\w\s]*\b(pipeline|run|job|load)\b|\bfail (the )?(run|pipeline)\b"),
    ("quarantine", r"\b(quarantine|park|reject|hold back|isolate|move to (the )?dq( table)?)\b"),
    ("drop", r"\b(drop|discard|delete|remove|exclude|filter out)\b[\w\s]*\b(record|row|them|it)s?\b|\b(drop|discard) (it|them|invalid)\b"),
    ("flag", r"\b(flag|highlight|mark|warn|allow but flag|load (it|them) anyway|let (it|them) through)\b"),
]
_SEVERITY = [("critical", r"\bcritical|blocker|must never\b"), ("high", r"\bhigh( priority| severity)?\b|\bimportant\b"),
             ("low", r"\blow( priority| severity)?\b|\bnice to have\b|\bminor\b"), ("medium", r"\bmedium\b")]
_TRAILING_ACTION = re.compile(r"[,;.]?\s*(otherwise|else|and|then|if not|if it fails|when it fails|failures? should)?\s*"
                              r"(quarantine|park|reject|drop|discard|remove|flag|highlight|warn|fail|stop|abort|isolate)\b.*$", re.I)
_NUM = r"-?\d+(?:[.,]\d+)?"
_DATE_LIT = r"\d{4}-\d{2}-\d{2}"


class RuleDraft(dict):
    pass


def _norm(s: str) -> str:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    s = re.sub(r"_+|(?<=[A-Za-z])-(?=[A-Za-z])|\s+[-—–]+\s+", " ", s)  # keep '-' in dates and negative numbers
    return re.sub(r"\be mail\b", "email", re.sub(r"\s+", " ", s).strip().lower())


def _columns_in(text: str, columns: list[str]) -> list[str]:
    """Columns mentioned in the text, in order of appearance (longest names win)."""
    t = " " + _norm(text) + " "
    found: list[tuple[int, int, str]] = []
    for c in columns:
        for variant in {_norm(c), c.lower()}:
            m = re.search(r"(?<![a-z0-9])" + re.escape(variant) + r"(?![a-z0-9])", t)
            if m:
                found.append((m.start(), -len(variant), c))
                break
    found.sort()
    out: list[str] = []
    taken: list[tuple[int, int]] = []
    for start, neglen, c in found:
        end = start - neglen
        if any(s <= start < e for s, e in taken):
            continue
        taken.append((start, end))
        out.append(c)
    return out


def _ident(c: str) -> str:
    return c if re.fullmatch(r"[A-Za-z_]\w*", c) else f"`{c}`"


def _q(v: str) -> str:
    return "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _is_date_col(c: str, types: dict[str, str]) -> bool:
    return types.get(c) in ("date", "date_of_birth", "timestamp") or bool(re.search(r"date|_dt$|_on$|_at$|dob|birth|time", c, re.I))


def _val(v: str) -> str:
    v = v.strip().strip(".").strip()
    if re.fullmatch(_NUM, v):
        return v.replace(",", "")
    if re.fullmatch(_DATE_LIT, v):
        return f"DATE {_q(v)}"
    return _q(v.strip("'\""))


def _values_list(s: str) -> list[str]:
    s = re.sub(r"^[:(\[]\s*|\s*[)\]]\s*$", "", s.strip())
    parts = re.split(r"\s*,\s*|\s+or\s+|\s*/\s*|\s+and\s+", s)
    return [p.strip().strip("'\"").strip() for p in parts if p.strip().strip("'\"")]


def _requirement(text: str, cols: list[str], types: dict[str, str]) -> dict[str, Any] | None:  # noqa: C901 — ordered phrase matching
    """Parse one requirement about a column. Returns {"sql"} or {"rule", "params"} for typed rules."""
    t = _norm(text)
    if not cols:
        return None
    c, ci = cols[0], _ident(cols[0])
    c2 = cols[1] if len(cols) > 1 else None
    # phrases that already carry their own negation mustn't flip the comparison ("must not exceed 10" means <= 10)
    t_neg = re.sub(r"\b(not exceed(ing)?|no (more|less|later|earlier) than|not (more|less|later|earlier) than|not (before|after))\b", "", t)
    neg = bool(re.search(r"\b(must not|mustn t|cannot|can not|can t|should not|shouldn t|never|not allowed to|may not)\b", t_neg))
    col_expr = f"to_date({ci})" if _is_date_col(c, types) else ci

    if re.search(r"\b(unique|distinct|no duplicates?|not (be )?duplicated?|duplicates? (are )?not allowed)\b", t):
        return {"rule": "unique", "dimension": "uniqueness", "label": "must be unique"}
    if re.search(r"\b(is|are) (empty|null|blank|missing)\b", t) and not neg and not re.search(r"\bmust|should|required\b", t):
        return {"sql": f"({ci} IS NULL OR trim(CAST({ci} AS STRING)) = '')", "dimension": "completeness"}
    if re.search(r"(not|never) (be )?(null|empty|blank|missing)|\brequired\b|\bmandatory\b|must (be )?(present|provided|filled|populated|set)|must have a value|"
                 r"(is|are) (not empty|provided|present|populated|filled)|cannot be (null|empty|blank)|\bnot null\b", t):
        return {"rule": "not_null", "dimension": "completeness", "label": "must not be empty"}
    if re.search(r"\bvalid (e ?mail|email address)|\b(e ?mail) (format|address)", t) or (re.search(r"\bvalid\b", t) and "mail" in c.lower()):
        return {"rule": "email", "dimension": "validity", "label": "must be a valid email"}
    if re.search(r"\bvalid (phone|telephone|mobile)", t) or (re.search(r"\bvalid\b", t) and re.search(r"phone|mobile", c, re.I)):
        return {"rule": "phone", "dimension": "validity", "label": "must be a valid phone number"}
    if re.search(r"\bvalid date\b", t) or (re.search(r"\bvalid\b", t) and _is_date_col(c, types)):
        return {"rule": "date", "dimension": "validity", "label": "must be a valid date"}
    if re.search(r"\bvalid country\b|\bknown country\b|\biso country\b", t):
        return {"rule": "in_reference", "dimension": "consistency", "label": "must be a recognized country"}

    # dates relative to today
    if re.search(r"\b(in the future|future date|after today|later than today)\b", t):
        return {"sql": f"{col_expr} <= current_date()" if neg else f"{col_expr} > current_date()", "dimension": "accuracy"}
    if re.search(r"\b(in the past|before today|not later than today|today or earlier|on or before today)\b", t):
        return {"sql": f"{col_expr} {'>=' if neg else '<='} current_date()", "dimension": "accuracy"}
    m = re.search(r"(?:at least|older than|minimum age(?: of)?|over)\s+(\d+)\s+years?(?: old)?", t)
    if m and _is_date_col(c, types):
        return {"sql": f"datediff(current_date(), to_date({ci})) >= {int(int(m.group(1)) * 365.25)}", "dimension": "accuracy"}

    # cross-column comparisons (two columns mentioned, no literal to compare with)
    if c2 and not re.search(_NUM + r"(?!\w)", t.split(_norm(c2))[-1] if _norm(c2) in t else ""):
        c2i = _ident(c2)
        left = f"to_date({ci})" if _is_date_col(c, types) else ci
        right = f"to_date({c2i})" if _is_date_col(c2, types) else c2i
        ops = [(r"on or after|at or after|not before|greater than or equal to|>=|at least", ">="), (r"on or before|not after|less than or equal to|<=|at most", "<="),
               (r"\bafter\b|later than|greater than|more than|bigger than|>|exceeds?", ">"), (r"\bbefore\b|earlier than|less than|smaller than|<", "<"),
               (r"not (equal|the same)|different from|<>|!=", "<>"), (r"\b(equal|equals|the same as|match(es)?)\b|=", "=")]
        for pat, op in ops:
            if re.search(pat, t):
                if neg:
                    op = {">": "<=", "<": ">=", ">=": "<", "<=": ">", "=": "<>", "<>": "="}[op]
                return {"sql": f"{left} {op} {right}", "dimension": "consistency"}

    m = re.search(rf"between\s+({_DATE_LIT}|{_NUM})\s+(?:and|to|-)\s+({_DATE_LIT}|{_NUM})", t)
    if m:
        lo, hi = m.group(1), m.group(2)
        expr = col_expr if re.fullmatch(_DATE_LIT, lo) else ci
        s = f"{expr} BETWEEN {_val(lo)} AND {_val(hi)}"
        return {"sql": f"NOT ({s})" if neg else s, "dimension": "range"}

    if re.search(r"\bnon ?negative\b|\bnot (be )?negative\b|\b(cannot|can not|can t|must not|mustn t|should not|may not|never) be (a )?negative\b|"
                 r"zero or (more|greater|positive|above)|\b>= ?0\b", t):
        return {"sql": f"{ci} >= 0", "dimension": "range"}
    if re.search(r"\bpositive\b|greater than zero|more than zero|above zero", t) and not neg:
        return {"sql": f"{ci} > 0", "dimension": "range"}
    if re.search(r"\bnegative\b", t) and not neg:
        return {"sql": f"{ci} < 0", "dimension": "range"}
    compare = [(r"(?:greater than or equal to|at least|no less than|minimum(?: of| is)?|min(?:imum)?|on or after|not before|>=)\s*", ">="),
               (r"(?:less than or equal to|at most|no more than|maximum(?: of| is)?|max(?:imum)?|up to|on or before|not after|<=|not exceed(?:ing)?|not more than)\s*", "<="),
               (r"(?:greater than|more than|above|over|exceeds?|higher than|bigger than|after|later than|>)\s*", ">"),
               (r"(?:less than|below|under|lower than|smaller than|before|earlier than|<)\s*", "<")]
    for pat, op in compare:
        m = re.search(pat + rf"({_DATE_LIT}|{_NUM})(?!\s*(characters|chars|digits|letters))", t)
        if m:
            v = m.group(1)
            expr = col_expr if re.fullmatch(_DATE_LIT, v) else ci
            if neg:
                op = {">": "<=", "<": ">=", ">=": "<", "<=": ">"}[op]
            return {"sql": f"{expr} {op} {_val(v)}", "dimension": "range"}

    m = re.search(r"(exactly\s+)?(\d+)\s+(characters|chars|digits|letters)\s*(long)?", t)
    if m:
        n = int(m.group(2))
        if re.search(r"at least|minimum|min\b", t):
            return {"sql": f"length({ci}) >= {n}", "dimension": "validity"}
        if re.search(r"at most|maximum|max\b|up to|no more than", t):
            return {"sql": f"length({ci}) <= {n}", "dimension": "validity"}
        if m.group(3) == "digits":
            return {"sql": f"{ci} RLIKE '^[0-9]{{{n}}}$'", "dimension": "pattern"}
        return {"sql": f"length({ci}) = {n}", "dimension": "validity"}
    m = re.search(r"length (?:of \w+ )?(?:is|=|must be|should be|equals?) (\d+)", t)
    if m:
        return {"sql": f"length({ci}) = {int(m.group(1))}", "dimension": "validity"}

    raw = text  # patterns and values keep their original case
    m = re.search(r"(?:match(?:es)?|follow(?:s)?|in) (?:the )?(?:pattern|regex|format|regular expression)\s*[:=]?\s*['\"]?([^'\"]+)['\"]?", raw, re.I)
    if m:
        p = m.group(1).strip().rstrip(".")
        if not re.search(r"[\\^$\[\](){}|+*?]", p):
            p = "^" + "".join("[A-Za-z]" if ch in "Aa" else "[0-9]" if ch in "9#" else "[A-Za-z0-9]" if ch in "Xx" else re.escape(ch) for ch in p) + "$"
        return {"rule": "regex", "params": {"pattern": p}, "dimension": "pattern", "label": f"must match {m.group(1).strip()}"}
    if re.search(r"\b(only digits|only numbers|numeric|all digits|digits only)\b", t):
        return {"sql": f"{'NOT ' if neg else ''}{ci} RLIKE '^[0-9]+$'", "dimension": "pattern"}
    if re.search(r"\balphanumeric\b", t):
        return {"sql": f"{ci} RLIKE '^[A-Za-z0-9]+$'", "dimension": "pattern"}
    if re.search(r"\b(upper ?case|all caps|capital letters)\b", t):
        return {"sql": f"{ci} = upper({ci})", "dimension": "consistency"}
    if re.search(r"\blower ?case\b", t):
        return {"sql": f"{ci} = lower({ci})", "dimension": "consistency"}
    if re.search(r"\bno (spaces|whitespace)\b|without spaces", t):
        return {"sql": f"NOT contains({ci}, ' ')", "dimension": "pattern"}
    for word, fn in (("start(?:s)? with", "startswith"), ("end(?:s)? with", "endswith"), ("contain(?:s)?", "contains")):
        m = re.search(rf"\b{word}\s+['\"]?([^'\"]+?)['\"]?\s*$", raw, re.I)
        if m:
            s = f"{fn}({ci}, {_q(m.group(1).strip())})"
            return {"sql": f"NOT {s}" if neg else s, "dimension": "pattern"}

    m = re.search(r"\b(?:one of|in the list|in list|either|in)\b\s*[:(\[]?\s*(.+)$", raw, re.I)
    if m:
        vals = _values_list(m.group(1))
        if len(vals) >= 2:
            s = f"{ci} IN ({', '.join(_q(v) for v in vals)})"
            return {"sql": f"NOT ({s})" if neg or re.search(r"\bnot (one of|in)\b", t) else s, "dimension": "consistency"}
    m = re.search(r"\b(?:is|=|equals?|must be|should be|be|==)\s+(?:equal to\s+)?['\"]?([^'\"]+?)['\"]?\s*$", raw, re.I)
    if m:
        v = m.group(1).strip()
        low = v.lower()
        if low in ("true", "yes"):
            return {"sql": f"{ci} = TRUE" if not neg else f"{ci} = FALSE", "dimension": "validity"}
        if low in ("false", "no"):
            return {"sql": f"{ci} = FALSE" if not neg else f"{ci} = TRUE", "dimension": "validity"}
        if _norm(v) != _norm(c) and len(v) <= 60 and not re.search(r"\b(valid|correct|proper|accurate)\b", low):
            vals = _values_list(v)
            if len(vals) >= 2 and re.search(r",|\bor\b", v):
                s = f"{ci} IN ({', '.join(_q(x) for x in vals)})"
            else:
                s = f"{ci} = {_val(v)}"
            return {"sql": f"NOT ({s})" if neg else s, "dimension": "consistency"}
    return None


_SQL_HINT = re.compile(r"<=|>=|<>|!=|==|\b\w+\s*\([^)]*\)|\bIS\s+(NOT\s+)?NULL\b|\b(AND|OR)\b.*[=<>]|^\s*`|\bRLIKE\b|\bBETWEEN\s+\S+\s+AND\b.*[=<>]")


def looks_like_sql(text: str) -> bool:
    """Operators, function calls or upper-case SQL keywords — English sentences rarely contain these."""
    return bool(_SQL_HINT.search(text))


def _typed_sql(req: dict[str, Any], column: str) -> str:
    from ..engine.metadata import QualityRule
    from ..engine.quality import rule_sql

    return rule_sql(QualityRule(dataset_id="x", column=column, rule=req["rule"], params=req.get("params") or {})) or "TRUE"


def detect_action(text: str) -> str | None:
    t = text.lower()
    for action, pat in _ACTION_PATTERNS:
        if re.search(pat, t):
            return action
    return None


def detect_severity(text: str) -> str | None:
    t = text.lower()
    return next((sev for sev, pat in _SEVERITY if re.search(pat, t)), None)


def heuristic(text: str, columns: list[str], types: dict[str, str] | None = None) -> dict[str, Any] | None:
    types = types or {}
    raw = text.strip()
    # 1. Already SQL? If the text clearly *is* SQL, report the SQL problem rather than reinterpreting it as English.
    try:
        sql, used = dq_sql.validate(raw, columns)
        return {"rule": "expression", "params": {"sql": sql}, "columns": used, "dimension": "custom", "engine": "sql",
                "explanation": "Used your SQL condition as written (validated against the dataset's columns)."}
    except dq_sql.DQSqlError:
        if looks_like_sql(raw):
            raise
    body = _TRAILING_ACTION.sub("", raw).strip() or raw
    # 2. Conditional: "if <condition> then <requirement>"
    m = re.match(r"^\s*(?:if|when|where|for (?:rows|records) where)\s+(.+?)(?:\s*,\s*|\s+then\s+)(.+)$", body, re.I)
    if m:
        cond_txt, req_txt = m.group(1), m.group(2)
        cc, rc = _columns_in(cond_txt, columns), _columns_in(req_txt, columns)
        cond = _requirement(cond_txt, cc, types)
        req = _requirement(req_txt, rc or cc, types)
        if cond and req:
            cond_sql = cond.get("sql") or _typed_sql(cond, cc[0])
            req_sql = req.get("sql") or _typed_sql(req, (rc or cc)[0])
            sql = f"NOT ({cond_sql}) OR ({req_sql})"
            return {"rule": "expression", "params": {"sql": sql}, "columns": list(dict.fromkeys(cc + rc)), "dimension": "consistency", "engine": "rules",
                    "explanation": f"Only rows where {cond_txt.strip()} are checked; for them, {req_txt.strip()}."}
    # 3. A requirement on one (or two) columns
    cols = _columns_in(body, columns)
    if not cols:
        return None
    req = _requirement(body, cols, types)
    if not req:
        return None
    if "rule" in req:
        return {"rule": req["rule"], "column": cols[0], "params": req.get("params") or {}, "columns": [cols[0]], "dimension": req["dimension"],
                "engine": "rules", "explanation": f"{cols[0]} {req.get('label', '')}."}
    return {"rule": "expression", "params": {"sql": req["sql"]}, "columns": cols, "dimension": req["dimension"], "engine": "rules",
            "explanation": "Converted your sentence into a SQL condition."}


def convert(text: str, columns: list[str], types: dict[str, str] | None = None, samples: dict[str, list] | None = None) -> dict[str, Any]:
    """Plain English → validated rule draft. Raises dq_sql.DQSqlError with a helpful message if it can't."""
    text = (text or "").strip()
    if len(text) < 4:
        raise dq_sql.DQSqlError("Describe the rule, e.g. 'Email must be a valid email address'.")
    draft = heuristic(text, columns, types)
    if draft is None:
        from . import llm

        if llm.is_enabled():
            draft = llm.dq_rule_from_text(text, columns, types or {}, samples or {})
    if draft is None:
        raise dq_sql.DQSqlError("We couldn't turn that into a rule. Mention the column and the condition, e.g. "
                                "'Order date cannot be in the future' or 'Amount must be greater than 0'. You can also type a SQL condition.")
    if draft["rule"] == "expression":
        sql, used = dq_sql.validate(draft["params"]["sql"], columns)  # policy gate for every generated rule
        draft["params"]["sql"] = sql
        draft["columns"] = used
        draft["column"] = used[0] if len(used) == 1 else None
    draft["action"] = detect_action(text)
    draft["severity"] = detect_severity(text)
    draft["name"] = text[0].upper() + text[1:120].rstrip(".")
    return draft
