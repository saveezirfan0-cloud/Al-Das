"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { createWorkspace, type OnboardingState } from "./actions";

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState<OnboardingState, FormData>(
    createWorkspace,
    undefined,
  );
  const [slug, setSlug] = useState("");
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="name">Workspace name</Label>
        <Input
          id="name"
          name="name"
          placeholder="Al Das Medical"
          required
          onChange={(e) => setSlug(slugify(e.target.value))}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="slug">Short name</Label>
        <Input
          id="slug"
          name="slug"
          value={slug}
          onChange={(e) => setSlug(slugify(e.target.value))}
          placeholder="al-das"
          required
        />
      </div>
      {state?.error && (
        <p className="text-destructive text-sm" role="alert">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending && <Loader2 className="animate-spin" />}
        Create workspace
      </Button>
    </form>
  );
}
