import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Client components talk to the router and server actions; for a static render they only need to exist.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/app/(app)/settings/ai-copilots/actions", () => ({
  saveIntentDetection: async () => ({ ok: true, message: "" }),
  enableTagFlows: async () => ({ ok: true, message: "" }),
  disableTagFlows: async () => ({ ok: true, message: "" }),
}));
vi.mock("@/app/(app)/flows/ai-actions", () => ({
  draftFlowWithAi: async () => ({ ok: false, error: "x" }),
  dryRunFlow: async () => ({ ok: false, error: "x" }),
  markAiFlowReviewed: async () => ({ ok: true }),
}));
vi.mock("@/app/(app)/campaigns/ai-actions", () => ({
  previewAiAudience: async () => ({ ok: false, error: "x" }),
  saveAiAudienceSegment: async () => ({ ok: false, error: "x" }),
  suggestTemplateCopy: async () => ({ ok: false, error: "x" }),
  saveAiTemplateDraft: async () => ({ ok: false, error: "x" }),
}));

import { AiCopilotsSettings } from "@/app/(app)/settings/ai-copilots/ai-copilots-settings";
import { CopilotWorkspace } from "@/app/(app)/campaigns/copilot/copilot-workspace";
import { TAG_FLOWS_CONFIRM_PHRASE } from "@/lib/ai/copilot/settings";

const base = {
  aiEnabled: true,
  intentDetection: true,
  tagFlows: { enabled: false, tags: [] as never[], signed_at: null, signedByName: null },
  usage: {},
};

describe("AI copilots settings", () => {
  it("explains that emergency wording is always on, and warns when AI is off", () => {
    const html = renderToStaticMarkup(
      <AiCopilotsSettings
        {...base}
        aiEnabled={false}
        intentDetection={false}
        canAdmin
        canSign={false}
      />,
    );
    expect(html).toContain("Emergency wording");
    expect(html).toContain("Always on, with or without AI");
    expect(html).toContain("AI assist is off for this workspace");
  });

  it("shows the typed-confirmation approval only to the clinical lead, and never offers the emergency tag", () => {
    const lead = renderToStaticMarkup(<AiCopilotsSettings {...base} canAdmin={false} canSign />);
    expect(lead).toContain(TAG_FLOWS_CONFIRM_PHRASE);
    expect(lead).toContain("Wants to book");
    expect(lead).not.toContain("Possible emergency</label>");
    const admin = renderToStaticMarkup(<AiCopilotsSettings {...base} canAdmin canSign={false} />);
    expect(admin).not.toContain(TAG_FLOWS_CONFIRM_PHRASE);
    expect(admin).toContain("clinical lead");
  });

  it("shows who approved and when once approved", () => {
    const html = renderToStaticMarkup(
      <AiCopilotsSettings
        {...base}
        canAdmin
        canSign
        tagFlows={{
          enabled: true,
          tags: ["booking"],
          signed_at: "2026-10-17T10:00:00Z",
          signedByName: "Dr Example",
        }}
      />,
    );
    expect(html).toContain("Approved for: Wants to book by Dr Example");
    expect(html).toContain("Withdraw the approval");
  });
});

describe("Campaign Copilot workspace", () => {
  it("promises a draft only and shows both halves", () => {
    const html = renderToStaticMarkup(
      <CopilotWorkspace channels={[{ id: "c1", name: "Main", phone: null }]} canTemplates />,
    );
    expect(html).toContain("Build audience");
    expect(html).toContain("Suggest wording");
    expect(html).toContain("never a patient");
  });
});
