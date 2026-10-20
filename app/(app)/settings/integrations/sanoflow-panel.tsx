"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  addSanoflowNumber,
  addSanoflowTemplate,
  setSanoflowTemplateNumber,
} from "./sanoflow-actions";

type NumberRow = { id: string; name: string; displayPhone: string | null; status: string };
type TemplateRow = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  sanoflowTemplateId: number | null;
};

const selectClass =
  "border-input bg-background h-9 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** Settings, Integrations, Sanoflow (OQ-182): the Sanoflow numbers, the template links and the reply webhook. */
export function SanoflowPanel({
  numbers,
  templates,
  webhookUrl,
  canManage,
  canManageTemplates,
}: {
  numbers: NumberRow[];
  templates: TemplateRow[];
  webhookUrl: string | null;
  canManage: boolean;
  canManageTemplates: boolean;
}) {
  return (
    <>
      <NumbersCard numbers={numbers} canManage={canManage} />
      <TemplatesCard numbers={numbers} templates={templates} canManage={canManageTemplates} />
      <Card>
        <CardHeader>
          <CardTitle>Replies and bookings from Sanoflow</CardTitle>
          <CardDescription>
            Patients reply in Sanoflow, so Pulse does not see the reply itself. To keep the recall
            call list right, add an API Action to the Sanoflow flow (the one that called
            Make&rsquo;s &ldquo;Chronic Update&rdquo;) that posts to this address.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {webhookUrl ? (
            <code className="bg-muted block overflow-x-auto rounded px-2 py-1 text-xs whitespace-pre">
              POST {webhookUrl}
            </code>
          ) : (
            <p className="text-muted-foreground">Save the settings first to get the address.</p>
          )}
          <p className="text-muted-foreground text-xs">
            Header <code>x-pulse-token</code>: the webhook token saved above. Body (JSON):{" "}
            <code>{'{"Mobile": "<patient number>", "Status": "Replied"}'}</code> or{" "}
            <code>&quot;Booked&quot;</code>, as Make received it. Pulse credits the patient&rsquo;s
            newest open recall message; anything else in the body is ignored.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function NumbersCard({ numbers, canManage }: { numbers: NumberRow[]; canManage: boolean }) {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [rate, setRate] = useState("5");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sanoflow numbers</CardTitle>
        <CardDescription>
          The clinic&rsquo;s WhatsApp number as it is set up in Sanoflow. Pulse&rsquo;s reminders,
          recall, flows and campaigns use it like any other number, and their templates go out
          through Sanoflow. It cannot be used for Meta features (template sync, media, the Inbox
          reply box).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {numbers.length === 0 ? (
          <p className="text-muted-foreground text-sm">No Sanoflow number yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {numbers.map((n) => (
              <li key={n.id}>
                {n.name}
                {n.displayPhone ? ` (${n.displayPhone})` : ""}
                {n.status !== "active" ? ` · ${n.status}` : ""}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="grid max-w-xl gap-3 sm:grid-cols-3">
            <div className="grid gap-1 sm:col-span-1">
              <Label htmlFor="sf-num-name">Name</Label>
              <Input
                id="sf-num-name"
                value={name}
                maxLength={80}
                placeholder="Al Das main"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="sf-num-phone">Clinic number</Label>
              <Input
                id="sf-num-phone"
                value={phone}
                maxLength={32}
                placeholder="+971 4 …"
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="sf-num-rate">Messages per second</Label>
              <Input
                id="sf-num-rate"
                type="number"
                min={1}
                max={20}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
            <div className="sm:col-span-3">
              <Button
                disabled={pending || !name.trim()}
                onClick={() =>
                  start(async () => {
                    const r = await addSanoflowNumber({
                      name,
                      displayPhone: phone,
                      sendRatePerSec: Number(rate) || 5,
                    });
                    if (r.ok) {
                      toast.success(r.message);
                      setName("");
                      setPhone("");
                    } else toast.error(r.error);
                  })
                }
              >
                {pending && <Loader2 className="animate-spin" aria-hidden />} Add Sanoflow number
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TemplatesCard({
  numbers,
  templates,
  canManage,
}: {
  numbers: NumberRow[];
  templates: TemplateRow[];
  canManage: boolean;
}) {
  const [pending, start] = useTransition();
  const [links, setLinks] = useState<Record<string, string>>(
    Object.fromEntries(templates.map((t) => [t.id, t.sanoflowTemplateId?.toString() ?? ""])),
  );
  const [draft, setDraft] = useState({
    channelId: numbers[0]?.id ?? "",
    name: "",
    language: "en",
    category: "UTILITY",
    body: "",
    number: "",
    approved: false,
  });

  const saveLink = (id: string) =>
    start(async () => {
      const raw = (links[id] ?? "").trim();
      const r = await setSanoflowTemplateNumber({
        templateId: id,
        sanoflowTemplateId: raw ? Number(raw) : null,
      });
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sanoflow templates</CardTitle>
        <CardDescription>
          Each template Pulse sends through Sanoflow needs Sanoflow&rsquo;s template number (for
          example 11885 for the appointment reminder). Variables are sent in order: {"{{1}}"},{" "}
          {"{{2}}"}, … Templates with header or button variables cannot be sent through Sanoflow.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {templates.length === 0 ? (
          <p className="text-muted-foreground text-sm">No approved templates yet. Add one below.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-left">
                  <th className="py-1 pr-3 font-medium">Template</th>
                  <th className="py-1 pr-3 font-medium">Category</th>
                  <th className="py-1 pr-3 font-medium">Sanoflow number</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id} className="border-t">
                    <td className="py-1 pr-3">
                      {t.name} <span className="text-muted-foreground">({t.language})</span>
                    </td>
                    <td className="py-1 pr-3">{t.category}</td>
                    <td className="py-1 pr-3">
                      <Input
                        aria-label={`Sanoflow number for ${t.name}`}
                        className="h-8 w-28"
                        inputMode="numeric"
                        disabled={!canManage}
                        value={links[t.id] ?? ""}
                        onChange={(e) =>
                          setLinks((v) => ({ ...v, [t.id]: e.target.value.replace(/\D/g, "") }))
                        }
                      />
                    </td>
                    <td className="py-1">
                      {canManage && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => saveLink(t.id)}
                        >
                          Save
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canManage && (
          <div className="flex max-w-xl flex-col gap-3 border-t pt-4">
            <p className="text-sm font-medium">Add a template that is approved in Sanoflow</p>
            {numbers.length === 0 ? (
              <p className="text-muted-foreground text-sm">Add a Sanoflow number first.</p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <Label htmlFor="sf-t-channel">Number</Label>
                    <select
                      id="sf-t-channel"
                      className={selectClass}
                      value={draft.channelId}
                      onChange={(e) => setDraft((d) => ({ ...d, channelId: e.target.value }))}
                    >
                      {numbers.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="sf-t-number">Sanoflow template number</Label>
                    <Input
                      id="sf-t-number"
                      inputMode="numeric"
                      value={draft.number}
                      placeholder="11885"
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, number: e.target.value.replace(/\D/g, "") }))
                      }
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="sf-t-name">Name (as in Sanoflow)</Label>
                    <Input
                      id="sf-t-name"
                      value={draft.name}
                      placeholder="appointment_reminder"
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1">
                      <Label htmlFor="sf-t-lang">Language</Label>
                      <Input
                        id="sf-t-lang"
                        value={draft.language}
                        onChange={(e) => setDraft((d) => ({ ...d, language: e.target.value }))}
                      />
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor="sf-t-cat">Category</Label>
                      <select
                        id="sf-t-cat"
                        className={selectClass}
                        value={draft.category}
                        onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                      >
                        <option value="UTILITY">Utility</option>
                        <option value="MARKETING">Marketing</option>
                      </select>
                    </div>
                  </div>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="sf-t-body">Body text</Label>
                  <Textarea
                    id="sf-t-body"
                    rows={4}
                    maxLength={1024}
                    value={draft.body}
                    placeholder={
                      "Dear {{1}}, this is a reminder of your appointment tomorrow at {{2}} with {{3}}."
                    }
                    onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                  />
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="sf-t-approved"
                    checked={draft.approved}
                    onCheckedChange={(v) => setDraft((d) => ({ ...d, approved: v === true }))}
                  />
                  <Label htmlFor="sf-t-approved" className="text-sm font-normal">
                    This template is approved in Sanoflow, and the text above is exactly what it
                    says.
                  </Label>
                </div>
                <div>
                  <Button
                    disabled={
                      pending || !draft.approved || !draft.name || !draft.body || !draft.number
                    }
                    onClick={() =>
                      start(async () => {
                        const r = await addSanoflowTemplate({
                          channelId: draft.channelId,
                          name: draft.name,
                          language: draft.language,
                          category: draft.category,
                          body: draft.body,
                          sanoflowTemplateId: Number(draft.number),
                          approvedInSanoflow: true,
                        });
                        if (r.ok) {
                          toast.success(r.message);
                          setDraft((d) => ({
                            ...d,
                            name: "",
                            body: "",
                            number: "",
                            approved: false,
                          }));
                        } else toast.error(r.error);
                      })
                    }
                  >
                    {pending && <Loader2 className="animate-spin" aria-hidden />} Add template
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
