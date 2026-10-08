"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import { CONTACT_SOURCES, GENDERS } from "@/lib/contacts/fields";

import { CustomFieldInput } from "./custom-field-input";

export type ContactFormValues = {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  gender: string;
  nationality: string;
  country: string;
  language: string;
  dob: string;
  label: string;
  owner_id: string;
  assignee_id: string;
  source: string;
  external_id: string;
  promotions_opt_in: boolean;
  stop_marketing: boolean;
  custom: Record<string, unknown>;
};

export const EMPTY_CONTACT_FORM: ContactFormValues = {
  first_name: "",
  last_name: "",
  phone: "",
  email: "",
  gender: "",
  nationality: "",
  country: "",
  language: "",
  dob: "",
  label: "",
  owner_id: "",
  assignee_id: "",
  source: "manual",
  external_id: "",
  promotions_opt_in: false,
  stop_marketing: false,
  custom: {},
};

const NONE = "__none__";

/** Converts form values into the server action input (empty strings → null). */
export function toContactInput(v: ContactFormValues) {
  const s = (x: string) => (x.trim() === "" ? null : x.trim());
  return {
    first_name: v.first_name,
    last_name: v.last_name,
    phone: s(v.phone),
    email: s(v.email),
    gender: v.gender || null,
    nationality: s(v.nationality),
    country: s(v.country)?.toUpperCase() ?? null,
    language: s(v.language),
    dob: s(v.dob),
    label: s(v.label),
    owner_id: v.owner_id || null,
    assignee_id: v.assignee_id || null,
    source: v.source || undefined,
    external_id: s(v.external_id),
    promotions_opt_in: v.promotions_opt_in,
    stop_marketing: v.stop_marketing,
    custom: v.custom,
  };
}

export function ContactForm({
  value,
  onChange,
  users,
  customFields,
  idPrefix = "c",
}: {
  value: ContactFormValues;
  onChange: (v: ContactFormValues) => void;
  users: Array<{ id: string; label: string }>;
  customFields: CustomFieldDef[];
  idPrefix?: string;
}) {
  const set = <K extends keyof ContactFormValues>(k: K, v: ContactFormValues[K]) => onChange({ ...value, [k]: v });
  const text = (k: keyof ContactFormValues, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${idPrefix}-${k}`}>{label}</Label>
      <Input id={`${idPrefix}-${k}`} value={String(value[k] ?? "")} onChange={(e) => set(k, e.target.value as never)} {...props} />
    </div>
  );
  const userSelect = (k: "owner_id" | "assignee_id", label: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${idPrefix}-${k}`}>{label}</Label>
      <Select value={value[k] || NONE} onValueChange={(v) => set(k, v === NONE ? "" : v)}>
        <SelectTrigger id={`${idPrefix}-${k}`} className="w-full">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>—</SelectItem>
          {users.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {text("first_name", "First name", { required: true, autoComplete: "off" })}
      {text("last_name", "Last name", { autoComplete: "off" })}
      {text("phone", "Phone", { placeholder: "+971 50 123 4567", inputMode: "tel" })}
      {text("email", "Email", { type: "email" })}
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-gender`}>Gender</Label>
        <Select value={value.gender || NONE} onValueChange={(v) => set("gender", v === NONE ? "" : v)}>
          <SelectTrigger id={`${idPrefix}-gender`} className="w-full">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {GENDERS.map((g) => (
              <SelectItem key={g} value={g}>
                {g[0].toUpperCase() + g.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {text("dob", "Date of birth", { type: "date" })}
      {text("nationality", "Nationality")}
      {text("country", "Country (ISO-2)", { maxLength: 2, placeholder: "AE" })}
      {text("language", "Language", { placeholder: "en / ar" })}
      {text("label", "Label")}
      {userSelect("owner_id", "Contact owner")}
      {userSelect("assignee_id", "Assignee")}
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-source`}>Source</Label>
        <Select value={value.source || "manual"} onValueChange={(v) => set("source", v)}>
          <SelectTrigger id={`${idPrefix}-source`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONTACT_SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {text("external_id", "External ID (Unite PIN)")}
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={value.promotions_opt_in} onCheckedChange={(v) => set("promotions_opt_in", !!v)} /> Promotions opt-in
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={value.stop_marketing} onCheckedChange={(v) => set("stop_marketing", !!v)} /> Stop marketing
      </label>
      {customFields.length > 0 && (
        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
          <h4 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase sm:col-span-2">Custom fields</h4>
          {customFields.map((f) => (
            <div key={f.key} className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-custom-${f.key}`}>
                {f.label}
                {f.required && <span className="text-destructive"> *</span>}
              </Label>
              <CustomFieldInput id={`${idPrefix}-custom-${f.key}`} def={f} value={value.custom[f.key]} onChange={(v) => set("custom", { ...value.custom, [f.key]: v })} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
