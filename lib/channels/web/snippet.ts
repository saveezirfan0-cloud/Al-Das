/** Path of the widget script served from public/ (no framework, no cookie). Bump WIDGET_VERSION in the script when it changes. */
export const WIDGET_SCRIPT_PATH = "/widget/pulse-chat.js";

/** The line a website adds to show the chat. `key` is the website chat integration's id (public by design: it only names the widget). */
export function widgetSnippet(appUrl: string, key: string): string {
  const base = appUrl.replace(/\/+$/, "");
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error("invalid widget key");
  return `<script src="${base}${WIDGET_SCRIPT_PATH}" data-pulse-chat="${key}" async></script>`;
}
