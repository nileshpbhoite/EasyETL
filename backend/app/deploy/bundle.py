"""Pipeline generator: validated metadata → Databricks Asset/Automation Bundle.

Generated artifacts (never shown to business users; available to engineers under "Show technical details"):
  databricks.yml                          bundle definition + targets (dev/staging/prod)
  resources/<name>.pipeline.yml           Lakeflow Declarative Pipeline (serverless, Unity Catalog)
  resources/<name>.job.yml                orchestration job + schedule + retries + notifications
  src/easyetl_pipeline.py                 fixed pipeline entrypoint that interprets the metadata
  src/easyetl_runtime.py                  EasyETL transformation runtime (Spark)
  config/pipeline_spec.json               the validated metadata spec
  governance/unity_catalog.sql            catalog/schemas, grants, tags and column masks
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..engine.metadata import PipelineMetadata
from ..transforms.library import to_snake

RUNTIME_SRC = Path(__file__).parent / "runtime" / "easyetl_runtime.py"

CRON = {"every_15_min": "0 0/15 * * * ?", "hourly": "0 0 * * * ?", "weekly": "0 0 2 ? * MON"}


def slug(meta: PipelineMetadata) -> str:
    return to_snake(meta.name)[:40] or "easyetl_pipeline"


def _cron(meta: PipelineMetadata) -> str | None:
    ing = meta.ingestion
    if ing.frequency in ("manual", "continuous"):
        return None
    if ing.frequency == "daily":
        hh, mm = (ing.schedule_time or "02:00").split(":")
        return f"0 {int(mm)} {int(hh)} * * ?"
    return CRON[ing.frequency]


def _yaml(obj, indent: int = 0) -> str:
    """Tiny YAML emitter (dicts/lists/scalars) to avoid a dependency."""
    pad = "  " * indent
    lines = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{k}:")
                lines.append(_yaml(v, indent + 1))
            else:
                lines.append(f"{pad}{k}: {_scalar(v)}")
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, dict):
                first = True
                for k, v in item.items():
                    prefix = f"{pad}- " if first else f"{pad}  "
                    first = False
                    if isinstance(v, (dict, list)) and v:
                        lines.append(f"{prefix}{k}:")
                        lines.append(_yaml(v, indent + 2))
                    else:
                        lines.append(f"{prefix}{k}: {_scalar(v)}")
            else:
                lines.append(f"{pad}- {_scalar(item)}")
    return "\n".join(lines)


def _scalar(v) -> str:
    if v is None or v == {} or v == []:
        return "null" if v is None else ("{}" if v == {} else "[]")
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    return json.dumps(s) if re.search(r"[:#{}\[\],&*?|<>=!%@`'\"]|^\s|\s$", s) or s == "" else s


def pipeline_entrypoint() -> str:
    return '''"""EasyETL generated pipeline entrypoint — interprets config/pipeline_spec.json. Do not edit; regenerate from EasyETL."""
import json
import dlt
from pyspark.sql import functions as F

import easyetl_runtime as rt

spark = rt.get_spark()
SPEC = rt.load_spec(spark.conf.get("easyetl.spec_path"))
LH = SPEC["lakehouse"]
ING = SPEC["ingestion"]
DATASETS = {d["id"]: d for d in SPEC["source"]["datasets"]}


def _bronze_reader(ds):
    src = SPEC["source"]
    landing = spark.conf.get("easyetl.landing_path")
    fmt = {"xlsx": "binaryFile", "csv": "csv", "json": "json", "xml": "xml", "parquet": "parquet", "avro": "avro"}.get(ds.get("format"), "csv")
    if ING["engine"] == "auto_loader" and src["category"] in ("file", "cloud_storage"):
        reader = (spark.readStream.format("cloudFiles")
                  .option("cloudFiles.format", fmt)
                  .option("cloudFiles.schemaEvolutionMode", {"add_new_columns": "addNewColumns", "rescue": "rescue", "fail_on_change": "failOnNewColumns", "none": "none"}[ING["schema_evolution"]])
                  .option("cloudFiles.inferColumnTypes", "false")
                  .option("header", "true"))
        if fmt == "xml":
            reader = reader.option("rowTag", ds["locator"].get("record_tag", "record"))
        return reader.load(f"{landing}/{ds['id']}/")
    if ING["engine"] in ("jdbc",):
        return (spark.read.format("jdbc").option("url", spark.conf.get("easyetl.jdbc_url"))
                .option("dbtable", ds["locator"].get("table")).option("user", spark.conf.get("easyetl.jdbc_user"))
                .option("password", spark.conf.get("easyetl.jdbc_password")).load())
    # Lakeflow Connect / REST ingestion land raw data into a staging table managed by the ingestion job
    return spark.readStream.table(f"{LH['catalog']}.{LH['bronze_schema']}.__staging_{ds['id']}")


def _make_bronze(table, ds):
    @dlt.table(name=f"{LH['catalog']}.{LH['bronze_schema']}.{table['name']}", comment=table.get("description"),
               table_properties={"quality": "bronze", "easyetl.dataset": ds["id"]})
    def bronze():
        return _bronze_reader(ds).withColumn("_ingested_at", F.current_timestamp()).withColumn("_source_file", F.col("_metadata.file_path") if ING["engine"] == "auto_loader" else F.lit(None))


def _load_silver_input(dataset_id):
    t = next(t for t in LH["tables"] if t["layer"] == "bronze" and dataset_id in t["source_datasets"])
    return spark.read.table(f"{LH['catalog']}.{LH['bronze_schema']}.{t['name']}")


def _make_silver(table, ds_id):
    exp = rt.expectations(SPEC, ds_id)

    @dlt.table(name=f"{LH['catalog']}.{LH['silver_schema']}.{table['name']}", comment=table.get("description"),
               cluster_by=table.get("cluster_by") or None, table_properties={"quality": "silver"})
    @dlt.expect_all(exp["warn"])
    @dlt.expect_all_or_drop(exp["drop"])
    @dlt.expect_all_or_fail(exp["fail"])
    def silver():
        df = _load_silver_input(ds_id)
        return rt.apply_steps(df, SPEC["transformations"], ds_id, _load_silver_input)


def _make_gold(table):
    logic = table.get("gold_logic") or {}

    @dlt.table(name=f"{LH['catalog']}.{LH['gold_schema']}.{table['name']}", comment=table.get("description"), table_properties={"quality": "gold"})
    def gold():
        base = spark.read.table(f"{LH['catalog']}.{LH['silver_schema']}.{logic['base']}")
        if logic.get("type") == "entity_360":
            key = logic["key"][0]
            out = base
            for rel in logic.get("related", []):
                other = spark.read.table(f"{LH['catalog']}.{LH['silver_schema']}.{rel['table']}")
                fk = next((c for c in other.columns if c.lower().endswith(key.lower()) or c.lower() == key.lower()), None)
                if fk:
                    agg = other.groupBy(fk).agg(F.count("*").alias(f"{rel['table']}_count"))
                    out = out.join(agg, out[key] == agg[fk], "left").drop(fk)
            return out
        if logic.get("type") == "time_summary":
            date_col = next((f.name for f in base.schema.fields if f.dataType.typeName() == "date"), None)
            grain = F.date_trunc(logic.get("grain", "day"), F.col(date_col)) if date_col else F.lit(None)
            return base.groupBy(grain.alias("period")).agg(F.count("*").alias("records"))
        return base.groupBy(*base.columns[:1]).count()


for t in LH["tables"]:
    if not t.get("enabled", True):
        continue
    if t["layer"] == "bronze":
        _make_bronze(t, DATASETS[t["source_datasets"][0]])
    elif t["layer"] == "silver":
        _make_silver(t, t["source_datasets"][0])
    else:
        _make_gold(t)
'''


def governance_sql(meta: PipelineMetadata) -> str:
    lh, gov = meta.lakehouse, meta.governance
    lines = [f"-- Generated by EasyETL for pipeline '{meta.name}'", f"CREATE CATALOG IF NOT EXISTS {lh.catalog};"]
    for schema in (lh.bronze_schema, lh.silver_schema, lh.gold_schema):
        lines.append(f"CREATE SCHEMA IF NOT EXISTS {lh.catalog}.{schema};")
    for k, v in gov.tags.items():
        lines.append(f"ALTER CATALOG {lh.catalog} SET TAGS ('{k}' = '{v}');")
    layer_schema = {"bronze": lh.bronze_schema, "silver": lh.silver_schema, "gold": lh.gold_schema}
    for p in gov.access_policies:
        target = f"CATALOG {lh.catalog}" if p.scope == "all" else f"SCHEMA {lh.catalog}.{layer_schema.get(p.scope, p.scope)}"
        priv = {"ALL_PRIVILEGES": "ALL PRIVILEGES", "USE_SCHEMA": "USE SCHEMA"}.get(p.privilege, p.privilege)
        lines.append(f"GRANT {priv} ON {target} TO `{p.group}`;")
    if gov.column_masks and any(p.action in ("mask", "hash", "tokenize", "encrypt") for p in gov.pii):
        lines.append(f"CREATE FUNCTION IF NOT EXISTS {lh.catalog}.{lh.silver_schema}.easyetl_mask(v STRING) RETURNS STRING "
                     "RETURN CASE WHEN is_account_group_member('pii_readers') THEN v ELSE concat(repeat('•', greatest(length(v) - 4, 0)), right(v, 4)) END;")
    silver_by_ds = {ds: t for t in lh.tables if t.layer == "silver" for ds in t.source_datasets}
    for p in gov.pii:
        t = silver_by_ds.get(p.dataset_id)
        if not t:
            continue
        col = meta.resolve_column(p.dataset_id, p.column)
        fq = f"{lh.catalog}.{lh.silver_schema}.{t.name}"
        lines.append(f"ALTER TABLE {fq} ALTER COLUMN `{col}` SET TAGS ('pii' = '{p.category}');")
        if p.action in ("mask", "hash", "tokenize", "encrypt") and gov.column_masks:
            lines.append(f"ALTER TABLE {fq} ALTER COLUMN `{col}` SET MASK {lh.catalog}.{lh.silver_schema}.easyetl_mask;")
    return "\n".join(lines) + "\n"


def build_bundle(meta: PipelineMetadata, target: str = "development") -> dict[str, str]:
    name = slug(meta)
    spec = meta.export_spec()
    lh = meta.lakehouse
    target_key = {"development": "dev", "staging": "staging", "production": "prod"}.get(target, "dev")
    bundle = {
        "bundle": {"name": name},
        "include": ["resources/*.yml"],
        "targets": {
            "dev": {"mode": "development", "default": target_key == "dev"},
            "staging": {"mode": "production", "default": target_key == "staging"},
            "prod": {"mode": "production", "default": target_key == "prod"},
        },
    }
    pipeline = {"resources": {"pipelines": {name: {
        "name": f"[EasyETL] {meta.name}",
        "catalog": lh.catalog,
        "schema": lh.silver_schema,
        "serverless": meta.ingestion.compute == "serverless",
        "continuous": meta.ingestion.frequency == "continuous",
        "channel": "CURRENT",
        "photon": True,
        "libraries": [{"file": {"path": "../src/easyetl_pipeline.py"}}],
        "configuration": {
            "easyetl.spec_path": "${workspace.file_path}/config/pipeline_spec.json",
            "easyetl.landing_path": f"/Volumes/{lh.catalog}/{lh.bronze_schema}/landing/{name}",
            "easyetl.hash_salt": "{{secrets/easyetl/hash_salt}}",
            "easyetl.aes_key": "{{secrets/easyetl/aes_key}}",
        },
    }}}}
    cron = _cron(meta)
    job = {"resources": {"jobs": {f"{name}_job": {
        "name": f"[EasyETL] {meta.name} — orchestration",
        "max_concurrent_runs": 1,
        "tasks": [{"task_key": "refresh_pipeline", "pipeline_task": {"pipeline_id": f"${{resources.pipelines.{name}.id}}", "full_refresh": meta.ingestion.mode == "full"},
                   "max_retries": meta.ingestion.retries, "min_retry_interval_millis": meta.ingestion.retry_delay_minutes * 60_000}],
        **({"schedule": {"quartz_cron_expression": cron, "timezone_id": "UTC", "pause_status": "UNPAUSED"}} if cron else {}),
        "email_notifications": {"on_failure": [meta.governance.data_owner] if meta.governance.data_owner else []},
        "tags": {"managed_by": "easyetl", **{k: str(v) for k, v in meta.governance.tags.items()}},
    }}}}
    return {
        "databricks.yml": _yaml(bundle) + "\n",
        f"resources/{name}.pipeline.yml": _yaml(pipeline) + "\n",
        f"resources/{name}.job.yml": _yaml(job) + "\n",
        "src/easyetl_pipeline.py": pipeline_entrypoint(),
        "src/easyetl_runtime.py": RUNTIME_SRC.read_text(),
        "config/pipeline_spec.json": json.dumps(spec, indent=2, default=str),
        "governance/unity_catalog.sql": governance_sql(meta),
    }
