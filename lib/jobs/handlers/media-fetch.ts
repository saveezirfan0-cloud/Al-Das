import { z } from "zod";

import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";
import { clientForChannel } from "@/lib/whatsapp/channel";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";

export const MEDIA_BUCKET = "wa-media";

/**
 * `media_fetch` queue: { message_id } → download the inbound media from Meta
 * (URLs expire after 5 minutes, so fetch info + bytes in one go) → Supabase
 * Storage at <org>/<conversation>/<message>.<ext> → messages.media_path.
 */
const job = z.object({ message_id: z.string().uuid() });

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/webm": "webm",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export function extensionFor(mime: string | null | undefined, filename?: string | null): string {
  const fromName = filename?.includes(".") ? filename.split(".").pop()?.toLowerCase() : undefined;
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return EXT[base] ?? "bin";
}

export function mediaObjectPath(
  orgId: string,
  conversationId: string,
  messageId: string,
  ext: string,
): string {
  return `${orgId}/${conversationId}/${messageId}.${ext}`;
}

registerHandler({
  queue: "media_fetch",
  name: "media_fetch.download",
  batchSize: 20,
  visibilityTimeout: 120,
  maxReads: 5,
  concurrency: "parallel",
  async handler(raw, ctx) {
    const parsed = job.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid media_fetch job payload");
    const { admin, log } = ctx;

    const { data: message } = await admin
      .from("messages")
      .select(
        "id, org_id, conversation_id, media_meta_id, media_mime, media_filename, media_path, conversations(channel_id)",
      )
      .eq("id", parsed.data.message_id)
      .maybeSingle();
    if (!message) throw new PermanentJobError("message not found");
    if (message.media_path) return; // already fetched
    if (!message.media_meta_id) throw new PermanentJobError("message has no media id");
    const channelId = message.conversations?.channel_id;
    if (!channelId) throw new PermanentJobError("message has no channel");

    const { data: channel } = await admin
      .from("channels")
      .select("id, phone_number_id, waba_id")
      .eq("id", channelId)
      .single();
    if (!channel) throw new PermanentJobError("channel not found");

    const client = await clientForChannel(admin, channel);
    let info;
    try {
      info = await client.getMediaInfo(message.media_meta_id);
    } catch (err) {
      if (err instanceof WhatsAppApiError && !err.mapped.retryable) {
        // Media gone (expired / deleted by the user): record and stop retrying.
        await admin
          .from("messages")
          .update({ error_message: `media unavailable: ${err.mapped.message}` })
          .eq("id", message.id);
        log.warn("media unavailable", { messageId: message.id, code: err.code });
        return;
      }
      throw err;
    }
    const { bytes, mimeType } = await client.downloadMedia(info.url);
    const mime = (info.mime_type ?? mimeType ?? message.media_mime ?? "application/octet-stream")
      .split(";")[0]
      .trim();
    const path = mediaObjectPath(
      message.org_id,
      message.conversation_id,
      message.id,
      extensionFor(mime, message.media_filename),
    );

    const { error: upErr } = await admin.storage
      .from(MEDIA_BUCKET)
      .upload(path, bytes, { contentType: mime, upsert: true });
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);

    await admin
      .from("messages")
      .update({ media_path: path, media_mime: mime })
      .eq("id", message.id);
    log.info("media stored", { messageId: message.id, bytes: bytes.byteLength });
  },
});
