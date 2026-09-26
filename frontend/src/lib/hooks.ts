"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "./api";
import type { Pipeline, TransformLibrary } from "./types";

export const PIPELINE_UPDATED = "easyetl:pipeline-updated";

export function notifyPipelineUpdated(id: string) {
  window.dispatchEvent(new CustomEvent(PIPELINE_UPDATED, { detail: { id } }));
}

export function showError(e: unknown, fallback = "Something went wrong") {
  const err = e as ApiError;
  toast.error(err?.title ?? fallback, { description: err?.message });
}

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function usePipeline(id: string | null | undefined) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const idRef = useRef(id);
  idRef.current = id;

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const p = await api.get<Pipeline>(`/api/pipelines/${id}`);
      if (idRef.current === id) setPipeline(p);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void reload();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.id || detail.id === id) void reload();
    };
    window.addEventListener(PIPELINE_UPDATED, handler);
    return () => window.removeEventListener(PIPELINE_UPDATED, handler);
  }, [id, reload]);

  /** Run a mutation that returns the updated pipeline. Errors become friendly toasts. */
  const mutate = useCallback(
    async <T extends Partial<Pipeline>>(label: string, fn: () => Promise<T>, opts?: { success?: string; silent?: boolean }): Promise<T | null> => {
      setBusy(label);
      try {
        const res = await fn();
        if (res && (res as Pipeline).metadata) setPipeline(res as unknown as Pipeline);
        if (opts?.success) toast.success(opts.success);
        return res;
      } catch (e) {
        if (!opts?.silent) showError(e);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  return { pipeline, setPipeline, error, loading, reload, mutate, busy };
}

let libraryCache: TransformLibrary | null = null;
export function useTransformLibrary() {
  const [lib, setLib] = useState<TransformLibrary | null>(libraryCache);
  useEffect(() => {
    if (libraryCache) return;
    api.get<TransformLibrary>("/api/transforms").then((l) => {
      libraryCache = l;
      setLib(l);
    }).catch(() => undefined);
  }, []);
  return lib;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
