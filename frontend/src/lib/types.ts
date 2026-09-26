export type Step = "source" | "analyze" | "transform" | "configure" | "design" | "review" | "deploy" | "monitor";
export const STEPS: { id: Step; label: string; hint: string }[] = [
  { id: "source", label: "Source", hint: "Connect data" },
  { id: "analyze", label: "Analyze", hint: "Profile & insights" },
  { id: "transform", label: "Transform", hint: "Cleanse & enrich" },
  { id: "configure", label: "Configure", hint: "Ingestion & settings" },
  { id: "design", label: "Design", hint: "Lakehouse & model" },
  { id: "review", label: "Review", hint: "AI recommendations" },
  { id: "deploy", label: "Deploy", hint: "Create & deploy" },
  { id: "monitor", label: "Monitor", hint: "Health & alerts" },
];

export interface DatasetRef {
  id: string;
  name: string;
  selected: boolean;
  kind: string;
  locator: Record<string, unknown>;
  format?: string | null;
  row_count?: number | null;
  column_count?: number | null;
  size_bytes?: number | null;
  modified_at?: string | null;
  incremental_field?: string | null;
  cdc_capable: boolean;
  columns: { name: string; type?: string; semantic_type?: string }[];
}

export interface SourceConfig {
  category: "file" | "application" | "database" | "cloud_storage" | "api" | "none";
  connector?: string | null;
  name?: string | null;
  connection_id?: string | null;
  config: Record<string, unknown>;
  datasets: DatasetRef[];
  connection_info: { ok?: boolean; title?: string; message?: string; info?: Record<string, unknown>; technical?: string | null; tested_at?: string };
}

export interface ColumnProfile {
  name: string;
  dtype: string;
  semantic_type: string;
  semantic_confidence: number;
  null_count: number;
  null_pct: number;
  is_nested: boolean;
  nested_fields?: string[];
  distinct_count?: number | null;
  unique_pct?: number | null;
  duplicate_values?: number;
  cardinality?: string;
  min_length?: number | null;
  max_length?: number | null;
  avg_length?: number | null;
  top_values?: { value: unknown; count: number; pct: number }[];
  sample_values?: unknown[];
  patterns?: { pattern: string; count: number; pct: number }[];
  pattern_count?: number;
  pattern_consistency?: number;
  invalid_count?: number;
  invalid_pct?: number;
  invalid_examples?: string[];
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  std?: number;
  p25?: number;
  p75?: number;
  negative_count?: number;
  outlier_count?: number;
  outlier_bounds?: [number, number];
  histogram?: { bin: number; count: number }[];
  date_min?: string;
  date_max?: string;
  pii?: { category: string; label: string; sensitivity: string; confidence: number } | null;
  whitespace_issues?: number;
  case_variant_values?: number;
}

export interface Profile {
  dataset_name: string;
  row_count: number;
  profiled_rows: number;
  sampled: boolean;
  column_count: number;
  duplicate_rows: number;
  duplicate_pct: number;
  nested_columns: string[];
  pii_columns: string[];
  columns: ColumnProfile[];
  primary_key_candidates: { column: string; confidence: number; uniqueness_pct: number; duplicates: number; reason: string }[];
  quality: { score: number; completeness: number; validity: number; uniqueness: number; consistency: number };
  schema_hash: string;
  strategy?: string;
}

export interface Insight {
  id: string;
  dataset_id?: string | null;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  detail: string;
  confidence?: number | null;
}

export interface Recommendation {
  id: string;
  area: string;
  title: string;
  reason: string;
  impact: "high" | "medium" | "low";
  confidence: number;
  expected_benefit: string;
  explanation: string;
  dataset_id?: string | null;
  action: { kind: string; transform?: { type: string; params: Record<string, unknown> } };
  status: "pending" | "applied" | "ignored";
  generated_by: string;
  preselected: boolean;
  destructive: boolean;
  affected_rows?: number | null;
  affected_columns: string[];
}

export interface TransformStep {
  id: string;
  type: string;
  dataset_id: string;
  params: Record<string, any>;
  enabled: boolean;
  label?: string | null;
  origin: "user" | "ai" | "template";
  recommendation_id?: string | null;
  created_at: string;
}

export interface IngestionConfig {
  engine: string;
  recommended_engine?: string | null;
  rationale: string;
  mode: "full" | "incremental";
  incremental_field?: string | null;
  cdc: boolean;
  frequency: string;
  schedule_time: string;
  schema_evolution: string;
  file_handling: string;
  partition_by: string[];
  compute: string;
  retries: number;
  retry_delay_minutes: number;
  on_error: string;
  checkpointing: boolean;
  notes: string[];
}

export interface TableDesign {
  id: string;
  layer: "bronze" | "silver" | "gold";
  name: string;
  description: string;
  source_datasets: string[];
  source_tables: string[];
  primary_key: string[];
  partition_by: string[];
  cluster_by: string[];
  columns: { name: string; type?: string }[];
  business_entity?: string | null;
  gold_logic: Record<string, any>;
  retention_days?: number | null;
  enabled: boolean;
}

export interface LakehouseDesign {
  mode: "simple" | "advanced";
  catalog: string;
  bronze_schema: string;
  silver_schema: string;
  gold_schema: string;
  storage_location?: string | null;
  tables: TableDesign[];
  relationships: { from_table: string; from_column: string; to_table: string; to_column: string }[];
  retention_days: number;
  rationale: string[];
}

export interface PiiField {
  dataset_id: string;
  column: string;
  category: string;
  confidence: number;
  action: "tag" | "mask" | "hash" | "tokenize" | "restrict" | "encrypt" | "none";
}

export interface AccessPolicy {
  group: string;
  privilege: string;
  scope: string;
  row_filter?: string | null;
}

export interface GovernanceConfig {
  unity_catalog: boolean;
  catalog: string;
  tags: Record<string, string>;
  pii: PiiField[];
  access_policies: AccessPolicy[];
  audit: boolean;
  lineage: boolean;
  column_masks: boolean;
  data_owner?: string | null;
}

export interface QualityRule {
  id: string;
  dataset_id: string;
  column?: string | null;
  dimension: string;
  rule: string;
  params: Record<string, any>;
  description: string;
  on_fail: "warn" | "drop" | "quarantine" | "fail";
  enabled: boolean;
  origin: "user" | "ai" | "template";
}

export interface HealthCheck {
  ran_at?: string | null;
  ready: boolean;
  score: number;
  checks: { id: string; label: string; status: "pass" | "warn" | "fail" | "info"; message: string; fix?: string | null; details: string[] }[];
}

export interface DeploymentState {
  status: "not_deployed" | "deploying" | "deployed" | "failed";
  mode: "mock" | "databricks";
  target_environment: string;
  workspace_url?: string | null;
  deployed_at?: string | null;
  deployed_version?: number | null;
  resources: { type: string; name: string; id?: string; url?: string; layer?: string; files?: string[] }[];
  log: { step: string; label: string; status: string; at: string; simulated?: boolean }[];
  error?: { step: string; title: string; message: string; technical?: string } | null;
}

export interface PipelineMetadata {
  name: string;
  description: string;
  mode: "simple" | "advanced";
  current_step: Step;
  completed_steps: Step[];
  template_id?: string | null;
  source: SourceConfig;
  analysis: {
    profiled_at?: string | null;
    strategy: string;
    profiles: Record<string, Profile>;
    insights: Insight[];
    relationships: { from_dataset: string; from_column: string; to_dataset: string; to_column: string; match_pct: number; orphan_rows: number; label: string; confidence: number }[];
    entities: Record<string, string>;
    quality_after: Record<string, { rows: number; columns: number; null_pct: number; duplicates: number; invalid_values: number; quality_score: number }>;
  };
  recommendations: Recommendation[];
  transformations: TransformStep[];
  ingestion: IngestionConfig;
  lakehouse: LakehouseDesign;
  governance: GovernanceConfig;
  quality_rules: QualityRule[];
  health_check: HealthCheck;
  deployment: DeploymentState;
  history: { at: string; event: string; [k: string]: unknown }[];
}

export interface PipelineSummary {
  id: string;
  name: string;
  status: string;
  environment: string;
  version: number;
  created_at: string;
  updated_at: string;
  source_label: string;
  source_connector?: string | null;
  source_category?: string;
  source_format?: string | null;
  dataset_count: number;
  target_label: string;
  current_step: Step;
  completed_steps: Step[];
  mode: "simple" | "advanced";
  deployment_status: string;
  deployment_mode: string;
  quality_score?: number | null;
  frequency: string;
  ingestion_engine?: string;
  last_run?: Run | null;
  next_run?: string | null;
  records_processed?: number;
}

export interface Pipeline extends PipelineSummary {
  metadata: PipelineMetadata;
}

export interface Run {
  id: string;
  status: string;
  started_at: string;
  duration_seconds: number;
  records_ingested: number;
  failed_records: number;
  quality_score: number;
  cost_usd: number;
  storage_gb: number;
  schema_hash: string;
  details: { layers?: Record<string, number>; error?: { title: string; message: string; technical?: string }; schema_change?: { added: string[] } };
}

export interface Alert {
  id: string;
  kind: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  recommendation: string;
  metric?: string | null;
  change_pct?: number | null;
  detected_at?: string;
  pipeline_id?: string;
  pipeline_name?: string;
}

export interface FieldSpec {
  name: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "boolean" | "textarea" | "keyvalue" | "url";
  required: boolean;
  secret: boolean;
  placeholder?: string | null;
  default?: unknown;
  options: { value: string; label: string }[];
  help?: string | null;
  advanced: boolean;
}

export interface ConnectorSpec {
  id: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  color: string;
  auth_methods: { id: string; label: string; fields: FieldSpec[] }[];
  config_fields: FieldSpec[];
  supports_incremental: boolean;
  supports_cdc: boolean;
  recommended_ingestion: string;
  availability: "ga" | "preview" | "sandbox";
  object_label: string;
  demo_hint?: string | null;
}

export interface ParamSpec {
  name: string;
  label: string;
  type: string;
  required: boolean;
  default?: any;
  options: { value: string; label: string }[];
  column_kind: "any" | "text" | "numeric" | "date" | "nested";
  help?: string | null;
  advanced: boolean;
  placeholder?: string | null;
}

export interface TransformSpec {
  id: string;
  category: string;
  label: string;
  description: string;
  icon: string;
  params: ParamSpec[];
  row_preserving: boolean;
  destructive: boolean;
  multi_dataset: boolean;
  keywords: string[];
}

export interface TransformLibrary {
  categories: { id: string; label: string; icon: string }[];
  transforms: TransformSpec[];
  functions: { name: string; label: string; args: number; group: string }[];
  operators: string[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  semantic_type?: string | null;
  kind: "text" | "numeric" | "date" | "nested";
}

export interface PreviewMetrics {
  rows: number;
  columns: number;
  null_pct: number;
  null_cells: number;
  duplicates: number;
  invalid_values: number;
  quality_score: number;
  quality?: { score: number; completeness: number; validity: number; uniqueness: number; consistency: number };
  invalid_by_type?: Record<string, { invalid: number; values: number; pct: number }>;
  format_columns?: { consistent: number; total: number };
}

export interface Preview {
  before: { columns: { name: string; type: string }[]; rows: Record<string, any>[]; metrics: PreviewMetrics };
  after: { columns: { name: string; type: string }[]; rows: Record<string, any>[]; metrics: PreviewMetrics };
  changes: {
    added_columns: string[];
    removed_columns: string[];
    changed_columns: Record<string, number>;
    changed_cells: number;
    rows_removed: number;
    rows_added: number;
    aligned: boolean;
    removed_row_ids: number[];
    changed_row_ids: number[];
    changed_cells_sample?: { row_id: number; column: string }[];
  };
  step_results: { step_id: string; status: string; message?: string; technical?: string }[];
  error?: { step_id: string; status: string; message?: string; technical?: string } | null;
}

export interface AssistantReply {
  answer: string;
  facts: string[];
  action?: { kind: string; dataset_id: string; transform: { type: string; params: Record<string, any> }; label: string } | null;
  suggestions: string[];
  provider: string;
}
