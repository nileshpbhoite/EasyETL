"""Deterministic semantic detection + parsing helpers shared by the profiler, the transformation engine and
data-quality rules. Everything here is rule-based and explainable."""
from __future__ import annotations

import re
from typing import Any

import polars as pl

EMAIL_RE = r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$"
URL_RE = r"^https?://[^\s]+$"
SSN_RE = r"^\d{3}-\d{2}-\d{4}$"
CARD_RE = r"^(?:\d[ -]?){13,19}$"
IBAN_RE = r"^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$"
POSTAL_RE = r"^(\d{5}(-\d{4})?|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|[A-Z]\d[A-Z] ?\d[A-Z]\d)$"
NUMERIC_CLEAN_RE = r"[$€£¥,\s%]"

DATE_FORMATS = ["%Y-%m-%d", "%m/%d/%Y", "%d %b %Y", "%Y/%m/%d", "%d-%m-%Y", "%b %d, %Y", "%d/%m/%Y", "%Y%m%d",
                "%d.%m.%Y", "%B %d, %Y", "%d %B %Y"]
DATETIME_FORMATS = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%SZ",
                    "%Y-%m-%dT%H:%M:%S%.fZ", "%m/%d/%Y %H:%M", "%Y-%m-%dT%H:%M:%S%z"]

TRUE_VALUES = {"true", "t", "yes", "y", "1", "on"}
FALSE_VALUES = {"false", "f", "no", "n", "0", "off"}

# ------------------------------------------------------------------ reference data
COUNTRIES: list[dict[str, Any]] = [
    {"name": "United States", "iso2": "US", "iso3": "USA", "currency": "USD", "dial": "1", "region": "North America",
     "aliases": ["usa", "us", "u.s.a.", "u.s.", "united states", "united states of america", "america", "states"]},
    {"name": "United Kingdom", "iso2": "GB", "iso3": "GBR", "currency": "GBP", "dial": "44", "region": "Europe",
     "aliases": ["uk", "u.k.", "united kingdom", "great britain", "gb", "gbr", "england", "britain", "scotland", "wales"]},
    {"name": "Germany", "iso2": "DE", "iso3": "DEU", "currency": "EUR", "dial": "49", "region": "Europe",
     "aliases": ["germany", "de", "deu", "deutschland", "federal republic of germany"]},
    {"name": "Canada", "iso2": "CA", "iso3": "CAN", "currency": "CAD", "dial": "1", "region": "North America",
     "aliases": ["canada", "ca", "can"]},
    {"name": "France", "iso2": "FR", "iso3": "FRA", "currency": "EUR", "dial": "33", "region": "Europe", "aliases": ["france", "fr", "fra", "république française"]},
    {"name": "Spain", "iso2": "ES", "iso3": "ESP", "currency": "EUR", "dial": "34", "region": "Europe", "aliases": ["spain", "es", "esp", "españa"]},
    {"name": "Italy", "iso2": "IT", "iso3": "ITA", "currency": "EUR", "dial": "39", "region": "Europe", "aliases": ["italy", "it", "ita", "italia"]},
    {"name": "Netherlands", "iso2": "NL", "iso3": "NLD", "currency": "EUR", "dial": "31", "region": "Europe", "aliases": ["netherlands", "nl", "nld", "holland", "the netherlands"]},
    {"name": "India", "iso2": "IN", "iso3": "IND", "currency": "INR", "dial": "91", "region": "Asia", "aliases": ["india", "in", "ind", "bharat"]},
    {"name": "Japan", "iso2": "JP", "iso3": "JPN", "currency": "JPY", "dial": "81", "region": "Asia", "aliases": ["japan", "jp", "jpn", "nippon"]},
    {"name": "Australia", "iso2": "AU", "iso3": "AUS", "currency": "AUD", "dial": "61", "region": "Oceania", "aliases": ["australia", "au", "aus"]},
    {"name": "Mexico", "iso2": "MX", "iso3": "MEX", "currency": "MXN", "dial": "52", "region": "North America", "aliases": ["mexico", "mx", "mex", "méxico"]},
    {"name": "Brazil", "iso2": "BR", "iso3": "BRA", "currency": "BRL", "dial": "55", "region": "South America", "aliases": ["brazil", "br", "bra", "brasil"]},
    {"name": "China", "iso2": "CN", "iso3": "CHN", "currency": "CNY", "dial": "86", "region": "Asia", "aliases": ["china", "cn", "chn", "prc"]},
    {"name": "Ireland", "iso2": "IE", "iso3": "IRL", "currency": "EUR", "dial": "353", "region": "Europe", "aliases": ["ireland", "ie", "irl", "eire"]},
    {"name": "Switzerland", "iso2": "CH", "iso3": "CHE", "currency": "CHF", "dial": "41", "region": "Europe", "aliases": ["switzerland", "ch", "che", "schweiz", "suisse"]},
]
_COUNTRY_INDEX = {a: c for c in COUNTRIES for a in c["aliases"] + [c["name"].lower(), c["iso2"].lower(), c["iso3"].lower()]}


def country_lookup(value: str | None) -> dict | None:
    if value is None:
        return None
    return _COUNTRY_INDEX.get(re.sub(r"\s+", " ", str(value).strip().lower()))


# ------------------------------------------------------------------ polars expression helpers
def numeric_expr(col: str | pl.Expr) -> pl.Expr:
    e = pl.col(col) if isinstance(col, str) else col
    s = e.cast(pl.Utf8).str.strip_chars()
    neg = s.str.starts_with("(") & s.str.ends_with(")")
    cleaned = s.str.replace_all(NUMERIC_CLEAN_RE, "").str.replace_all(r"[()]", "")
    num = cleaned.cast(pl.Float64, strict=False)
    return pl.when(neg).then(-num).otherwise(num)


def percent_expr(col: str) -> pl.Expr:
    s = pl.col(col).cast(pl.Utf8).str.strip_chars()
    num = numeric_expr(col)
    return pl.when(s.str.ends_with("%")).then(num / 100).when(num > 1).then(num / 100).otherwise(num)


def date_expr(col: str | pl.Expr, formats: list[str] | None = None, day_first: bool = False) -> pl.Expr:
    e = pl.col(col) if isinstance(col, str) else col
    s = e.cast(pl.Utf8).str.strip_chars()
    fmts = list(formats or DATE_FORMATS)
    if day_first and "%d/%m/%Y" in fmts:
        fmts.remove("%d/%m/%Y")
        fmts.insert(1, "%d/%m/%Y")
    attempts = [s.str.to_date(f, strict=False) for f in fmts]
    attempts += [s.str.to_datetime(f, strict=False).dt.date() for f in DATETIME_FORMATS]
    return pl.coalesce(attempts)


def datetime_expr(col: str | pl.Expr) -> pl.Expr:
    e = pl.col(col) if isinstance(col, str) else col
    s = e.cast(pl.Utf8).str.strip_chars()
    attempts = [s.str.to_datetime(f, strict=False, time_zone=None).dt.replace_time_zone(None) if "%z" in f or f.endswith("Z") else s.str.to_datetime(f, strict=False)
                for f in DATETIME_FORMATS]
    attempts += [s.str.to_date(f, strict=False).cast(pl.Datetime) for f in DATE_FORMATS]
    return pl.coalesce(attempts)


def bool_expr(col: str) -> pl.Expr:
    s = pl.col(col).cast(pl.Utf8).str.strip_chars().str.to_lowercase()
    return pl.when(s.is_in(list(TRUE_VALUES))).then(True).when(s.is_in(list(FALSE_VALUES))).then(False).otherwise(None)


def normalize_phone(value: str | None, default_country: str = "US") -> str | None:
    """Normalise to E.164 using simple, explainable national rules."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("00"):
        digits, raw = digits[2:], "+" + digits[2:]
    if raw.startswith("+"):
        return "+" + digits if 8 <= len(digits) <= 15 else None
    country = next((c for c in COUNTRIES if c["iso2"] == default_country.upper()), COUNTRIES[0])
    if country["dial"] == "1":
        if len(digits) == 11 and digits.startswith("1"):
            return "+" + digits
        return "+1" + digits if len(digits) == 10 else None
    if digits.startswith("0"):
        digits = digits[1:]
    return f"+{country['dial']}{digits}" if 6 <= len(digits) <= 12 else None


def pattern_of(value: str) -> str:
    out = []
    for ch in value[:40]:
        if ch.isdigit():
            out.append("9")
        elif ch.isalpha():
            out.append("A" if ch.isupper() else "a")
        else:
            out.append(ch)
    return "".join(out)


# ------------------------------------------------------------------ semantic type detection
_NAME_HINTS = {
    "email": ("email", "e_mail", "mail"),
    "phone": ("phone", "mobile", "tel", "fax", "cell"),
    "date_of_birth": ("birth", "dob", "birthday"),
    "country": ("country", "land1", "nation"),
    "postal_code": ("postal", "zip", "postcode", "pstlz"),
    "address": ("address", "street", "addr", "city", "ort01"),
    "person_name": ("first_name", "firstname", "last_name", "lastname", "full_name", "fullname", "legal_name", "surname", "given_name"),
    "government_id": ("ssn", "social_security", "national_id", "passport", "tax_id", "nin", "sin"),
    "financial": ("iban", "credit_card", "card_number", "account_number", "bank_account", "routing"),
    "currency_amount": ("amount", "revenue", "price", "cost", "salary", "total", "netwr", "budget", "value"),
    "percentage": ("pct", "percent", "rate", "discount", "probability"),
    "identifier": ("_id", "id", "key", "code", "number", "vin", "sys_id", "uuid"),
}

PII_CATEGORIES = {
    "email": ("Email address", "high"), "phone": ("Phone number", "high"), "date_of_birth": ("Date of birth", "high"),
    "address": ("Address / location", "medium"), "postal_code": ("Postal code", "medium"), "person_name": ("Person name", "medium"),
    "government_id": ("Government identifier", "critical"), "financial": ("Financial information", "critical"),
}


def _name_hint(name: str) -> list[str]:
    n = name.lower().replace(" ", "_").replace("-", "_")
    hits = []
    for sem, keys in _NAME_HINTS.items():
        for k in keys:
            if sem == "identifier":
                if n == "id" or n.endswith("_id") or n.endswith("id") and len(n) <= 12 or n in ("vin", "kunnr", "vbeln", "matnr", "sys_id", "number") or n.endswith("_code") or n.endswith("_key"):
                    hits.append(sem)
                    break
            elif k in n:
                hits.append(sem)
                break
    return hits


def detect_semantic(name: str, s: pl.Series) -> tuple[str, float, dict]:
    """Return (semantic_type, confidence, facts) for a column."""
    facts: dict[str, Any] = {}
    if s.dtype in (pl.Struct,) or isinstance(s.dtype, (pl.Struct, pl.List)):
        return ("nested", 1.0, facts)
    if s.dtype.is_numeric():
        hints = _name_hint(name)
        if "identifier" in hints:
            return ("identifier", 0.8, facts)
        return ("decimal" if s.dtype.is_float() else "integer", 0.99, facts)
    if s.dtype == pl.Boolean:
        return ("boolean", 1.0, facts)
    if s.dtype in (pl.Date,):
        return ("date", 1.0, facts)
    if s.dtype in (pl.Datetime,) or isinstance(s.dtype, pl.Datetime):
        return ("timestamp", 1.0, facts)

    vals = s.drop_nulls().cast(pl.Utf8).str.strip_chars()
    vals = vals.filter(vals != "")
    if vals.len() == 0:
        return ("empty", 1.0, facts)
    sample = vals.head(5000)
    n = sample.len()
    frame = pl.DataFrame({"v": sample})

    def ratio(expr: pl.Expr) -> float:
        return float(frame.select(expr.mean()).item() or 0.0)

    hints = _name_hint(name)
    email_r = ratio(pl.col("v").str.contains(EMAIL_RE))
    at_r = ratio(pl.col("v").str.contains("@"))
    lower = sample.str.to_lowercase()
    bool_r = float(lower.is_in(list(TRUE_VALUES | FALSE_VALUES)).mean() or 0)
    num = frame.select(numeric_expr("v")).to_series()
    num_r = float(num.is_not_null().mean() or 0)
    has_currency_sym = ratio(pl.col("v").str.contains(r"[$€£¥]"))
    has_pct = ratio(pl.col("v").str.ends_with("%"))
    date_r = float(frame.select(date_expr("v")).to_series().is_not_null().mean() or 0)
    ts_r = ratio(pl.col("v").str.contains(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}"))
    digits_only = ratio(pl.col("v").str.contains(r"^\+?[\d\s().\-]{7,20}$"))
    country_r = float(pl.Series([country_lookup(v) is not None for v in sample.unique().to_list()]).mean() or 0) if sample.n_unique() <= 300 else 0.0
    facts.update(email_ratio=email_r, numeric_ratio=num_r, date_ratio=date_r, bool_ratio=bool_r)

    if "email" in hints or at_r > 0.6:
        return ("email", max(email_r, 0.85 if "email" in hints else at_r), facts)
    if "phone" in hints and (digits_only > 0.5 or num_r < 0.95):
        return ("phone", 0.9, facts)
    if "country" in hints or country_r > 0.85:
        return ("country", max(country_r, 0.8), facts)
    if "date_of_birth" in hints and date_r > 0.5:
        return ("date_of_birth", 0.95, facts)
    if ts_r > 0.8:
        return ("timestamp", ts_r, facts)
    if date_r > 0.8 and num_r < 0.5:
        return ("date", date_r, facts)
    if bool_r > 0.95 and sample.n_unique() <= 8:
        return ("boolean", bool_r, facts)
    if "postal_code" in hints:
        return ("postal_code", 0.85, facts)
    if "identifier" in hints and not (has_currency_sym > 0.05):
        return ("identifier", 0.85, facts)
    if num_r > 0.9:
        if has_pct > 0.02 or "percentage" in hints:
            return ("percentage", max(num_r, 0.8), facts)
        if has_currency_sym > 0.02 or "currency_amount" in hints:
            return ("currency", max(num_r, 0.8), facts)
        is_int = bool(((num.drop_nulls() % 1) == 0).all())
        return ("integer" if is_int else "decimal", num_r, facts)
    if "person_name" in hints:
        return ("person_name", 0.85, facts)
    if "address" in hints:
        return ("address", 0.75, facts)
    if "government_id" in hints or ratio(pl.col("v").str.contains(SSN_RE)) > 0.8:
        return ("government_id", 0.9, facts)
    if "financial" in hints or ratio(pl.col("v").str.contains(IBAN_RE)) > 0.8:
        return ("financial", 0.85, facts)
    if ratio(pl.col("v").str.contains(URL_RE)) > 0.8:
        return ("url", 0.9, facts)
    uniq = sample.n_unique()
    if uniq <= max(20, n * 0.05):
        return ("category", 0.8, facts)
    avg_len = float(sample.str.len_chars().mean() or 0)
    return ("free_text" if avg_len > 40 else "text", 0.6, facts)


def pii_for(name: str, semantic: str) -> dict | None:
    key = semantic if semantic in PII_CATEGORIES else next((h for h in _name_hint(name) if h in PII_CATEGORIES), None)
    if not key:
        return None
    label, sensitivity = PII_CATEGORIES[key]
    return {"category": key, "label": label, "sensitivity": sensitivity, "confidence": 0.95 if semantic == key else 0.7}


def validity_expr(col: str, semantic: str) -> pl.Expr | None:
    """Boolean expr: True when a non-null value is valid for the semantic type."""
    v = pl.col(col).cast(pl.Utf8).str.strip_chars()
    if semantic == "email":
        return v.str.contains(EMAIL_RE)
    if semantic in ("date", "date_of_birth"):
        return date_expr(col).is_not_null()
    if semantic == "timestamp":
        return datetime_expr(col).is_not_null()
    if semantic in ("integer", "decimal", "currency", "percentage"):
        return numeric_expr(col).is_not_null()
    if semantic == "boolean":
        return v.str.to_lowercase().is_in(list(TRUE_VALUES | FALSE_VALUES))
    if semantic == "country":
        return v.map_elements(lambda x: country_lookup(x) is not None, return_dtype=pl.Boolean)
    if semantic == "phone":
        return v.str.replace_all(r"\D", "").str.len_chars().is_between(7, 15)
    return None
