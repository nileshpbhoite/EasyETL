"use client";

import { Bot, LoaderCircle, Send, Sparkles, Wand, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { notifyPipelineUpdated, showError } from "@/lib/hooks";
import { useUI } from "@/lib/store";
import type { AssistantReply } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui";

interface Msg {
  role: "user" | "assistant";
  text: string;
  reply?: AssistantReply;
}

/** Minimal, safe markdown: **bold**, *italic*, line breaks and "- " bullets. */
export function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  const inline = (s: string, key: number) => {
    const parts = s.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
    return (
      <span key={key}>
        {parts.map((p, i) =>
          p.startsWith("**") ? (
            <strong key={i} className="font-semibold text-slate-900">
              {p.slice(2, -2)}
            </strong>
          ) : p.startsWith("*") && p.length > 2 ? (
            <em key={i}>{p.slice(1, -1)}</em>
          ) : (
            p
          ),
        )}
      </span>
    );
  };
  return (
    <div className="space-y-1.5">
      {lines.map((l, i) => {
        if (!l.trim()) return null;
        const m = l.match(/^(\s*)(-|\d+\.)\s+(.*)$/);
        if (m)
          return (
            <div key={i} className={cn("flex gap-2", m[1].length > 0 && "pl-4")}>
              <span className="text-slate-400">{m[2] === "-" ? "•" : m[2]}</span>
              <span>{inline(m[3], i)}</span>
            </div>
          );
        return <p key={i}>{inline(l, i)}</p>;
      })}
    </div>
  );
}

export function AssistantChat({ compact = false }: { compact?: boolean }) {
  const { assistantContext, setAssistantContext } = useUI();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pid = assistantContext.pipelineId;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const ask = async (question: string) => {
    if (!question.trim()) return;
    setMessages((m) => [...m, { role: "user", text: question }]);
    setInput("");
    setLoading(true);
    try {
      const body = { question, page: assistantContext.page, dataset_id: assistantContext.datasetId, recommendation_id: assistantContext.recommendationId };
      const reply = pid ? await api.post<AssistantReply>(`/api/pipelines/${pid}/assistant`, body) : await api.post<AssistantReply>("/api/assistant", { question });
      setMessages((m) => [...m, { role: "assistant", text: reply.answer, reply }]);
      if (assistantContext.recommendationId) setAssistantContext({ ...assistantContext, recommendationId: undefined });
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: "I couldn't answer that right now. Please try again." }]);
      showError(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (assistantContext.question) {
      const q = assistantContext.question;
      setAssistantContext({ ...assistantContext, question: undefined });
      void ask(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantContext.question]);

  const apply = async (i: number, reply: AssistantReply) => {
    if (!reply.action || !pid) return;
    setApplying(i);
    try {
      await api.post(`/api/pipelines/${pid}/transformations`, { dataset_id: reply.action.dataset_id, type: reply.action.transform.type, params: reply.action.transform.params, label: reply.action.label });
      toast.success("Added to your pipeline", { description: reply.action.label });
      notifyPipelineUpdated(pid);
    } catch (e) {
      showError(e);
    } finally {
      setApplying(null);
    }
  };

  const suggestions = messages.length ? messages[messages.length - 1].reply?.suggestions ?? [] : pid
    ? ["Why is Customer_ID considered the primary key?", "Show me which columns contain duplicates.", "Create a customer age column.", "Why did you choose Auto Loader?"]
    : ["Which pipelines need attention?", "How do I start?"];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className={cn("flex-1 space-y-4 overflow-y-auto px-4 py-4 scrollbar-thin", compact && "px-3")}>
        {messages.length === 0 && (
          <div className="rounded-xl ai-surface p-4 text-sm text-slate-700 ring-1 ring-ai-100">
            <div className="mb-1 flex items-center gap-2 font-semibold text-ai-800">
              <Sparkles className="size-4" /> I understand your pipeline
            </div>
            {pid ? "Ask about your data, the recommendations, ingestion or cost. I answer from the actual profile and configuration of this pipeline." : "Open a pipeline for data-specific answers, or ask me about your workspace."}
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-8 rounded-2xl rounded-br-sm bg-brand-600 px-3.5 py-2 text-sm text-white">
              {m.text}
            </div>
          ) : (
            <div key={i} className="flex gap-2.5">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full gradient-ai text-white">
                <Bot className="size-4" />
              </div>
              <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-slate-700 shadow-card">
                <RichText text={m.text} />
                {m.reply?.facts && m.reply.facts.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {m.reply.facts.map((f) => (
                      <span key={f} className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
                {m.reply?.action && (
                  <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-ai-50 p-2 ring-1 ring-ai-100">
                    <div className="flex items-center gap-2 text-xs font-medium text-ai-800">
                      <Wand className="size-3.5" /> {m.reply.action.label}
                    </div>
                    <Button size="sm" variant="ai" loading={applying === i} onClick={() => apply(i, m.reply!)}>
                      Apply
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ),
        )}
        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <LoaderCircle className="size-4 animate-spin text-ai-600" /> Analyzing your pipeline…
          </div>
        )}
      </div>
      <div className="border-t border-slate-100 p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {suggestions.slice(0, 3).map((s) => (
            <button key={s} onClick={() => ask(s)} className="rounded-full border border-ai-200 bg-ai-50/60 px-2.5 py-1 text-[11.5px] text-ai-700 hover:bg-ai-100">
              {s}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything about your data…"
            className="h-10 flex-1 rounded-xl border border-slate-200 px-3 text-sm focus:border-ai-300 focus:outline-none focus:ring-2 focus:ring-ai-100"
          />
          <Button type="submit" variant="ai" size="icon" className="h-10 w-10" disabled={!input.trim() || loading} aria-label="Send">
            <Send />
          </Button>
        </form>
      </div>
    </div>
  );
}

export function AssistantPanel() {
  const { assistantOpen, closeAssistant, assistantContext } = useUI();
  return (
    <aside
      className={cn(
        "fixed inset-y-0 right-0 z-40 flex w-[420px] max-w-full flex-col border-l border-slate-200 bg-slate-50/95 shadow-2xl backdrop-blur transition-transform duration-300",
        assistantOpen ? "translate-x-0" : "translate-x-full",
      )}
      aria-hidden={!assistantOpen}
    >
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg gradient-ai text-white">
            <Sparkles className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">AI Assistant</div>
            <div className="text-[11px] text-slate-500">{assistantContext.pipelineId ? `Context: ${assistantContext.page ?? "pipeline"}` : "Workspace context"}</div>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={closeAssistant} aria-label="Close assistant">
          <X />
        </Button>
      </div>
      {assistantOpen && <AssistantChat />}
    </aside>
  );
}
