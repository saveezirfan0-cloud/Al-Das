import type { TemplatePreview } from "@/lib/whatsapp/templates";
import { cn } from "@/lib/utils";

/** A WhatsApp-style bubble for a rendered template (inbox picker, campaigns, later the template builder). */
export function PhonePreview({
  preview,
  className,
}: {
  preview: TemplatePreview | null;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-[#e5ddd5] p-3 dark:bg-[#0b141a]", className)}>
      <div className="max-w-[85%] rounded-lg bg-white p-2 text-sm shadow dark:bg-[#202c33] dark:text-gray-100">
        {preview?.headerMedia && (
          <div className="bg-muted text-muted-foreground mb-1 rounded p-4 text-center text-xs uppercase">
            {preview.headerMedia}
          </div>
        )}
        {preview?.headerText && <p className="font-semibold">{preview.headerText}</p>}
        <p className="whitespace-pre-wrap">{preview?.body}</p>
        {preview?.footer && <p className="text-muted-foreground mt-1 text-xs">{preview.footer}</p>}
        {preview && preview.buttons.length > 0 && (
          <div className="mt-2 flex flex-col gap-1 border-t pt-1">
            {preview.buttons.map((b, i) => (
              <span key={i} className="text-center text-xs text-sky-600">
                {b.text}
              </span>
            ))}
          </div>
        )}
      </div>
      {preview && preview.cards.length > 0 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {preview.cards.map((c, i) => (
            <div
              key={i}
              className="w-44 shrink-0 rounded-lg bg-white p-1.5 text-xs shadow dark:bg-[#202c33] dark:text-gray-100"
            >
              <div className="bg-muted text-muted-foreground mb-1 rounded p-5 text-center uppercase">
                {c.media ?? "media"}
              </div>
              <p className="whitespace-pre-wrap">{c.body}</p>
              {c.buttons.map((b, j) => (
                <span key={j} className="mt-1 block border-t pt-1 text-center text-sky-600">
                  {b}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
