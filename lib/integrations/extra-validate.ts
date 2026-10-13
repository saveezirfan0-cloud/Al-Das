import { allowListProblem } from "@/lib/finance/mailbox";
import type { IntegrationKind } from "@/lib/integrations/catalog";
import { validateRoomTemplate } from "@/lib/integrations/telehealth/url";

/**
 * Checks that go beyond one field's type (pure): called by the settings action after validateFields, so a value that passes the form's
 * shape check but is unsafe or unusable is still refused. Returns an error sentence, or null.
 */
export function extraValidation(
  kind: IntegrationKind,
  provider: string | null,
  config: Record<string, string | number>,
): string | null {
  if (kind === "telehealth" && provider === "static") {
    const t = validateRoomTemplate(config.url_template);
    if (!t.ok) return t.error;
  }
  if (kind === "finance_mailbox") return allowListProblem(config.allowed_senders);
  return null;
}
