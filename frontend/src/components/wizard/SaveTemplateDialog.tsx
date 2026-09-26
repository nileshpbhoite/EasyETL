"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button, Dialog, Field, Input, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { showError } from "@/lib/hooks";

export function SaveTemplateDialog({ id, open, onOpenChange, defaultName }: { id: string; open: boolean; onOpenChange: (v: boolean) => void; defaultName: string }) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/api/pipelines/${id}/save-template`, { name, description, category: "Custom" });
      toast.success("Saved as template", { description: "Your team can now start pipelines from it." });
      onOpenChange(false);
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Save as Template" description="Saves transformation patterns, ingestion, Lakehouse, governance and quality settings — never data or credentials." size="sm"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={!name}>Save template</Button></>}>
      <div className="space-y-4">
        <Field label="Template name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this template good for?" /></Field>
      </div>
    </Dialog>
  );
}

