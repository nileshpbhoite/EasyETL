"""Connectors declared as data: SaaS applications, cloud warehouses, streaming platforms and NoSQL stores.

Each entry defines the real configuration and authentication options for the system, the objects it exposes and
whether it can be a target. At deploy time Databricks does the actual reading/writing (Lakeflow Connect managed
connectors, Spark connectors, Structured Streaming). While designing a pipeline — or when 'demo'/'sandbox' is
entered — discovery and previews use the system's standard object catalog with generated sample rows.
"""
from __future__ import annotations

from typing import Any

from .base import AuthMethod, ConnectorSpec, FieldSpec
from .impl import CloudStorageConnector, SaaSConnector, _loc_help, _make_cloud

F = FieldSpec
A = AuthMethod


def _pw(user: str = "Username") -> AuthMethod:
    return A(id="password", label=f"{user} & password", fields=[F(name="username", label=user, required=True),
                                                            F(name="password", label="Password", type="password", secret=True, required=True)])


def _token(label: str = "API token", name: str = "api_token") -> AuthMethod:
    return A(id="token", label=label, fields=[F(name=name, label=label, type="password", secret=True, required=True)])


OAUTH = A(id="oauth", label="OAuth (recommended)")
ENV = F(name="environment", label="Environment", type="select", default="production",
        options=[{"value": "production", "label": "Production"}, {"value": "sandbox", "label": "Sandbox (sample data)"}])


def _org(label: str = "Organization / instance", placeholder: str = "mycompany") -> FieldSpec:
    return F(name="organization", label=label, placeholder=placeholder)


def _entra() -> AuthMethod:
    return A(id="entra_sp", label="Microsoft Entra ID app", fields=[F(name="tenant_id", label="Tenant ID", required=True),
                                                                    F(name="client_id", label="Client ID", required=True),
                                                                    F(name="client_secret", label="Client secret", type="password", secret=True, required=True)])


def _aws() -> list[AuthMethod]:
    return [A(id="iam_role", label="IAM role (recommended)", fields=[F(name="role_arn", label="Role ARN", placeholder="arn:aws:iam::123456789012:role/easyetl")]),
            A(id="keys", label="Access keys", fields=[F(name="access_key_id", label="Access key ID", required=True),
                                                    F(name="secret_access_key", label="Secret access key", type="password", secret=True, required=True)])]


def _gcp() -> AuthMethod:
    return A(id="service_account", label="Service account", fields=[F(name="service_account_json", label="Service account key (JSON)", type="password", secret=True, required=True)])


# id: name, category, color, icon, description, recommended ingestion, cdc, availability, roles, target modes, target note,
#     instance, api version, config fields, auth methods, object kind, sandbox keys, objects
ENTRIES: list[dict[str, Any]] = [
    # ------------------------------------------------------------------ applications
    dict(id="dynamics365", name="Microsoft Dynamics 365", category="application", color="#0b53ce", icon="building", ing="lakeflow_connect", cdc=True,
         desc="Dynamics 365 Sales, Customer Service and Finance & Operations (Dataverse).", instance="northwind.crm.dynamics.com", api="Dataverse Web API v9.2",
         fields=[ENV, _org("Environment URL", "https://org.crm.dynamics.com")], auth=[_entra(), OAUTH],
         objects=[("account", ["accountid", "name", "industrycode", "address1_country", "revenue", "emailaddress1", "modifiedon"], 2100),
                  ("contact", ["contactid", "parentcustomerid", "firstname", "lastname", "emailaddress1", "telephone1", "modifiedon"], 6400),
                  ("opportunity", ["opportunityid", "name", "estimatedvalue", "stepname", "estimatedclosedate", "modifiedon"], 1900),
                  ("incident", ["incidentid", "title", "prioritycode", "statecode", "customerid", "modifiedon"], 3300)]),
    dict(id="netsuite", name="Oracle NetSuite", category="application", color="#1f4f7a", icon="building", ing="lakeflow_connect", cdc=False,
         desc="NetSuite ERP records via SuiteAnalytics Connect.", instance="1234567.suitetalk.api.netsuite.com", api="SuiteQL",
         fields=[ENV, _org("Account ID", "1234567")], auth=[A(id="tba", label="Token-based authentication", fields=[
             F(name="consumer_key", label="Consumer key", required=True), F(name="consumer_secret", label="Consumer secret", type="password", secret=True, required=True),
             F(name="token_id", label="Token ID", required=True), F(name="token_secret", label="Token secret", type="password", secret=True, required=True)]), OAUTH],
         objects=[("Customer", ["internalId", "companyName", "email", "phone", "country", "lastModifiedDate"], 3100),
                  ("SalesOrder", ["internalId", "customer_id", "tranDate", "total", "status", "lastModifiedDate"], 12800),
                  ("Item", ["internalId", "itemId", "displayName", "basePrice", "isInactive", "lastModifiedDate"], 640)]),
    dict(id="oracle_fusion", name="Oracle Fusion Cloud", category="application", color="#c74634", icon="building", ing="lakeflow_connect", cdc=False,
         desc="Oracle Fusion ERP, SCM and HCM via BI Cloud Connector.", instance="fa-abcd.oraclecloud.com", api="BICC",
         fields=[ENV, _org("Pod URL", "https://fa-xxxx.oraclecloud.com")], auth=[_pw(), OAUTH],
         objects=[("Suppliers", ["supplier_id", "supplier_name", "country", "status", "last_update_date"], 2400),
                  ("Invoices", ["invoice_id", "supplier_id", "invoice_date", "invoice_amount", "currency", "status", "last_update_date"], 38000),
                  ("PurchaseOrders", ["po_header_id", "supplier_id", "order_date", "amount", "status", "last_update_date"], 21000)]),
    dict(id="successfactors", name="SAP SuccessFactors", category="application", color="#0a6ed1", icon="users", ing="lakeflow_connect", cdc=False,
         desc="Employee Central and talent data via OData.", instance="api4.successfactors.com", api="OData V2",
         fields=[ENV, _org("Company ID", "NORTHWIND")], auth=[OAUTH, _pw("API user")],
         objects=[("EmpJob", ["userId", "jobCode", "department", "location", "startDate", "lastModifiedDateTime"], 5200),
                  ("PerPersonal", ["personIdExternal", "firstName", "lastName", "email", "lastModifiedDateTime"], 5200),
                  ("FODepartment", ["externalCode", "name", "costCenter", "status", "lastModifiedDateTime"], 180)]),
    dict(id="zendesk", name="Zendesk", category="application", color="#03363d", icon="life-buoy", ing="lakeflow_connect", cdc=False,
         desc="Support tickets, users and organizations.", instance="northwind.zendesk.com", api="Support API v2", fields=[ENV, _org("Subdomain", "mycompany")], auth=[OAUTH, _token()],
         objects=[("tickets", ["id", "subject", "status", "priority", "requester_id", "created_at", "updated_at"], 9200),
                  ("users", ["id", "name", "email", "phone", "role", "updated_at"], 4300),
                  ("organizations", ["id", "name", "domain_names", "updated_at"], 380)]),
    dict(id="jira", name="Jira", category="application", color="#0052cc", icon="ticket", ing="rest_api", cdc=False,
         desc="Jira Software and Jira Service Management issues, projects and sprints.", instance="northwind.atlassian.net", api="REST v3",
         fields=[ENV, _org("Site", "mycompany.atlassian.net")], auth=[OAUTH, A(id="token", label="Email & API token", fields=[
             F(name="email", label="Email", required=True), F(name="api_token", label="API token", type="password", secret=True, required=True)])],
         objects=[("issues", ["id", "key", "summary", "status", "priority", "assignee", "created", "updated"], 15400),
                  ("projects", ["id", "key", "name", "lead", "updated"], 42),
                  ("sprints", ["id", "name", "state", "start_date", "end_date", "updated"], 210)]),
    dict(id="shopify", name="Shopify", category="application", color="#5e8e3e", icon="shopping-cart", ing="rest_api", cdc=False,
         desc="Orders, customers and products from your Shopify store.", instance="northwind.myshopify.com", api="Admin API 2024-07",
         fields=[ENV, _org("Store domain", "mystore.myshopify.com")], auth=[_token("Admin API access token", "access_token"), OAUTH],
         objects=[("orders", ["id", "customer_id", "email", "total_price", "currency", "financial_status", "created_at", "updated_at"], 22000),
                  ("customers", ["id", "first_name", "last_name", "email", "phone", "country", "updated_at"], 8700),
                  ("products", ["id", "title", "vendor", "product_type", "status", "updated_at"], 1200)]),
    dict(id="stripe", name="Stripe", category="application", color="#635bff", icon="credit-card", ing="rest_api", cdc=False,
         desc="Payments, customers, invoices and subscriptions.", instance="acct_1Nw…", api="2024-06-20",
         fields=[ENV], auth=[_token("Restricted API key", "api_key")],
         objects=[("charges", ["id", "customer", "amount", "currency", "status", "created"], 34000),
                  ("customers", ["id", "name", "email", "phone", "country", "created"], 6100),
                  ("invoices", ["id", "customer", "amount_due", "status", "due_date", "created"], 15000),
                  ("subscriptions", ["id", "customer", "plan", "status", "current_period_end", "created"], 4200)]),
    dict(id="marketo", name="Adobe Marketo Engage", category="application", color="#5c4c9f", icon="megaphone", ing="rest_api", cdc=False,
         desc="Leads, activities and programs.", instance="123-ABC-456.mktorest.com", api="REST v1", fields=[ENV, _org("Munchkin ID", "123-ABC-456")], auth=[A(id="client", label="Client ID & secret", fields=[
             F(name="client_id", label="Client ID", required=True), F(name="client_secret", label="Client secret", type="password", secret=True, required=True)])],
         objects=[("leads", ["id", "email", "firstName", "lastName", "company", "leadStatus", "updatedAt"], 48000),
                  ("activities", ["id", "leadId", "activityTypeId", "activityDate", "campaignId"], 310000),
                  ("programs", ["id", "name", "type", "status", "updatedAt"], 240)]),
    dict(id="google_analytics", name="Google Analytics 4", category="application", color="#e37400", icon="bar-chart", ing="lakeflow_connect", cdc=False,
         desc="GA4 events and traffic reports.", instance="properties/123456789", api="Data API v1", fields=[ENV, _org("Property ID", "123456789")], auth=[_gcp(), OAUTH],
         objects=[("events_daily", ["event_date", "event_name", "country", "device_category", "sessions", "users", "updated_at"], 90000),
                  ("traffic_sources", ["date", "source", "medium", "sessions", "conversions", "updated_at"], 12000)]),
    dict(id="google_ads", name="Google Ads", category="application", color="#4285f4", icon="bar-chart", ing="rest_api", cdc=False,
         desc="Campaign, ad group and keyword performance.", instance="customers/123-456-7890", api="Google Ads API v17",
         fields=[ENV, _org("Customer ID", "123-456-7890")], auth=[OAUTH],
         objects=[("campaigns", ["campaign_id", "name", "status", "budget", "cost", "clicks", "updated_at"], 380),
                  ("keyword_stats", ["keyword_id", "campaign_id", "keyword", "impressions", "clicks", "cost", "date"], 64000)]),
    dict(id="sharepoint_lists", name="SharePoint Lists", category="application", color="#038387", icon="list", ing="rest_api", cdc=False,
         desc="Microsoft Lists / SharePoint list items.", instance="northwind.sharepoint.com", api="Microsoft Graph v1.0",
         fields=[ENV, _org("Site URL", "https://company.sharepoint.com/sites/ops")], auth=[_entra(), OAUTH],
         objects=[("Assets", ["ID", "Title", "Owner", "Location", "Status", "Modified"], 820), ("Requests", ["ID", "Title", "Requester", "Priority", "Status", "Modified"], 3100)]),

    # ------------------------------------------------------------------ warehouses
    dict(id="bigquery", name="Google BigQuery", category="warehouse", color="#4386fa", icon="warehouse", ing="jdbc", cdc=False,
         desc="BigQuery datasets and tables (Lakehouse Federation or the BigQuery Spark connector).", roles=["source", "target"],
         modes=["append", "overwrite"], note="Writes with the BigQuery Spark connector.", instance="northwind-analytics", api="BigQuery v2",
         fields=[F(name="project", label="Project ID", required=True, placeholder="my-gcp-project", help="Tip: enter 'demo' for sample datasets."),
                 F(name="dataset", label="Dataset", placeholder="analytics"), F(name="location", label="Location", default="US", advanced=True)],
         auth=[_gcp(), A(id="adc", label="Application default credentials")], sandbox_keys=("project",),
         objects=[("analytics.customers", ["customer_id", "email", "country", "lifetime_value", "updated_at"], 52000),
                  ("analytics.orders", ["order_id", "customer_id", "order_ts", "amount", "status", "updated_at"], 410000),
                  ("analytics.web_sessions", ["session_id", "customer_id", "started_at", "pages", "device", "updated_at"], 920000)]),
    dict(id="fabric_warehouse", name="Microsoft Fabric Warehouse", category="warehouse", color="#117865", icon="warehouse", ing="jdbc", cdc=False,
         desc="Fabric Data Warehouse and Lakehouse SQL endpoints.", instance="xyz.datawarehouse.fabric.microsoft.com", api="TDS",
         fields=[F(name="host", label="SQL connection string (server)", required=True, placeholder="xyz.datawarehouse.fabric.microsoft.com", help="Tip: enter 'demo'."),
                 F(name="database", label="Warehouse", required=True)], auth=[_entra(), A(id="managed_identity", label="Managed identity")], sandbox_keys=("host",),
         objects=[("dbo.DimCustomer", ["CustomerKey", "CustomerName", "Email", "Country", "ModifiedDate"], 18000),
                  ("dbo.FactSales", ["SalesKey", "CustomerKey", "OrderDate", "Amount", "Quantity", "ModifiedDate"], 640000)]),

    # ------------------------------------------------------------------ streaming
    dict(id="kafka", name="Apache Kafka", category="streaming", color="#231f20", icon="radio", ing="streaming", cdc=False, obj_label="topics", kind="topic",
         desc="Kafka topics (JSON, Avro or Protobuf) with Structured Streaming.", roles=["source", "target"], modes=["append"],
         note="Publishes curated records to a topic.", instance="broker-1:9092", api="Kafka 3.x",
         fields=[F(name="bootstrap_servers", label="Bootstrap servers", required=True, placeholder="broker1:9092,broker2:9092", help="Tip: enter 'demo' for sample topics."),
                 F(name="topic_pattern", label="Topics (name or pattern)", placeholder="orders.*"),
                 F(name="starting_offsets", label="Start from", type="select", default="latest", options=[{"value": "latest", "label": "New messages only"}, {"value": "earliest", "label": "Earliest available"}]),
                 F(name="value_format", label="Message format", type="select", default="json", options=[{"value": v, "label": v.upper()} for v in ("json", "avro", "protobuf")]),
                 F(name="schema_registry_url", label="Schema registry URL", advanced=True), F(name="consumer_group", label="Consumer group", advanced=True)],
         auth=[A(id="sasl_scram", label="SASL/SCRAM", fields=[F(name="username", label="Username", required=True), F(name="password", label="Password", type="password", secret=True, required=True)]),
               A(id="sasl_plain", label="SASL/PLAIN", fields=[F(name="username", label="Username", required=True), F(name="password", label="Password", type="password", secret=True, required=True)]),
               A(id="mtls", label="Mutual TLS (client certificate)", fields=[F(name="client_certificate", label="Client certificate (PEM)", type="password", secret=True, required=True),
                                                                           F(name="client_key", label="Client key (PEM)", type="password", secret=True, required=True)]),
               A(id="none", label="No authentication (private network)")], sandbox_keys=("bootstrap_servers",),
         objects=[("orders.events", ["event_id", "order_id", "customer_id", "event_type", "amount", "event_ts"], 250000),
                  ("customer.updates", ["event_id", "customer_id", "email", "phone", "changed_fields", "event_ts"], 42000),
                  ("iot.telemetry", ["device_id", "temperature", "pressure", "status", "event_ts"], 1200000)]),
    dict(id="confluent", name="Confluent Cloud", category="streaming", color="#173361", icon="radio", ing="streaming", cdc=False, obj_label="topics", kind="topic",
         desc="Confluent Cloud clusters with Schema Registry.", roles=["source", "target"], modes=["append"], note="Publishes curated records to a topic.",
         instance="pkc-xxxxx.eu-west-1.aws.confluent.cloud:9092", api="Kafka 3.x",
         fields=[F(name="bootstrap_servers", label="Bootstrap server", required=True, help="Tip: enter 'demo'."), F(name="topic_pattern", label="Topics"),
                 F(name="schema_registry_url", label="Schema Registry URL")],
         auth=[A(id="api_key", label="Cluster API key", fields=[F(name="api_key", label="API key", required=True), F(name="api_secret", label="API secret", type="password", secret=True, required=True)])],
         sandbox_keys=("bootstrap_servers",),
         objects=[("orders.events", ["event_id", "order_id", "customer_id", "event_type", "amount", "event_ts"], 250000),
                  ("payments.events", ["event_id", "payment_id", "order_id", "status", "amount", "event_ts"], 180000)]),
    dict(id="event_hubs", name="Azure Event Hubs", category="streaming", color="#0072c6", icon="radio", ing="streaming", cdc=False, obj_label="event hubs", kind="topic",
         desc="Event Hubs (Kafka endpoint) for telemetry and event streams.", roles=["source", "target"], modes=["append"], note="Publishes events to an event hub.",
         instance="northwind.servicebus.windows.net", api="Kafka endpoint",
         fields=[F(name="namespace", label="Namespace", required=True, placeholder="mynamespace", help="Tip: enter 'demo'."), F(name="event_hub", label="Event hub"),
                 F(name="consumer_group", label="Consumer group", default="$Default", advanced=True)],
         auth=[A(id="connection_string", label="Connection string (SAS)", fields=[F(name="connection_string", label="Connection string", type="password", secret=True, required=True)]),
               _entra(), A(id="managed_identity", label="Managed identity")], sandbox_keys=("namespace",),
         objects=[("telemetry", ["device_id", "temperature", "humidity", "status", "enqueued_time"], 2400000),
                  ("clickstream", ["event_id", "session_id", "page", "action", "enqueued_time"], 860000)]),
    dict(id="kinesis", name="Amazon Kinesis", category="streaming", color="#8c4fff", icon="radio", ing="streaming", cdc=False, obj_label="streams", kind="topic",
         desc="Kinesis Data Streams.", instance="us-east-1", api="Kinesis",
         fields=[F(name="stream_name", label="Stream name", required=True, help="Tip: enter 'demo'."), F(name="region", label="Region", default="us-east-1"),
                 F(name="initial_position", label="Start from", type="select", default="latest", options=[{"value": "latest", "label": "Latest"}, {"value": "trim_horizon", "label": "Oldest (trim horizon)"}])],
         auth=_aws(), sandbox_keys=("stream_name",),
         objects=[("orders-stream", ["event_id", "order_id", "customer_id", "amount", "status", "approximate_arrival_ts"], 310000)]),
    dict(id="pubsub", name="Google Pub/Sub", category="streaming", color="#4285f4", icon="radio", ing="streaming", cdc=False, obj_label="subscriptions", kind="topic",
         desc="Pub/Sub subscriptions.", instance="projects/northwind", api="Pub/Sub v1",
         fields=[F(name="project", label="Project ID", required=True, help="Tip: enter 'demo'."), F(name="subscription", label="Subscription")], auth=[_gcp()], sandbox_keys=("project",),
         objects=[("orders-sub", ["message_id", "order_id", "customer_id", "amount", "status", "publish_time"], 190000)]),

    # ------------------------------------------------------------------ NoSQL
    dict(id="mongodb", name="MongoDB", category="nosql", color="#00ed64", icon="leaf", ing="batch", cdc=True, obj_label="collections", kind="collection",
         desc="MongoDB and Atlas collections (change streams for CDC).", roles=["source", "target"], modes=["append", "overwrite", "merge"],
         note="Writes documents with the MongoDB Spark connector.", instance="cluster0.abcde.mongodb.net", api="MongoDB 7",
         fields=[F(name="host", label="Connection host", required=True, placeholder="cluster0.abcde.mongodb.net", help="Tip: enter 'demo'."), F(name="database", label="Database", required=True)],
         auth=[_pw("Database user"), A(id="x509", label="X.509 certificate", fields=[F(name="certificate", label="Certificate (PEM)", type="password", secret=True, required=True)])],
         sandbox_keys=("host",),
         objects=[("customers", ["_id", "name", "email", "phone", "address_country", "updated_at"], 58000),
                  ("orders", ["_id", "customer_id", "items_count", "total", "status", "updated_at"], 240000),
                  ("reviews", ["_id", "product_id", "rating", "comment", "updated_at"], 91000)]),
    dict(id="cosmosdb", name="Azure Cosmos DB", category="nosql", color="#0078d4", icon="leaf", ing="batch", cdc=True, obj_label="containers", kind="collection",
         desc="Cosmos DB for NoSQL containers (change feed for CDC).", roles=["source", "target"], modes=["append", "merge"], note="Upserts items with the Cosmos DB Spark connector.",
         instance="northwind.documents.azure.com", api="NoSQL API",
         fields=[F(name="endpoint", label="Account endpoint", required=True, placeholder="https://account.documents.azure.com:443/", help="Tip: enter 'demo'."), F(name="database", label="Database", required=True)],
         auth=[A(id="key", label="Account key", fields=[F(name="account_key", label="Account key", type="password", secret=True, required=True)]), _entra(),
               A(id="managed_identity", label="Managed identity")], sandbox_keys=("endpoint",),
         objects=[("profiles", ["id", "userId", "email", "country", "_ts"], 72000), ("carts", ["id", "userId", "itemCount", "total", "_ts"], 130000)]),
    dict(id="dynamodb", name="Amazon DynamoDB", category="nosql", color="#4053d6", icon="leaf", ing="batch", cdc=True, obj_label="tables", kind="collection",
         desc="DynamoDB tables (exports to S3 or streams).", instance="us-east-1", api="DynamoDB",
         fields=[F(name="region", label="Region", default="us-east-1", required=True), F(name="table_prefix", label="Table name prefix", placeholder="prod_", help="Tip: enter 'demo'.")],
         auth=_aws(), sandbox_keys=("table_prefix",),
         objects=[("Users", ["pk", "email", "plan", "country", "updated_at"], 88000), ("Sessions", ["pk", "sk", "device", "duration_s", "updated_at"], 1300000)]),
    dict(id="cassandra", name="Apache Cassandra", category="nosql", color="#1287b1", icon="leaf", ing="batch", cdc=False, obj_label="tables", kind="collection",
         desc="Cassandra and DataStax Astra tables.", roles=["source", "target"], modes=["append"], note="Writes rows with the Cassandra Spark connector.", instance="cassandra-1:9042", api="CQL v5",
         fields=[F(name="contact_points", label="Contact points", required=True, placeholder="10.0.0.1,10.0.0.2", help="Tip: enter 'demo'."), F(name="keyspace", label="Keyspace", required=True)],
         auth=[_pw(), A(id="astra_token", label="Astra token", fields=[F(name="token", label="Application token", type="password", secret=True, required=True)])], sandbox_keys=("contact_points",),
         objects=[("sensor_readings", ["sensor_id", "reading_ts", "value", "unit", "status"], 5400000)]),
    dict(id="elasticsearch", name="Elasticsearch", category="nosql", color="#00bfb3", icon="search", ing="batch", cdc=False, obj_label="indices", kind="collection",
         desc="Elasticsearch and OpenSearch indices.", roles=["source", "target"], modes=["append", "overwrite", "merge"], note="Indexes documents with the Elasticsearch Spark connector.",
         instance="es.northwind.io:9243", api="Elasticsearch 8",
         fields=[F(name="url", label="Cluster URL", type="url", required=True, help="Tip: enter 'demo'."), F(name="index_pattern", label="Indices", placeholder="logs-*")],
         auth=[A(id="api_key", label="API key", fields=[F(name="api_key", label="API key", type="password", secret=True, required=True)]), _pw()], sandbox_keys=("url",),
         objects=[("products", ["id", "name", "category", "price", "in_stock", "updated_at"], 14000), ("logs-app", ["@timestamp", "level", "service", "message", "trace_id"], 2800000)]),
]


def _build(e: dict[str, Any]) -> type[SaaSConnector]:
    spec = ConnectorSpec(
        id=e["id"], name=e["name"], category=e["category"], icon=e["icon"], color=e["color"], description=e["desc"],
        auth_methods=e.get("auth", []), config_fields=e.get("fields", []), supports_cdc=e.get("cdc", False),
        recommended_ingestion=e.get("ing", "batch"), availability=e.get("availability", "preview"),
        object_label=e.get("obj_label", "objects"), demo_hint="demo",
        roles=e.get("roles", ["source"]), target_modes=e.get("modes", []), target_note=e.get("note"),
    )
    attrs = {"app": e["id"], "spec": spec, "objects": e["objects"], "instance": e.get("instance"), "api_version": e.get("api"),
             "object_kind": e.get("kind", "object"), "sandbox_keys": ("environment", *e.get("sandbox_keys", ()))}
    return type(f"{e['name'].replace(' ', '').replace('/', '')}Connector", (SaaSConnector,), attrs)


CATALOG_CONNECTORS = [_build(e) for e in ENTRIES]

# ------------------------------------------------------------------ more file locations (same code path as S3/ADLS)
OneLakeConnector = _make_cloud("onelake", "Microsoft OneLake", "#117865", [
    F(name="workspace", label="Fabric workspace", required=True), F(name="bucket", label="Lakehouse / folder", required=True, help=_loc_help)],
    "Files in a Microsoft Fabric lakehouse (OneLake).", [A(id="entra_sp", label="Microsoft Entra ID app", fields=_entra().fields), A(id="managed_identity", label="Managed identity")])
SharePointConnector = _make_cloud("sharepoint", "SharePoint / OneDrive", "#038387", [
    F(name="site_url", label="Site URL", required=True, placeholder="https://company.sharepoint.com/sites/finance"),
    F(name="bucket", label="Document library / folder", required=True, help=_loc_help)],
    "Excel and CSV files in SharePoint document libraries or OneDrive.", [_entra(), OAUTH])
GoogleDriveConnector = _make_cloud("google_drive", "Google Drive", "#1fa463", [
    F(name="bucket", label="Folder ID or shared drive", required=True, help=_loc_help)], "Sheets, Excel and CSV files in Google Drive.", [_gcp(), OAUTH])
BoxConnector = _make_cloud("box", "Box", "#0061d5", [F(name="bucket", label="Folder ID", required=True, help=_loc_help)], "Files stored in Box.", [OAUTH, _entra()])
DropboxConnector = _make_cloud("dropbox", "Dropbox", "#0061fe", [F(name="bucket", label="Folder path", required=True, help=_loc_help)], "Files stored in Dropbox.", [OAUTH])
FtpConnector = _make_cloud("ftp", "FTP / FTPS", "#475569", [
    F(name="host", label="Host", required=True), F(name="port", label="Port", type="number", default=21),
    F(name="tls", label="Use FTPS (TLS)", type="boolean", default=True), F(name="bucket", label="Remote folder", required=True, help=_loc_help)],
    "Files on an FTP or FTPS server.", [_pw()])

STORAGE_CONNECTORS: list[type[CloudStorageConnector]] = [OneLakeConnector, SharePointConnector, GoogleDriveConnector, BoxConnector, DropboxConnector, FtpConnector]
for _c in (GoogleDriveConnector, BoxConnector, DropboxConnector, SharePointConnector, FtpConnector):
    _c.spec.roles = ["source"]
    _c.spec.target_modes = []
    _c.spec.target_note = None
