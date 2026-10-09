import {
  ExternalLink,
  FileText,
  MapPin,
  Phone,
  Play,
  Reply,
  Copy,
  Image as ImageIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { tokenizeWhatsAppText } from "@/lib/whatsapp/format";
import { renderTemplatePreview, type TemplateValues } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";
import { cn } from "@/lib/utils";

function Formatted({ text }: { text: string }) {
  return (
    <>
      {tokenizeWhatsAppText(text).map((s, i) => {
        let node: ReactNode = s.text;
        if (s.mono)
          node = <code className="rounded bg-black/5 px-0.5 font-mono text-[0.9em]">{node}</code>;
        if (s.strike) node = <s>{node}</s>;
        if (s.italic) node = <em>{node}</em>;
        if (s.bold) node = <strong>{node}</strong>;
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

const MEDIA_ICON = { image: ImageIcon, video: Play, document: FileText, location: MapPin } as const;

function ButtonIcon({ type }: { type: string }) {
  if (type === "URL") return <ExternalLink className="size-3.5" />;
  if (type === "PHONE_NUMBER") return <Phone className="size-3.5" />;
  if (type === "COPY_CODE") return <Copy className="size-3.5" />;
  return <Reply className="size-3.5" />;
}

/**
 * A WhatsApp-style bubble for a template (Phase 4 builder, Phase 7 campaigns). Variables show their
 * example text until `values` provides something else. `rtl` mirrors the layout for Arabic.
 */
export function PhonePreview({
  components,
  values,
  rtl = false,
  className,
  time = "10:42",
}: {
  components: MetaTemplateComponent[];
  values?: TemplateValues;
  rtl?: boolean;
  className?: string;
  time?: string;
}) {
  const p = renderTemplatePreview(components, values ?? {});
  const carousel = components.find((c) => c.type === "CAROUSEL") as
    Extract<MetaTemplateComponent, { type: "CAROUSEL" }> | undefined;
  const Media = p.headerMedia ? MEDIA_ICON[p.headerMedia] : null;

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[320px] rounded-[2rem] border bg-neutral-900 p-2 shadow-sm",
        className,
      )}
      aria-label="Phone preview"
    >
      <div className="overflow-hidden rounded-[1.5rem] bg-[#e9e2d6] dark:bg-[#1f2a2e]">
        <div className="flex h-9 items-center bg-[#0b6b5a] px-3 text-xs font-medium text-white">
          Al Das Medical
        </div>
        <div
          dir={rtl ? "rtl" : "ltr"}
          className="min-h-[220px] space-y-2 p-3 text-[13px] leading-snug text-neutral-900"
        >
          <div className="max-w-[92%] overflow-hidden rounded-lg bg-white shadow-sm dark:bg-[#2a373c] dark:text-neutral-100">
            {Media ? (
              <div className="flex h-32 items-center justify-center bg-neutral-200 text-neutral-500 dark:bg-neutral-700">
                <Media className="size-8" />
              </div>
            ) : null}
            <div className="space-y-1 px-2.5 pt-2 pb-1.5">
              {p.headerText ? (
                <div className="font-semibold">
                  <Formatted text={p.headerText} />
                </div>
              ) : null}
              <div className="break-words whitespace-pre-wrap">
                {p.body ? (
                  <Formatted text={p.body} />
                ) : (
                  <span className="text-neutral-400">Your message appears here</span>
                )}
              </div>
              {p.footer ? <div className="text-[11px] text-neutral-500">{p.footer}</div> : null}
              <div className="text-end text-[10px] text-neutral-400">{time}</div>
            </div>
            {p.buttons.length > 0 ? (
              <div className="divide-y border-t">
                {p.buttons.map((b, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-center gap-1.5 py-2 text-[12.5px] font-medium text-[#0a6fa8]"
                  >
                    <ButtonIcon type={b.type} />
                    {b.text}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {carousel ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {carousel.cards.map((card, i) => {
                const body = card.components.find((c) => c.type === "BODY") as
                  Extract<MetaTemplateComponent, { type: "BODY" }> | undefined;
                const btns = card.components.find((c) => c.type === "BUTTONS") as
                  Extract<MetaTemplateComponent, { type: "BUTTONS" }> | undefined;
                return (
                  <div
                    key={i}
                    className="w-40 shrink-0 overflow-hidden rounded-lg bg-white shadow-sm"
                  >
                    <div className="flex h-20 items-center justify-center bg-neutral-200 text-neutral-500">
                      <ImageIcon className="size-6" />
                    </div>
                    <div className="px-2 py-1.5 text-[12px]">
                      {body ? <Formatted text={body.text} /> : null}
                    </div>
                    {(btns?.buttons ?? []).map((b, j) => (
                      <div
                        key={j}
                        className="border-t py-1.5 text-center text-[12px] font-medium text-[#0a6fa8]"
                      >
                        {"text" in b ? b.text : ""}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
