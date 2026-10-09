import { Fragment } from "react";
import {
  FileText,
  Image as ImageIcon,
  Phone,
  Reply,
  ExternalLink,
  Copy,
  Video,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { parseWhatsAppFormat, type FormatNode } from "@/lib/whatsapp/format";
import { isRtlLanguage } from "@/lib/whatsapp/template-builder";
import { renderTemplatePreview, type TemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

function Nodes({ nodes }: { nodes: FormatNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "text":
            return <Fragment key={i}>{n.text}</Fragment>;
          case "bold":
            return (
              <strong key={i}>
                <Nodes nodes={n.children} />
              </strong>
            );
          case "italic":
            return (
              <em key={i}>
                <Nodes nodes={n.children} />
              </em>
            );
          case "strike":
            return (
              <s key={i}>
                <Nodes nodes={n.children} />
              </s>
            );
          case "mono":
            return (
              <code key={i} className="font-mono text-[0.9em]">
                {n.text}
              </code>
            );
        }
      })}
    </>
  );
}

function Formatted({ text }: { text: string }) {
  return (
    <span className="break-words whitespace-pre-wrap">
      <Nodes nodes={parseWhatsAppFormat(text)} />
    </span>
  );
}

function MediaBox({ kind }: { kind: NonNullable<TemplatePreview["headerMedia"]> }) {
  const Icon = kind === "video" ? Video : kind === "document" ? FileText : ImageIcon;
  return (
    <div className="mb-1.5 flex h-28 items-center justify-center rounded-md bg-black/10 text-black/40">
      <Icon className="size-8" aria-hidden />
      <span className="sr-only">{kind} header</span>
    </div>
  );
}

function ButtonRow({ type, text }: { type: string; text: string }) {
  const Icon =
    type === "URL"
      ? ExternalLink
      : type === "PHONE_NUMBER"
        ? Phone
        : type === "COPY_CODE"
          ? Copy
          : Reply;
  return (
    <div className="flex items-center justify-center gap-1.5 rounded-md bg-white px-3 py-2 text-[13px] font-medium text-sky-700 shadow-sm">
      <Icon className="size-3.5" aria-hidden />
      {text}
    </div>
  );
}

function Bubble({ p, rtl, compact }: { p: TemplatePreview; rtl: boolean; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1", compact ? "w-44 shrink-0" : "max-w-[92%]")}>
      <div className="rounded-lg rounded-tl-none bg-white p-2 text-[13px] leading-snug text-black shadow-sm">
        {p.headerMedia && <MediaBox kind={p.headerMedia} />}
        {p.headerText && (
          <div className="mb-1 font-semibold">
            <Formatted text={p.headerText} />
          </div>
        )}
        {p.body ? (
          <Formatted text={p.body} />
        ) : (
          <span className="text-black/30">{rtl ? "نص الرسالة" : "Message text"}</span>
        )}
        {p.footer && <div className="mt-1 text-[11px] text-black/45">{p.footer}</div>}
        <div className="mt-1 text-end text-[10px] text-black/40">12:00</div>
      </div>
      {p.buttons.map((b, i) => (
        <ButtonRow key={i} type={b.type} text={b.text} />
      ))}
    </div>
  );
}

/** A phone-shaped, live preview of a template (RTL-aware, with carousel cards). */
export function PhonePreview({
  components,
  language,
  values,
  className,
}: {
  components: MetaTemplateComponent[];
  language: string;
  values?: Record<string, string>;
  className?: string;
}) {
  const rtl = isRtlLanguage(language);
  const p = renderTemplatePreview(components, values);
  return (
    <div
      className={cn(
        "mx-auto w-[300px] overflow-hidden rounded-[28px] border-[6px] border-neutral-800 bg-[#e5ddd5] shadow-lg",
        className,
      )}
    >
      <div className="flex items-center gap-2 bg-[#075e54] px-3 py-2 text-xs text-white">
        <span className="size-6 rounded-full bg-white/30" aria-hidden />
        <span className="font-medium">Your clinic</span>
      </div>
      <div
        dir={rtl ? "rtl" : "ltr"}
        className="flex min-h-[360px] flex-col gap-2 p-3"
        aria-label="Template preview"
      >
        <Bubble p={p} rtl={rtl} />
        {p.cards.length > 0 && (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {p.cards.map((c, i) => (
              <Bubble key={i} p={c} rtl={rtl} compact />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
