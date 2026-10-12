import Link from "next/link";
import QRCode from "qrcode";

import { PageHeader } from "@/components/shell/page-header";
import { PrintButton } from "@/components/shell/print-button";
import { Button } from "@/components/ui/button";
import { requirePerm } from "@/lib/auth/session";
import { readFrontDeskSettings } from "@/lib/front-desk/settings";
import { registrationMessage, whatsappDeskLink } from "@/lib/front-desk/qr";
import { normalizePhone } from "@/lib/phone";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Desk QR code" };

async function svgFor(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", width: 256 });
}

export default async function DeskQrPage() {
  const member = await requirePerm("frontdesk.use");
  const admin = createAdminClient();
  const settings = readFrontDeskSettings(member.org.settings);

  const { data: channels } = await admin
    .from("channels")
    .select("id, name, display_phone")
    .eq("org_id", member.orgId)
    .eq("status", "active")
    .order("created_at");
  const channel =
    (settings.desk_channel_id && channels?.find((c) => c.id === settings.desk_channel_id)) ||
    channels?.[0] ||
    null;
  const phone = normalizePhone(channel?.display_phone)?.e164 ?? null;

  const links = phone
    ? {
        en: whatsappDeskLink(phone, registrationMessage(settings, "en")),
        ar: whatsappDeskLink(phone, registrationMessage(settings, "ar")),
      }
    : null;
  const [enSvg, arSvg] = links
    ? await Promise.all([links.en ? svgFor(links.en) : null, links.ar ? svgFor(links.ar) : null])
    : [null, null];

  return (
    <div className="flex flex-col gap-6">
      <div className="print:hidden">
        <PageHeader
          title="Desk QR code"
          description="Patients scan this with their phone camera. WhatsApp opens a chat with the clinic and the registration message is already typed; they only press send."
        >
          <PrintButton label="Print the poster" />
          <Button size="sm" variant="outline" asChild>
            <Link href="/front-desk">Back to the desk</Link>
          </Button>
        </PageHeader>
      </div>

      {!links || (!enSvg && !arSvg) ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm print:hidden">
          No active WhatsApp number with a phone number is connected yet. Connect one under
          Settings, WhatsApp channels, then come back.
        </p>
      ) : (
        <article
          className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 rounded-xl border p-8 text-center print:max-w-none print:border-0 print:p-0"
          aria-label="Poster"
        >
          <header>
            <h2 className="text-3xl font-semibold">{member.org.name}</h2>
            <p className="mt-2 text-xl">New patient? Register on WhatsApp</p>
            <p className="mt-1 text-xl" dir="rtl" lang="ar">
              مريض جديد؟ سجّل عبر واتساب
            </p>
          </header>
          <div className="grid w-full grid-cols-1 gap-8 sm:grid-cols-2 print:grid-cols-2">
            {enSvg && (
              <figure className="flex flex-col items-center gap-2">
                <div
                  className="size-56 bg-white p-2"
                  role="img"
                  aria-label="QR code that opens WhatsApp in English"
                  dangerouslySetInnerHTML={{ __html: enSvg }}
                />
                <figcaption className="text-lg">English</figcaption>
              </figure>
            )}
            {arSvg && (
              <figure className="flex flex-col items-center gap-2">
                <div
                  className="size-56 bg-white p-2"
                  role="img"
                  aria-label="QR code that opens WhatsApp in Arabic"
                  dangerouslySetInnerHTML={{ __html: arSvg }}
                />
                <figcaption className="text-lg" dir="rtl" lang="ar">
                  العربية
                </figcaption>
              </figure>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            Point your phone camera at the code · وجّه كاميرا هاتفك نحو الرمز
          </p>
        </article>
      )}
      <p className="text-muted-foreground text-xs print:hidden">
        The message the patient sends is set under Settings, Front desk. It contains no personal
        details.
      </p>
    </div>
  );
}
