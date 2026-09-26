import {
  ArrowDownUp, Binary, Brain, Calendar, CircleDashed, Columns3, Copy, Database, Filter, Globe, Hash, Lock, Merge, ShieldCheck, Sigma, Sparkles,
  SquareFunction, Table, TextCursorInput, Wand, type LucideIcon,
} from "lucide-react";

export const CAT_ICON: Record<string, LucideIcon> = {
  clean: Sparkles, types: Binary, text: TextCursorInput, datetime: Calendar, missing: CircleDashed, duplicates: Copy, filter: Filter, join: Merge,
  aggregate: Sigma, pivot: Table, schema: Columns3, derived: SquareFunction, enrich: Globe, quality: ShieldCheck, pii: Lock,
};

/** Library categories as presented to users (backend categories plus curated groups). */
export const UI_CATS: { id: string; label: string; icon: LucideIcon; cats?: string[]; ids?: string[] }[] = [
  { id: "clean", label: "Cleanse & Standardize", icon: Sparkles, cats: ["clean"] },
  { id: "types", label: "Data Types", icon: Binary, cats: ["types"] },
  { id: "text", label: "Text Transformations", icon: TextCursorInput, cats: ["text"] },
  { id: "datetime", label: "Date & Time", icon: Calendar, cats: ["datetime"] },
  { id: "numeric", label: "Numeric Transformations", icon: Hash, ids: ["clip_outliers", "classify_ranges", "currency_conversion", "fill_zero", "window"] },
  { id: "missing", label: "Null & Missing Value Handling", icon: CircleDashed, cats: ["missing"] },
  { id: "duplicates", label: "Duplicate Handling", icon: Copy, cats: ["duplicates"] },
  { id: "filter", label: "Filtering & Sorting", icon: ArrowDownUp, cats: ["filter"] },
  { id: "join", label: "Joins & Merge", icon: Merge, cats: ["join"] },
  { id: "aggregate", label: "Aggregation", icon: Sigma, cats: ["aggregate"] },
  { id: "pivot", label: "Pivot & Unpivot", icon: Table, cats: ["pivot"] },
  { id: "schema", label: "Schema & Structure", icon: Columns3, cats: ["schema"] },
  { id: "enrich", label: "Enrichments", icon: Globe, cats: ["enrich"] },
  { id: "quality", label: "Data Quality", icon: ShieldCheck, cats: ["quality"] },
  { id: "pii", label: "PII & Governance", icon: Lock, cats: ["pii"] },
  { id: "ai", label: "AI Powered", icon: Brain, ids: ["smart_impute", "fuzzy_duplicates", "fuzzy_join", "standardize_values", "survivorship"] },
  { id: "custom", label: "Custom Transformations", icon: SquareFunction, cats: ["derived"] },
];

export const STAGES: { id: string; label: string; icon: LucideIcon; cats: string[]; unit: string }[] = [
  { id: "clean", label: "Clean & Standardize", icon: Sparkles, cats: ["clean", "types", "text", "datetime", "missing", "duplicates"], unit: "transformation" },
  { id: "enrich", label: "Enrich & Derive", icon: Database, cats: ["derived", "enrich"], unit: "transformation" },
  { id: "filter", label: "Filter & Validate", icon: Filter, cats: ["filter", "quality"], unit: "rule" },
  { id: "join", label: "Join / Merge", icon: Merge, cats: ["join"], unit: "join" },
  { id: "shape", label: "Select & Rename", icon: Columns3, cats: ["schema", "pivot", "aggregate"], unit: "step" },
  { id: "protect", label: "Protect PII", icon: Lock, cats: ["pii"], unit: "column rule" },
];

export const Fallback = Wand;
