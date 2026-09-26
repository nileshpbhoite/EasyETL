# EasyETL

**Connect Anything. Modernize Automatically. Deploy to Databricks.**

EasyETL is a no-code, AI-powered data integration and modernization platform. Upload a messy Excel/CSV/JSON/XML file (or connect Salesforce, SAP, SQL Server, a REST API, S3…), let the platform profile and explain the data, accept best-practice recommendations, transform it with buttons and visual controls, and deploy a governed Bronze → Silver → Gold Lakehouse to Databricks — without writing Python, SQL, Spark, YAML or Terraform.

```
SOURCE → ANALYZE → TRANSFORM → CONFIGURE → DESIGN → REVIEW → DEPLOY → MONITOR
          at every stage:  Analyze → Recommend → Explain → User approves → Apply
```

## Quick start

**Local (Python 3.11+, Node 20+):**

```bash
./scripts/dev.sh          # API on http://localhost:8000, web app on http://localhost:3000
```

**Docker (PostgreSQL + API + web):**

```bash
cp .env.example .env
docker compose up --build
```

Open http://localhost:3000 and choose **Explore the demo workspace as → Admin** (or sign in with `alex.morgan@northwind.example` / `easyetl-demo`). The first start seeds a demo tenant with four pipelines (a deployed Customer 360 built from the demo files, a Salesforce sync, a SQL Server inventory pipeline and a draft REST API pipeline) plus seven built-in templates.

Demo roles: `admin`, `data_engineer`, `analyst`, `viewer` — permissions are enforced on every API call.

## What's in the box

| Area | Highlights |
|---|---|
| **Sources** | Drag-and-drop files (Excel with multiple sheets, CSV/TXT, JSON/JSON Lines, XML, Parquet, Avro, ZIP with per-member detection, gzip). Connector wizard for Salesforce, SAP, ServiceNow, Workday, Snowflake, HubSpot, SFTP, SQL Server, Oracle, PostgreSQL, MySQL, any JDBC, ADLS, Azure Blob, S3, GCS, REST (auth, headers, params, 4 pagination styles, incremental field) and GraphQL. |
| **Detection & discovery** | File type, encoding, compression, delimiter, structure, sheets, nested structures, row/column counts; tables/objects with record counts, modification dates, incremental fields, CDC capability, foreign keys. |
| **Profiling** | Deterministic Polars profiler: types & semantic types, nulls, uniqueness, cardinality, duplicates, min/max/mean/median/std/percentiles, histograms, IQR outliers, date ranges, invalid values, format patterns, primary-key candidates with confidence, cross-dataset relationships (FK discovery), PII classification, quality score (completeness, validity, uniqueness, consistency). Large sources are sampled locally and routed to Databricks for full-volume profiling. |
| **AI recommendations** | Insights and recommendations with reason, impact, confidence, expected benefit, explanation, Apply / Ignore / Before-After / Ask AI; Apply Selected / Apply All; quality-rule, ingestion, Lakehouse and governance recommendations. |
| **Transformation Studio** | 88 no-code transformations in 15 categories (clean & standardize, types, text, date & time, missing values incl. AI-assisted imputation, duplicates incl. fuzzy & survivorship, filters with AND/OR, sort, joins/lookup/fuzzy join/union, aggregate & window, pivot/unpivot/melt/cross-tab, schema & structure incl. flatten JSON/XML and explode, visual formula builder, IF/CASE rules, enrichment, data quality, PII mask/hash/tokenize/encrypt/restrict). Visual Flow and Table views, add/edit/disable/reorder (drag & drop)/duplicate/delete, live **Before / After** preview with changed cells highlighted and quality, rows, nulls, duplicates and invalid-value deltas. |
| **Configure** | Recommended ingestion engine (Auto Loader, Lakeflow Connect, batch, streaming, JDBC, REST) with plain-English rationale; full/incremental, CDC, schedule, schema evolution, error handling; compute, retries, file handling and checkpointing in Advanced Mode; live cost estimate. |
| **Design** | AI-designed medallion architecture (bronze per source, silver per business entity with keys and liquid clustering, gold models such as `customer_360`), interactive diagram, Advanced Mode table editor; Unity Catalog governance (PII actions, column masks, grants, tags, owner, audit, lineage); Data Quality screen with rule catalog, **Create Rule** dialog and before/after dimension radar. |
| **Review & deploy** | Full summary plus the **AI Pipeline Readiness Check** (source, schema, transformations, quality, ingestion, Lakehouse incl. cross-pipeline table conflicts, governance, security, performance, cost, dependencies) with **Fix Automatically**. One-click **Deploy to Databricks** generating a bundle: `databricks.yml`, Lakeflow Declarative Pipeline, orchestration job, Unity Catalog SQL (grants, tags, masks), a fixed Spark runtime and the metadata spec. |
| **Monitor** | Status, last/next run, records, processing time, throughput, freshness, quality, failed records, storage, cost; visual Source → Ingestion → Bronze → Silver → Gold status; run history charts; **AI continuous monitoring** for volume, schema, quality, freshness, performance and cost anomalies (robust statistics against same-hour baselines). |
| **Everywhere** | Contextual AI assistant (grounded in the pipeline's profile and configuration, can propose a validated step you apply with one click), global search (⌘K), notifications, environment selector, data catalog with lineage, templates (save, reuse, import/export), autosave with version history, Undo and restore, friendly errors with "Show technical details". |

## Architecture

```
frontend/  Next.js 16 · React 19 · TypeScript · Tailwind CSS v4 · Radix · React Flow · Recharts
backend/   FastAPI · Pydantic · SQLAlchemy (PostgreSQL / SQLite) · Polars · PyArrow · openpyxl · lxml
```

**Metadata is the source of truth.** Every UI action becomes a validated change to one pipeline metadata document (`backend/app/engine/metadata.py`), versioned in `pipeline_versions` (Undo/restore/history). Previews, the lakehouse designer, the readiness check, the bundle generator and the Databricks runtime all read that document — never UI state.

**AI never talks to Databricks.**

```
User → Data Profiler → AI Recommendation Engine → Recommendation JSON → Rules / Policy Engine
     → Validated Metadata → Pipeline Generator → Databricks
```

- `profiling/` computes facts deterministically.
- `ai/heuristics.py` is the built-in expert engine; `ai/llm.py` optionally adds Claude via structured outputs. The LLM receives profile statistics only (never datasets) and must answer with a strict schema.
- `ai/policy.py` validates every recommendation (known transformation, existing columns, parameter schema, no executable content) before it can be shown or applied, and again at apply time.

| Backend module | Responsibility |
|---|---|
| `connectors/` | Connector SDK (`authenticate`, `test_connection`, `discover`, `get_schema`, `read`, `profile`, `detect_incremental`, `detect_cdc`, `read_metadata`), file detection, implementations and registry |
| `profiling/` | Semantic detection, validity rules, profiler |
| `transforms/` | Transformation library (specs drive the UI forms), expression builder, executor and before/after diff |
| `engine/` | Metadata model, pipeline service, runtime/data access, quality rules, readiness check & cost |
| `ai/` | Expert engine, optional Claude provider, policy engine, contextual assistant |
| `deploy/` | Bundle generator, Spark runtime (`deploy/runtime/easyetl_runtime.py`), simulated and real Databricks deployers |
| `monitoring/` | Run history and anomaly detection |
| `core/` | Config, DB, models, OAuth2/JWT + RBAC, encrypted secret store, audit log, friendly errors, object storage |

**Security:** OAuth2 bearer tokens (JWT) with an SSO-ready login, four roles enforced per endpoint, credentials encrypted at rest (Fernet) and referenced by id (never stored in pipeline metadata or returned), tenant isolation on every row and file, per-environment deployment targets, audit log of changes, deployments and sign-ins. Large files use a pre-signed upload path so bytes can go straight to object storage.

## Configuration

All settings are environment variables prefixed with `EASYETL_` (see `.env.example` and `backend/app/core/config.py`).

- **Databricks:** set `EASYETL_DATABRICKS_HOST` and `EASYETL_DATABRICKS_TOKEN` to switch from the simulated deployer to `DatabricksDeployer`, which calls the Workspace, Pipelines, Jobs and SQL Statement Execution APIs. Without them, deployment and run monitoring are simulated end-to-end.
- **Claude:** set `EASYETL_AI_PROVIDER=anthropic` and `EASYETL_ANTHROPIC_API_KEY`. Results are merged with the built-in engine and pass through the policy engine; failures fall back to the built-in engine.
- **Database:** `EASYETL_DATABASE_URL` (defaults to SQLite in `backend/data/`; Docker Compose uses PostgreSQL).

## Demo data

`backend/app/demo/generate.py` generates intentionally messy files in `backend/app/demo/data/`: `Customer_Data.xlsx` (4 sheets, duplicates, invalid emails, 11 phone formats, 6 date formats, 20 spellings of 4 countries), `Orders.csv` (mixed dates, currency strings, negative prices, orphan keys), `Vehicles.json` (nested objects and arrays), `Service_History.xml` (nested parts and a schema-drift field), `Dealer_Export_Bundle.zip`, and a small SQL database used by the SQL Server/PostgreSQL connectors when the server is `demo`. Other demo sources: bucket `easyetl-demo` for cloud storage, `demo://recalls` for the REST connector, and the sandbox environment for SaaS applications.

## Tests

```bash
cd backend && python -m pytest -q          # API journey, transformations, policy engine, profiler, RBAC, secrets
cd frontend && npm run typecheck && npm run build
```

## Current limitations

- SaaS application connectors (Salesforce, SAP, ServiceNow, Workday, Snowflake, HubSpot) run against a built-in sandbox org; production ingestion is designed to go through Databricks Lakeflow Connect managed connectors. Cloud storage and SFTP connectors browse only the demo bucket until a cloud SDK adapter is enabled.
- SQL Server, Oracle and MySQL need their Python/ODBC drivers installed on the API server for non-demo hosts.
- The real Databricks deployer and the Spark runtime have not been exercised against a live workspace in this repository's tests; the simulated deployer generates the same bundle.
- Monitoring history in simulation mode is synthetic (deterministic per pipeline, including injected anomalies for demonstration).
