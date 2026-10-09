/**
 * Inbox media lives in the private wa-media bucket at <org>/<conversation>/<file>.
 * Paths arrive from the browser (signed-URL and attachment actions), and the outbound
 * job later downloads them with the service role, so they are validated strictly:
 * three segments, UUID org and conversation, a plain file name, no traversal.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type MediaPathParts = { orgId: string; conversationId: string; file: string };

export function parseMediaPath(path: string): MediaPathParts | null {
  if (typeof path !== "string" || path.length > 300) return null;
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  const [orgId, conversationId, file] = parts;
  if (!UUID.test(orgId) || !UUID.test(conversationId)) return null;
  if (!FILE.test(file) || file.includes("..")) return null;
  return { orgId: orgId.toLowerCase(), conversationId: conversationId.toLowerCase(), file };
}

/** True when `path` is a well-formed media path inside exactly this org and conversation. */
export function isMediaPathFor(path: string, orgId: string, conversationId: string): boolean {
  const p = parseMediaPath(path);
  return !!p && p.orgId === orgId.toLowerCase() && p.conversationId === conversationId.toLowerCase();
}
