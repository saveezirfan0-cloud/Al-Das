import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Client components talk to the router and to server actions; a static render only needs them to exist.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/media",
}));
vi.mock("@/app/(app)/media/actions", () => ({
  abandonLibraryUpload: async () => ({ ok: true }),
  createFolder: async () => ({ ok: true }),
  deleteAsset: async () => ({ ok: true }),
  deleteFolder: async () => ({ ok: true }),
  finalizeLibraryUpload: async () => ({ ok: true }),
  getAssetUrl: async () => ({ ok: true, data: { url: "https://x.test", kind: "image" } }),
  getAssetUsage: async () => ({ ok: true, data: [] }),
  listPickerAssets: async () => ({ ok: true, data: [] }),
  prepareLibraryUpload: async () => ({ ok: false, error: "x" }),
  renameFolder: async () => ({ ok: true }),
  rescanAsset: async () => ({ ok: true }),
  updateAsset: async () => ({ ok: true }),
}));
vi.mock("@/app/(app)/contacts/documents/actions", () => ({
  abandonDocumentUpload: async () => ({ ok: true }),
  deleteDocument: async () => ({ ok: true }),
  finalizeDocumentUpload: async () => ({ ok: true }),
  getDocumentUrl: async () => ({ ok: false, error: "x" }),
  listContactDocuments: async () => ({ ok: false, error: "x" }),
  listDocumentAccess: async () => ({ ok: true, data: [] }),
  prepareDocumentUpload: async () => ({ ok: false, error: "x" }),
  rescanDocument: async () => ({ ok: true }),
  updateDocument: async () => ({ ok: true }),
}));
vi.mock("@/app/(app)/settings/documents/actions", () => ({
  disableDocuments: async () => ({ ok: true }),
  enableDocuments: async () => ({ ok: true }),
  purgePastRetention: async () => ({ ok: true }),
  saveDocumentOptions: async () => ({ ok: true }),
  saveRetentionPolicy: async () => ({ ok: true }),
  scanPendingFiles: async () => ({ ok: true }),
}));

import { MediaLibrary } from "@/app/(app)/media/media-library";
import { ContactDocuments } from "@/app/(app)/contacts/documents/documents-tab";
import { DocumentsSettings } from "@/app/(app)/settings/documents/documents-settings";
import { Lightbox } from "@/components/media/lightbox";
import { ScanBadge } from "@/components/media/scan-badge";
import { DEFAULT_DOCUMENT_SETTINGS } from "@/lib/documents/settings";
import type { LibraryAsset } from "@/lib/media/library";

const asset = (over: Partial<LibraryAsset>): LibraryAsset => ({
  id: "a1",
  name: "Spring offer",
  kind: "image",
  mime_type: "image/jpeg",
  size_bytes: 250_000,
  original_size_bytes: null,
  width: 800,
  height: 600,
  tags: ["offers"],
  folder_id: null,
  scan_status: "unscanned",
  created_at: "2026-10-14T06:00:00.000Z",
  uploader: "Lina Example",
  thumb_url: "https://storage.example.test/thumb.jpg",
  ...over,
});

const baseProps = {
  total: 3,
  page: 1,
  pageSize: 48,
  folders: [{ id: "f1", name: "Offers" }],
  tags: ["offers"],
  filters: { folder: "", kind: "", tag: "", q: "" },
  scanner: "No scanner configured",
  totalBytes: 800_000,
};

describe("ScanBadge", () => {
  it("flags 'not scanned' as a warning, never as clean", () => {
    const html = renderToStaticMarkup(<ScanBadge status="unscanned" />);
    expect(html).toContain("Not scanned");
    expect(html).toContain("amber");
    expect(html).not.toContain("Scanned<");
  });
  it("shows blocked and failed states", () => {
    expect(renderToStaticMarkup(<ScanBadge status="infected" />)).toContain("Blocked");
    expect(renderToStaticMarkup(<ScanBadge status="error" />)).toContain("Scan failed");
    expect(renderToStaticMarkup(<ScanBadge status="clean" />)).toContain("Scanned");
  });
});

describe("Media Library page", () => {
  const assets = [
    asset({ id: "a1", name: "Spring offer", scan_status: "unscanned" }),
    asset({
      id: "a2",
      name: "Price list",
      kind: "document",
      mime_type: "application/pdf",
      thumb_url: null,
      scan_status: "clean",
    }),
    asset({ id: "a3", name: "Bad file", scan_status: "infected" }),
  ];

  it("lists files with type, size and a flag on files that were not checked or were blocked", () => {
    const html = renderToStaticMarkup(<MediaLibrary {...baseProps} assets={assets} canManage />);
    expect(html).toContain("Spring offer");
    expect(html).toContain("Price list");
    expect(html).toContain("Not scanned");
    expect(html).toContain("Blocked");
    expect(html).toContain("244 KB");
    expect(html).toContain("malware scanner: No scanner configured");
    expect(html).toContain("2 on this page not scanned");
    expect(html).toContain('loading="lazy"');
  });

  it("offers upload, camera and folder management only with media.manage", () => {
    const manager = renderToStaticMarkup(<MediaLibrary {...baseProps} assets={assets} canManage />);
    expect(manager).toContain("Upload");
    expect(manager).toContain("Take a photo");
    expect(manager).toContain("New folder");
    expect(manager).toContain('capture="environment"');
    const viewer = renderToStaticMarkup(
      <MediaLibrary {...baseProps} assets={assets} canManage={false} />,
    );
    expect(viewer).not.toContain("Take a photo");
    expect(viewer).not.toContain("New folder");
    expect(viewer).not.toContain("drop files here");
  });

  it("explains an empty library and an empty search differently", () => {
    const empty = renderToStaticMarkup(
      <MediaLibrary {...baseProps} assets={[]} total={0} canManage />,
    );
    expect(empty).toContain("No files yet.");
    const none = renderToStaticMarkup(
      <MediaLibrary
        {...baseProps}
        assets={[]}
        total={0}
        canManage
        filters={{ ...baseProps.filters, q: "zzz" }}
      />,
    );
    expect(none).toContain("No files match.");
  });

  it("links the folders and keeps the filters in the links", () => {
    const html = renderToStaticMarkup(
      <MediaLibrary
        {...baseProps}
        assets={assets}
        canManage
        filters={{ ...baseProps.filters, q: "spring" }}
      />,
    );
    expect(html).toContain("All files");
    expect(html).toContain("Unfiled");
    expect(html).toContain("/media?folder=f1&amp;q=spring");
  });

  it("pages through long lists", () => {
    const html = renderToStaticMarkup(
      <MediaLibrary {...baseProps} assets={assets} total={130} page={2} canManage />,
    );
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
  });
});

describe("patient documents tab", () => {
  it("says so, and loads nothing, for someone without documents.view", () => {
    const html = renderToStaticMarkup(
      <ContactDocuments contactId="c1" canView={false} timezone="Asia/Dubai" />,
    );
    expect(html).toContain("You do not have access to patient documents");
    expect(html).toContain("View patient documents");
  });
});

describe("Patient documents settings", () => {
  const usage = {
    library: { image: { files: 2, bytes: 1_000_000 } },
    documents: {
      lab_report: { files: 3, bytes: 5_000_000 },
      insurance_card: { files: 1, bytes: 500_000 },
    },
    documents_by_month: [{ month: "2026-10", files: 4, bytes: 5_500_000 }],
    library_unscanned: 2,
    library_blocked: 0,
    documents_unscanned: 4,
    documents_blocked: 1,
    pending_uploads: 1,
    cards_expiring_30d: 1,
    cards_expired: 0,
    library_total: { files: 2, bytes: 1_000_000 },
    documents_total: { files: 4, bytes: 5_500_000 },
  };
  const policies = [
    { category: "referral", label: "Referral", retain_days: 365, auto_delete: false, past: 2 },
    { category: "other", label: "Other", retain_days: null, auto_delete: false, past: 0 },
  ];

  it("is off until the exact phrase is typed, and says why", () => {
    const html = renderToStaticMarkup(
      <DocumentsSettings
        settings={DEFAULT_DOCUMENT_SETTINGS}
        policies={policies}
        usage={usage}
        scanner="No scanner configured"
      />,
    );
    expect(html).toContain("Off");
    expect(html).toContain("STORAGE REGION APPROVED");
    expect(html).toContain("data-residency");
  });

  it("shows the switch-off control once it is on", () => {
    const html = renderToStaticMarkup(
      <DocumentsSettings
        settings={{
          ...DEFAULT_DOCUMENT_SETTINGS,
          enabled: true,
          confirmed_at: "2026-10-15T08:00:00.000Z",
        }}
        policies={policies}
        usage={usage}
        scanner="No scanner configured"
      />,
    );
    expect(html).toContain("Switch off new uploads");
    expect(html).not.toContain("Switch on<");
  });

  it("shows usage, the unscanned warning and past-retention counts", () => {
    const html = renderToStaticMarkup(
      <DocumentsSettings
        settings={DEFAULT_DOCUMENT_SETTINGS}
        policies={policies}
        usage={usage}
        scanner="No scanner configured"
      />,
    );
    expect(html).toContain("Lab report");
    expect(html).toContain("4.8 MB");
    expect(html).toContain("6 files not scanned");
    expect(html).toContain("1 blocked");
    expect(html).toContain("1 unfinished upload");
    expect(html).toContain("2 past retention");
    expect(html).toContain("Delete 2 now");
    expect(html).toContain("Until a provider is configured");
  });
});

describe("Lightbox", () => {
  const items = [
    { id: "p1", label: "one.jpg" },
    { id: "p2", label: "two.jpg" },
    { id: "p3", label: null },
  ];
  it("renders nothing while closed", () => {
    const html = renderToStaticMarkup(
      <Lightbox
        items={items}
        index={null}
        onIndexChange={() => {}}
        onClose={() => {}}
        loadUrl={async () => null}
      />,
    );
    expect(html).toBe("");
  });
});
