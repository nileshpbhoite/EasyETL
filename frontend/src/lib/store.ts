"use client";

import { create } from "zustand";

interface AssistantContext {
  pipelineId?: string;
  page?: string;
  datasetId?: string;
  recommendationId?: string;
  question?: string;
}

interface UIState {
  assistantOpen: boolean;
  assistantContext: AssistantContext;
  environment: string;
  openAssistant: (ctx?: AssistantContext) => void;
  closeAssistant: () => void;
  setAssistantContext: (ctx: AssistantContext) => void;
  setEnvironment: (env: string) => void;
}

export const useUI = create<UIState>((set) => ({
  assistantOpen: false,
  assistantContext: {},
  environment: "development",
  openAssistant: (ctx) => set((s) => ({ assistantOpen: true, assistantContext: { ...s.assistantContext, ...(ctx ?? {}) } })),
  closeAssistant: () => set({ assistantOpen: false }),
  setAssistantContext: (ctx) => set({ assistantContext: ctx }),
  setEnvironment: (environment) => set({ environment }),
}));
