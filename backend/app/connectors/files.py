"""Universal file detection and reading.

Detects file type, format, encoding, compression, structure, sheets, nested structures, row/column counts,
and reads any supported entry (CSV/TXT, Excel sheet, JSON records, XML records, Parquet, Avro, ZIP member)
into a Polars DataFrame. Raw values are kept as strings (Bronze-style); typing is a governed transformation.
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

import polars as pl

SUPPORTED_FORMATS = {
    "csv": "CSV", "txt": "Text (delimited)", "tsv": "TSV", "xlsx": "Excel", "xlsm": "Excel", "xls": "Excel (legacy)",
    "json": "JSON", "ndjson": "JSON Lines", "jsonl": "JSON Lines", "xml": "XML", "parquet": "Parquet",
    "avro": "Avro", "zip": "ZIP archive", "gz": "GZIP",
}

MAX_DETECT_ROWS = 2_000_000


def _members_dir(path: Path) -> Path:
    """Where ZIP members are extracted: a cache in object storage, never next to the source file."""
    import hashlib

    from ..core.config import get_settings

    st = path.stat()
    key = hashlib.sha1(f"{path.resolve()}:{st.st_size}:{st.st_mtime_ns}".encode()).hexdigest()[:16]
    return get_settings().storage_root / "zip_cache" / key


def _ext(name: str) -> str:
    name = name.lower()
    if name.endswith(".gz"):
        inner = name[:-3]
        return inner.rsplit(".", 1)[-1] if "." in inner else "gz"
    return name.rsplit(".", 1)[-1] if "." in name else ""


def _sniff_format(path: Path) -> str:
    head = path.open("rb").read(2048)
    if head.startswith(b"PK"):
        return "zip"
    if head.startswith(b"PAR1"):
        return "parquet"
    if head.startswith(b"Obj\x01"):
        return "avro"
    text = head.lstrip(b"\xef\xbb\xbf").lstrip()
    if text.startswith((b"{", b"[")):
        return "json"
    if text.startswith(b"<"):
        return "xml"
    return "csv"


def detect_encoding(raw: bytes) -> str:
    if raw.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return "utf-16"
    try:
        raw.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        return "latin-1"


def _open_bytes(path: Path, compression: str | None) -> bytes:
    if compression == "gzip":
        with gzip.open(path, "rb") as fh:
            return fh.read()
    return path.read_bytes()


# ------------------------------------------------------------------ nested record helpers
def _stringify(value: Any) -> Any:
    """Normalise leaves to strings, preserving nested dict/list structure."""
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(k): _stringify(v) for k, v in value.items()}
    if isinstance(value, list):
        items = [_stringify(v) for v in value]
        if items and all(isinstance(i, dict) for i in items):
            return items
        return [i if isinstance(i, (dict, list)) or i is None else str(i) for i in items]
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _unify_records(records: list[dict]) -> list[dict]:
    """Make nested dict keys consistent so Polars infers a single struct schema."""
    def merge_shape(shape: dict, value: Any) -> Any:
        if isinstance(value, dict):
            s = shape if isinstance(shape, dict) else {}
            for k, v in value.items():
                s[k] = merge_shape(s.get(k), v)
            return s
        if isinstance(value, list) and value and isinstance(value[0], dict):
            s = shape if isinstance(shape, list) else [{}]
            for item in value:
                s[0] = merge_shape(s[0], item)
            return s
        if isinstance(value, list):
            return shape if isinstance(shape, list) else ["__scalar_list__"]
        return shape if shape is not None else "__scalar__"

    shape: dict = {}
    for r in records:
        shape = merge_shape(shape, r)

    def conform(value: Any, sh: Any) -> Any:
        if isinstance(sh, dict):
            value = value if isinstance(value, dict) else {}
            return {k: conform(value.get(k), sub) for k, sub in sh.items()}
        if isinstance(sh, list) and sh and isinstance(sh[0], dict):
            if not isinstance(value, list):
                return None
            return [conform(v, sh[0]) for v in value]
        if isinstance(sh, list):
            if value is None or isinstance(value, list):
                return value
            return [value if not isinstance(value, dict) else json.dumps(value)]
        if isinstance(value, (dict, list)):
            return json.dumps(value)
        return value

    return [conform(r, shape) for r in records]


def records_to_frame(records: list[dict]) -> pl.DataFrame:
    if not records:
        return pl.DataFrame()
    recs = _unify_records([_stringify(r) if isinstance(r, dict) else {"value": _stringify(r)} for r in records])
    return pl.DataFrame(recs, infer_schema_length=None)


def _has_nested(records: list[dict]) -> bool:
    return any(isinstance(v, (dict, list)) for r in records[:200] if isinstance(r, dict) for v in r.values())


# ------------------------------------------------------------------ JSON
def _json_entities(data: Any) -> list[tuple[str, list[dict]]]:
    if isinstance(data, list):
        return [("records", [d if isinstance(d, dict) else {"value": d} for d in data])]
    if isinstance(data, dict):
        lists = [(k, v) for k, v in data.items() if isinstance(v, list) and v and isinstance(v[0], dict)]
        if lists:
            return [(k, v) for k, v in lists]
        return [("record", [data])]
    return [("value", [{"value": data}])]


def _load_json(raw: bytes, encoding: str) -> tuple[Any, bool]:
    text = raw.decode(encoding, errors="replace").strip()
    try:
        return json.loads(text), False
    except json.JSONDecodeError:
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]
        return rows, True


# ------------------------------------------------------------------ XML
def _xml_to_value(el) -> Any:
    children = list(el)
    attrs = {f"{k.split('}')[-1]}": v for k, v in el.attrib.items()}
    text = (el.text or "").strip()
    if not children:
        if attrs:
            d = dict(attrs)
            if text:
                d["value"] = text
            return d
        return text or None
    out: dict[str, Any] = dict(attrs)
    counts = Counter(c.tag.split("}")[-1] for c in children if isinstance(c.tag, str))
    for c in children:
        if not isinstance(c.tag, str):
            continue
        tag = c.tag.split("}")[-1]
        val = _xml_to_value(c)
        if counts[tag] > 1:
            out.setdefault(tag, []).append(val)
        else:
            out[tag] = val
    return out


def _xml_record_element(root) -> tuple[str, list]:
    """Find the repeating element that represents a record."""
    best_tag, best_elems = None, []
    for parent in root.iter():
        kids = [c for c in parent if isinstance(c.tag, str)]
        counts = Counter(c.tag for c in kids)
        for tag, n in counts.items():
            if n > len(best_elems):
                best_tag, best_elems = tag, [c for c in kids if c.tag == tag]
    if not best_elems:
        return root.tag.split("}")[-1], [root]
    return best_tag.split("}")[-1], best_elems


def _xml_records(raw: bytes) -> tuple[str, list[dict]]:
    from lxml import etree

    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True, recover=True)
    root = etree.fromstring(raw, parser=parser)
    tag, elems = _xml_record_element(root)
    recs = []
    for e in elems:
        v = _xml_to_value(e)
        recs.append(v if isinstance(v, dict) else {tag: v})
    return tag, recs


# ------------------------------------------------------------------ CSV
def _csv_dialect(sample: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


def _read_csv(raw: bytes, encoding: str, delimiter: str, limit: int | None) -> pl.DataFrame:
    text = raw.decode(encoding, errors="replace")
    return pl.read_csv(
        io.StringIO(text), separator=delimiter, infer_schema=False, n_rows=limit, truncate_ragged_lines=True,
        ignore_errors=True, quote_char='"',
    )


# ------------------------------------------------------------------ Excel
def _excel_sheets(path: Path) -> list[dict]:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    sheets = []
    for ws in wb.worksheets:
        header = None
        for row in ws.iter_rows(min_row=1, max_row=5, values_only=True):
            if any(v is not None for v in row):
                header = [str(v) if v is not None else None for v in row]
                break
        cols = [h for h in (header or []) if h]
        rows = max((ws.max_row or 1) - 1, 0)
        sheets.append({"name": ws.title, "rows": rows, "columns": cols})
    wb.close()
    return sheets


def _read_excel(path: Path, sheet: str, limit: int | None) -> pl.DataFrame:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet]
    rows_iter = ws.iter_rows(values_only=True)
    header: list[str] | None = None
    for row in rows_iter:
        if any(v is not None for v in row):
            header = []
            seen: Counter = Counter()
            for i, v in enumerate(row):
                name = str(v).strip() if v is not None else f"column_{i + 1}"
                seen[name] += 1
                header.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
            break
    if header is None:
        wb.close()
        return pl.DataFrame()
    data: dict[str, list] = {h: [] for h in header}
    n = 0
    for row in rows_iter:
        if limit is not None and n >= limit:
            break
        if not any(v is not None for v in row):
            continue
        for i, h in enumerate(header):
            v = row[i] if i < len(row) else None
            if v is None:
                data[h].append(None)
            elif hasattr(v, "isoformat"):
                data[h].append(v.isoformat().replace("T00:00:00", ""))
            elif isinstance(v, float) and v.is_integer():
                data[h].append(str(int(v)))
            else:
                data[h].append(str(v))
        n += 1
    wb.close()
    return pl.DataFrame(data, schema={h: pl.Utf8 for h in header})


# ------------------------------------------------------------------ public API
def _entry(name: str, kind: str, locator: dict, fmt: str, df: pl.DataFrame | None = None, *, rows: int | None = None,
           columns: list[str] | None = None, nested: bool = False, size: int | None = None) -> dict:
    cols = columns if columns is not None else (df.columns if df is not None else [])
    return {
        "name": name, "kind": kind, "locator": locator, "format": fmt,
        "row_count": rows if rows is not None else (df.height if df is not None else None),
        "column_count": len(cols), "columns": cols, "nested": nested, "size_bytes": size,
    }


def detect_file(path: Path, filename: str) -> dict:
    """Inspect a file and describe everything inside it."""
    size = path.stat().st_size
    ext = _ext(filename)
    compression = "gzip" if filename.lower().endswith(".gz") else None
    fmt = ext if ext in SUPPORTED_FORMATS and ext != "gz" else _sniff_format(path)
    if fmt in ("jsonl", "ndjson"):
        fmt = "json"
    if fmt == "tsv":
        fmt = "csv"
    result: dict[str, Any] = {
        "filename": filename, "size_bytes": size, "format": fmt, "format_label": SUPPORTED_FORMATS.get(fmt, fmt.upper()),
        "compression": compression, "encoding": None, "structure": "tabular", "entries": [], "summary": [],
    }

    if fmt == "zip":
        result["structure"] = "archive"
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if info.is_dir() or info.filename.startswith("__MACOSX") or info.filename.split("/")[-1].startswith("."):
                    continue
                if info.filename.startswith(("/", "\\")) or ".." in Path(info.filename).parts:
                    continue  # never extract outside the cache directory (zip-slip)
                member_ext = _ext(info.filename)
                if member_ext not in SUPPORTED_FORMATS or member_ext == "zip":
                    result["entries"].append({"name": info.filename, "kind": "zip_member", "format": member_ext or "unknown",
                                              "supported": False, "size_bytes": info.file_size, "locator": {"member": info.filename}})
                    continue
                extracted = _members_dir(path) / info.filename
                extracted.parent.mkdir(parents=True, exist_ok=True)
                if not extracted.exists():
                    with zf.open(info) as src, extracted.open("wb") as dst:
                        dst.write(src.read())
                inner = detect_file(extracted, info.filename)
                for e in inner["entries"]:
                    e["name"] = f"{info.filename}" + (f" › {e['name']}" if len(inner["entries"]) > 1 else "")
                    e["locator"] = {"member": info.filename, **e["locator"]}
                    e["kind"] = "zip_member"
                    e["supported"] = True
                    e.setdefault("size_bytes", info.file_size)
                    result["entries"].append(e)
        n_ok = sum(1 for e in result["entries"] if e.get("supported", True))
        result["summary"] = [f"ZIP archive detected.", f"{len(result['entries'])} files found, {n_ok} can be processed."]
        return result

    if fmt in ("xlsx", "xlsm", "xls"):
        sheets = _excel_sheets(path)
        result["structure"] = "workbook"
        for s in sheets:
            result["entries"].append(_entry(s["name"], "sheet", {"sheet": s["name"]}, "xlsx", rows=s["rows"], columns=s["columns"]))
        total = sum(s["rows"] for s in sheets)
        result["summary"] = ["Excel file detected.", f"{len(sheets)} sheet{'s' if len(sheets) != 1 else ''} found.",
                             f"{total:,} records detected."]
        return result

    if fmt == "parquet":
        import pyarrow.parquet as pq

        pf = pq.ParquetFile(path)
        cols = pf.schema_arrow.names
        nested = any(str(t).startswith(("struct", "list")) for t in pf.schema_arrow.types)
        result["entries"].append(_entry(filename, "file", {}, "parquet", rows=pf.metadata.num_rows, columns=cols, nested=nested))
        result["compression"] = pf.metadata.row_group(0).column(0).compression.lower() if pf.metadata.num_row_groups else None
        result["summary"] = ["Parquet file detected.", f"{pf.metadata.num_rows:,} records, {len(cols)} columns."]
        return result

    if fmt == "avro":
        df = pl.read_avro(path)
        result["entries"].append(_entry(filename, "file", {}, "avro", df))
        result["summary"] = ["Avro file detected.", f"{df.height:,} records, {df.width} columns."]
        return result

    raw = _open_bytes(path, compression)
    encoding = detect_encoding(raw[:65536])
    result["encoding"] = encoding

    if fmt == "json":
        data, is_lines = _load_json(raw, encoding)
        result["structure"] = "json_lines" if is_lines else "json_document"
        for name, recs in _json_entities(data):
            nested = _has_nested(recs)
            df = records_to_frame(recs[:500])
            result["entries"].append(_entry(name, "json_records", {"path": name}, "json", rows=len(recs), columns=df.columns, nested=nested))
        total = sum(e["row_count"] or 0 for e in result["entries"])
        nested_any = any(e["nested"] for e in result["entries"])
        result["summary"] = ["JSON file detected.", f"{total:,} records detected."] + (["Nested structures found — can be flattened automatically."] if nested_any else [])
        return result

    if fmt == "xml":
        tag, recs = _xml_records(raw)
        nested = _has_nested(recs)
        df = records_to_frame(recs[:500])
        result["structure"] = "xml"
        result["entries"].append(_entry(tag, "xml_records", {"record_tag": tag}, "xml", rows=len(recs), columns=df.columns, nested=nested))
        result["summary"] = ["XML file detected.", f"Repeating element <{tag}> identified as the record.", f"{len(recs):,} records detected."] + (
            ["Nested XML elements found — can be flattened automatically."] if nested else [])
        return result

    # delimited text
    sample = raw[:65536].decode(encoding, errors="replace")
    delimiter = _csv_dialect(sample)
    df = _read_csv(raw, encoding, delimiter, 200)
    rows = max(raw.count(b"\n") - 1 + (0 if raw.endswith(b"\n") else 1), 0)
    result["structure"] = "delimited"
    result["delimiter"] = delimiter
    label = {",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe"}.get(delimiter, delimiter)
    result["entries"].append(_entry(filename, "file", {"delimiter": delimiter, "encoding": encoding}, "csv", rows=rows, columns=df.columns))
    result["summary"] = [f"{'CSV' if fmt == 'csv' else 'Delimited text'} file detected ({label}-separated, {encoding}).",
                         f"{rows:,} records, {df.width} columns."]
    return result


def read_file_entry(path: Path, filename: str, locator: dict, limit: int | None = None) -> pl.DataFrame:
    """Read one detected entry into a DataFrame."""
    if "member" in locator:
        member_path = _members_dir(path) / locator["member"]
        if not member_path.exists():
            detect_file(path, filename)
        sub = {k: v for k, v in locator.items() if k != "member"}
        return read_file_entry(member_path, locator["member"], sub, limit)

    ext = _ext(filename)
    compression = "gzip" if filename.lower().endswith(".gz") else None
    fmt = ext if ext in SUPPORTED_FORMATS and ext != "gz" else _sniff_format(path)
    if fmt in ("xlsx", "xlsm", "xls"):
        return _read_excel(path, locator.get("sheet") or _excel_sheets(path)[0]["name"], limit)
    if fmt == "parquet":
        df = pl.read_parquet(path, n_rows=limit)
        return df
    if fmt == "avro":
        df = pl.read_avro(path)
        return df.head(limit) if limit else df
    raw = _open_bytes(path, compression)
    encoding = locator.get("encoding") or detect_encoding(raw[:65536])
    if fmt in ("json", "jsonl", "ndjson"):
        data, _ = _load_json(raw, encoding)
        entities = dict(_json_entities(data))
        recs = entities.get(locator.get("path")) or next(iter(entities.values()))
        return records_to_frame(recs[:limit] if limit else recs)
    if fmt == "xml":
        _, recs = _xml_records(raw)
        return records_to_frame(recs[:limit] if limit else recs)
    delimiter = locator.get("delimiter") or _csv_dialect(raw[:65536].decode(encoding, errors="replace"))
    return _read_csv(raw, encoding, delimiter, limit)
