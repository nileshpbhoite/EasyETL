"""EasyETL target publishing for Databricks jobs.

After each pipeline update, the `publish` job task copies curated Silver/Gold tables to the extra targets
configured in EasyETL (databases, warehouses, other Unity Catalog locations, cloud storage, Kafka, NoSQL
stores, REST APIs, Salesforce). Credentials come from the Databricks secret scope `easyetl`
(key: `<connection_id>-<field>`), written by EasyETL at deploy time.

The SQL/URL helpers at the top are plain Python (unit-tested in EasyETL); Spark is only imported by the writers.
"""
from __future__ import annotations

import base64
import json
from typing import Any, Callable

JDBC_FAMILY = {"sqlserver", "azure_sql", "synapse", "postgresql", "cockroachdb", "redshift", "mysql", "mariadb", "oracle", "db2",
               "teradata", "sap_hana", "sybase", "jdbc"}
STORAGE_FAMILY = {"s3", "adls", "azure_blob", "gcs", "onelake"}
KAFKA_FAMILY = {"kafka", "confluent", "event_hubs"}
DQ_COLUMNS = ["_dq_issues", "_dq_action", "_dq_status"]


# ------------------------------------------------------------------ pure helpers
def jdbc_url(connector: str, cfg: dict[str, Any]) -> str:
    host, db = cfg.get("host", ""), cfg.get("database", "")
    port = cfg.get("port")
    if connector == "jdbc":
        return cfg["connection_url"]
    if connector in ("sqlserver", "azure_sql", "synapse"):
        return f"jdbc:sqlserver://{host}:{port or 1433};databaseName={db};encrypt=true;trustServerCertificate=false"
    if connector in ("postgresql", "cockroachdb"):
        return f"jdbc:postgresql://{host}:{port or (26257 if connector == 'cockroachdb' else 5432)}/{db}" + ("?sslmode=require" if cfg.get("ssl", True) else "")
    if connector == "redshift":
        return f"jdbc:redshift://{host}:{port or 5439}/{db}"
    if connector in ("mysql", "mariadb"):
        return f"jdbc:{connector}://{host}:{port or 3306}/{db}"
    if connector == "oracle":
        return f"jdbc:oracle:thin:@//{host}:{port or 1521}/{db}"
    if connector == "db2":
        return f"jdbc:db2://{host}:{port or 50000}/{db}"
    if connector == "teradata":
        return f"jdbc:teradata://{host}/DATABASE={db},DBS_PORT={port or 1025}"
    if connector == "sap_hana":
        return f"jdbc:sap://{host}:{port or 39015}/?databaseName={db}"
    if connector == "sybase":
        return f"jdbc:sybase:Tds:{host}:{port or 5000}/{db}"
    raise ValueError(f"No JDBC URL for {connector}")


def quote(dialect: str, name: str) -> str:
    if dialect in ("mysql", "mariadb"):
        return "`" + name.replace("`", "``") + "`"
    if dialect in ("sqlserver", "azure_sql", "synapse", "sybase"):
        return "[" + name.replace("]", "]]") + "]"
    return '"' + name.replace('"', '""') + '"'


def merge_sql(dialect: str, target: str, stage: str, keys: list[str], columns: list[str]) -> str:
    """Upsert the staged rows into the target table, in the target database's own dialect."""
    if not keys:
        raise ValueError("Merge needs at least one key column")
    q = lambda c: quote(dialect, c)  # noqa: E731
    cols = ", ".join(q(c) for c in columns)
    non_keys = [c for c in columns if c not in keys]
    if dialect in ("mysql", "mariadb"):
        upd = ", ".join(f"{q(c)} = VALUES({q(c)})" for c in non_keys) or f"{q(keys[0])} = {q(keys[0])}"
        return f"INSERT INTO {target} ({cols}) SELECT {cols} FROM {stage} ON DUPLICATE KEY UPDATE {upd}"
    if dialect == "cockroachdb":
        return f"UPSERT INTO {target} ({cols}) SELECT {cols} FROM {stage}"
    alias_t, alias_s = ("t", "s")
    as_kw = "" if dialect == "oracle" else "AS "
    on = " AND ".join(f"{alias_t}.{q(k)} = {alias_s}.{q(k)}" for k in keys)
    upd = ", ".join(f"{alias_t}.{q(c)} = {alias_s}.{q(c)}" for c in non_keys)
    ins_vals = ", ".join(f"{alias_s}.{q(c)}" for c in columns)
    sql = f"MERGE INTO {target} {as_kw}{alias_t} USING {stage} {as_kw}{alias_s} ON ({on})"
    if upd:
        sql += f" WHEN MATCHED THEN UPDATE SET {upd}"
    sql += f" WHEN NOT MATCHED THEN INSERT ({cols}) VALUES ({ins_vals})"
    return sql + (";" if dialect in ("sqlserver", "azure_sql", "synapse") else "")


def storage_uri(connector: str, cfg: dict[str, Any], folder: str) -> str:
    bucket, prefix = cfg.get("bucket", ""), (cfg.get("prefix") or "").strip("/")
    base = {
        "s3": f"s3://{bucket}",
        "gcs": f"gs://{bucket}",
        "adls": f"abfss://{bucket}@{cfg.get('account')}.dfs.core.windows.net",
        "azure_blob": f"wasbs://{bucket}@{cfg.get('account')}.blob.core.windows.net",
        "onelake": f"abfss://{cfg.get('workspace')}@onelake.dfs.fabric.microsoft.com/{bucket}/Files",
    }[connector]
    return "/".join(p for p in (base, prefix, folder.strip("/")) if p)


def publish_plan(spec: dict) -> list[dict]:
    """(target, table) pairs to publish: each target's chosen tables, defaulting to all Gold tables."""
    lh = spec["lakehouse"]
    schema = {"bronze": lh["bronze_schema"], "silver": lh["silver_schema"], "gold": lh["gold_schema"]}
    tables = {t["name"]: t for t in lh["tables"] if t.get("enabled", True)}
    plan = []
    for tg in spec.get("targets", []):
        names = tg.get("tables") or [n for n, t in tables.items() if t["layer"] == "gold"]
        for n in names:
            if n in tables:
                plan.append({"target": tg, "table": n, "source": f"{lh['catalog']}.{schema[tables[n]['layer']]}.{n}"})
    return plan


# ------------------------------------------------------------------ Spark writers
def _secret(spark, target: dict, field: str) -> str | None:
    from pyspark.dbutils import DBUtils  # available on Databricks

    try:
        return DBUtils(spark).secrets.get("easyetl", f"{target['connection_id']}-{field}")
    except Exception:  # noqa: BLE001 — optional secrets (e.g. managed identity) are simply absent
        return None


def _run_jdbc(spark, url: str, user: str | None, password: str | None, sql: str) -> None:
    jvm = spark.sparkContext._jvm  # plain JDBC statement for the MERGE (Spark's writer only inserts)
    conn = jvm.java.sql.DriverManager.getConnection(url, user, password)
    try:
        conn.createStatement().execute(sql)
    finally:
        conn.close()


def write_target(spark, df, target: dict, table: str, secret: Callable[[str], str | None]) -> dict:  # noqa: C901 — one branch per family
    from pyspark.sql import functions as F

    c, cfg, mode = target["connector"], target.get("config") or {}, target.get("mode", "overwrite")
    dest = target.get("destination") or ""
    keys = target.get("merge_keys") or []
    name = f"{dest}.{table}" if dest and c not in STORAGE_FAMILY | KAFKA_FAMILY else table
    rows = df.count()
    if c in JDBC_FAMILY:
        url, user, pwd = jdbc_url(c, cfg), secret("username") or cfg.get("username"), secret("password")
        writer = lambda d, t, m: (d.write.format("jdbc").option("url", url).option("dbtable", t)  # noqa: E731
                                  .option("user", user).option("password", pwd).mode(m).save())
        if mode == "merge":
            stage = f"{name}__easyetl_stage"
            writer(df, stage, "overwrite")
            _run_jdbc(spark, url, user, pwd, merge_sql(c, name, stage, keys, df.columns))
        else:
            writer(df, name, mode)
    elif c == "databricks":
        full = f"{cfg.get('catalog') or 'main'}.{dest or cfg.get('schema') or 'default'}.{table}"
        if mode == "merge" and spark.catalog.tableExists(full):
            from delta.tables import DeltaTable

            cond = " AND ".join(f"t.`{k}` = s.`{k}`" for k in keys)
            DeltaTable.forName(spark, full).alias("t").merge(df.alias("s"), cond).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute()
        else:
            df.write.format("delta").mode("overwrite" if mode == "merge" else mode).option("mergeSchema", "true").saveAsTable(full)
        name = full
    elif c == "snowflake":
        opts = {"sfURL": f"{cfg.get('account')}.snowflakecomputing.com", "sfUser": secret("username") or cfg.get("username"),
                "sfDatabase": cfg.get("database"), "sfSchema": dest or cfg.get("schema") or "PUBLIC", "sfWarehouse": cfg.get("warehouse"), "sfRole": cfg.get("role") or ""}
        if secret("private_key"):
            opts["pem_private_key"] = secret("private_key")
        else:
            opts["sfPassword"] = secret("password")
        if mode == "merge":
            stage = f"{table}__EASYETL_STAGE"
            df.write.format("snowflake").options(**opts).option("dbtable", stage).mode("overwrite").save()
            spark.sparkContext._jvm.net.snowflake.spark.snowflake.Utils.runQuery(opts, merge_sql("snowflake", table, stage, keys, df.columns))
        else:
            df.write.format("snowflake").options(**opts).option("dbtable", table).mode(mode).save()
    elif c == "bigquery":
        w = df.write.format("bigquery").option("table", f"{cfg.get('project')}.{dest or cfg.get('dataset')}.{table}").option("writeMethod", "direct")
        if secret("service_account_json"):
            w = w.option("credentials", base64.b64encode(secret("service_account_json").encode()).decode())
        w.mode(mode).save()
    elif c in STORAGE_FAMILY:
        path = storage_uri(c, cfg, f"{dest or 'easyetl'}/{table}")
        fmt = target.get("file_format", "parquet")
        out = df.withColumn("_dq_issues", F.array_join("_dq_issues", "; ")) if fmt == "csv" and "_dq_issues" in df.columns else df
        out.write.format(fmt).mode(mode).option("header", "true").save(path)
        name = path
    elif c in KAFKA_FAMILY:
        if c == "event_hubs":
            bootstrap = f"{cfg.get('namespace')}.servicebus.windows.net:9093"
            user, pwd, mech = "$ConnectionString", secret("connection_string"), "PLAIN"
        else:
            bootstrap = cfg.get("bootstrap_servers")
            user = secret("api_key") or secret("username") or cfg.get("api_key") or cfg.get("username")
            pwd = secret("api_secret") or secret("password")
            mech = "SCRAM-SHA-512" if (cfg.get("auth_method") == "sasl_scram") else "PLAIN"
        w = (df.select(F.to_json(F.struct(*df.columns)).alias("value")).write.format("kafka")
             .option("kafka.bootstrap.servers", bootstrap).option("topic", dest or table))
        if user and pwd:
            module = "org.apache.kafka.common.security.scram.ScramLoginModule" if mech.startswith("SCRAM") else "org.apache.kafka.common.security.plain.PlainLoginModule"
            w = (w.option("kafka.security.protocol", "SASL_SSL").option("kafka.sasl.mechanism", mech)
                 .option("kafka.sasl.jaas.config", f'kafkashaded.{module} required username="{user}" password="{pwd}";'))
        w.save()
    elif c == "mongodb":
        uri = f"mongodb+srv://{secret('username') or cfg.get('username')}:{secret('password')}@{cfg.get('host')}/"
        w = df.write.format("mongodb").option("connection.uri", uri).option("database", cfg.get("database")).option("collection", dest or table)
        if mode == "merge":
            w = w.option("operationType", "replace").option("idFieldList", ",".join(keys)).mode("append")
        else:
            w = w.mode(mode)
        w.save()
    elif c == "cosmosdb":
        (df.write.format("cosmos.oltp").option("spark.cosmos.accountEndpoint", cfg.get("endpoint")).option("spark.cosmos.accountKey", secret("account_key"))
         .option("spark.cosmos.database", cfg.get("database")).option("spark.cosmos.container", dest or table)
         .option("spark.cosmos.write.strategy", "ItemOverwrite" if mode == "merge" else "ItemAppend").mode("append").save())
    elif c == "elasticsearch":
        w = (df.write.format("org.elasticsearch.spark.sql").option("es.nodes", cfg.get("url")).option("es.nodes.wan.only", "true")
             .option("es.resource", dest or table))
        if secret("api_key"):
            w = w.option("es.net.http.header.Authorization", f"ApiKey {secret('api_key')}")
        else:
            w = w.option("es.net.http.auth.user", cfg.get("username") or secret("username")).option("es.net.http.auth.pass", secret("password"))
        if mode == "merge":
            w = w.option("es.mapping.id", keys[0]).option("es.write.operation", "upsert")
        w.mode("overwrite" if mode == "overwrite" else "append").save()
    elif c == "cassandra":
        (df.write.format("org.apache.spark.sql.cassandra").option("keyspace", cfg.get("keyspace")).option("table", dest or table)
         .option("spark.cassandra.connection.host", cfg.get("contact_points")).mode("append").save())
    elif c == "rest_api":
        import requests

        headers = {"Content-Type": "application/json"}
        if secret("api_key"):
            headers[cfg.get("api_key_header") or "X-API-Key"] = secret("api_key")
        if secret("token"):
            headers["Authorization"] = f"Bearer {secret('token')}"
        url = cfg.get("url")
        batch: list[dict] = []
        for row in df.toJSON().toLocalIterator():
            batch.append(json.loads(row))
            if len(batch) == 500:
                requests.post(url, json=batch, headers=headers, timeout=60).raise_for_status()
                batch = []
        if batch:
            requests.post(url, json=batch, headers=headers, timeout=60).raise_for_status()
        name = url
    elif c == "salesforce":
        import requests

        instance = (cfg.get("organization") or "").rstrip("/")
        instance = instance if instance.startswith("http") else f"https://{instance}.my.salesforce.com"
        headers = {"Authorization": f"Bearer {secret('api_token')}", "Content-Type": "application/json"}
        body = {"object": dest or table, "operation": "upsert" if mode == "merge" else "insert", "contentType": "CSV", "lineEnding": "LF"}
        if mode == "merge":
            body["externalIdFieldName"] = keys[0]
        job = requests.post(f"{instance}/services/data/v61.0/jobs/ingest", json=body, headers=headers, timeout=60)
        job.raise_for_status()
        job_id = job.json()["id"]
        csv = df.drop(*[x for x in DQ_COLUMNS if x in df.columns]).toPandas().to_csv(index=False)
        requests.put(f"{instance}/services/data/v61.0/jobs/ingest/{job_id}/batches", data=csv.encode(),
                     headers={**headers, "Content-Type": "text/csv"}, timeout=300).raise_for_status()
        requests.patch(f"{instance}/services/data/v61.0/jobs/ingest/{job_id}", json={"state": "UploadComplete"}, headers=headers, timeout=60).raise_for_status()
        name = f"{dest or table} (Bulk API job {job_id})"
    else:
        raise ValueError(f"{c} can't be used as a target")
    return {"target": target.get("name") or c, "table": table, "written_to": name, "rows": rows, "mode": mode}


def publish(spark, spec: dict) -> list[dict]:
    """Entry point for the job's `publish` task."""
    from pyspark.sql import functions as F

    results = []
    for item in publish_plan(spec):
        tg = item["target"]
        df = spark.read.table(item["source"])
        if "_dq_status" in df.columns and not tg.get("include_flagged", True):
            df = df.where(F.col("_dq_status") == "PASSED")
        results.append(write_target(spark, df, tg, item["table"], lambda f, tg=tg: _secret(spark, tg, f)))
    return results
