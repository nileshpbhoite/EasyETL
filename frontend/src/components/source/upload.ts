"use client";

import { api, getToken } from "@/lib/api";
import type { Pipeline } from "@/lib/types";

export interface FileAsset {
  id: string;
  filename: string;
  size_bytes: number;
  detection: {
    filename: string;
    format: string;
    format_label: string;
    size_bytes: number;
    encoding?: string | null;
    compression?: string | null;
    structure: string;
    delimiter?: string;
    summary: string[];
    profiling_strategy?: string;
    entries: { name: string; kind: string; format: string; row_count?: number | null; column_count?: number; columns?: string[]; nested?: boolean; supported?: boolean; size_bytes?: number | null }[];
  };
}

const LARGE_FILE = 50 * 1024 * 1024;

/** Small files go through the API; large files are streamed straight to object storage via a pre-signed URL. */
export async function uploadFile(file: File, onProgress?: (pct: number) => void): Promise<FileAsset> {
  if (file.size > LARGE_FILE) {
    const presigned = await api.post<{ url: string; key: string; method: string }>("/api/files/presign", { filename: file.name, size_bytes: file.size });
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(presigned.method, presigned.url);
      const token = getToken();
      if (token && presigned.url.startsWith("/")) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (e) => onProgress?.(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error("Upload failed")));
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(file);
    });
    return api.post<FileAsset>("/api/files/complete", { key: presigned.key, filename: file.name });
  }
  const form = new FormData();
  form.append("file", file);
  onProgress?.(30);
  const asset = await api.upload<FileAsset>("/api/files", form);
  onProgress?.(100);
  return asset;
}

export async function createPipelineFromFiles(files: File[]): Promise<string> {
  const p = await api.post<Pipeline>("/api/pipelines", { name: "Untitled pipeline" });
  const assets = [];
  for (const f of files) assets.push(await uploadFile(f));
  await api.post(`/api/pipelines/${p.id}/source`, { connector: "file_upload", file_ids: assets.map((a) => a.id) });
  return p.id;
}
