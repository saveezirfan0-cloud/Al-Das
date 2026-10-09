import type { PortalObjectDef } from "@/lib/portal/types";

export const WEBSITE_ENTRY_POINTS: PortalObjectDef = {
  key: "website_entry_points",
  label: "Website entry points",
  icon: "globe",
  description:
    "wa.me entry points on the website: which pre-filled message routes to which team or schedule.",
  table: "website_entry_points",
  titleColumn: "source_key",
  sourceAirtable: "appkOnjPr1SMD83CP.tblpWst9QqYNuKpwZ",
  readPerm: "portal.website_entry_points.read",
  writePerm: "portal.website_entry_points.write",
  sort: 70,
  allowCreate: true,
  allowDelete: true,
  defaultSort: [{ field: "priority_key", dir: "asc" }],
  searchColumns: ["section", "source_key", "route_to", "prefill_message"],
  columns: [
    { key: "section", label: "Section", type: "text", required: true, maxLength: 120 },
    { key: "source_key", label: "Source", type: "text", required: true, maxLength: 300 },
    { key: "route_to", label: "Route to", type: "text", maxLength: 200 },
    { key: "priority_key", label: "Priority", type: "text", maxLength: 120 },
    { key: "is_dynamic", label: "Dynamic message", type: "boolean" },
    {
      key: "channel_phone",
      label: "Clinic number",
      type: "text",
      maxLength: 40,
      defaultHidden: true,
    },
    { key: "prefill_message", label: "Pre-filled message", type: "long_text", maxLength: 1000 },
  ],
};
