# Templates: named variables, one-time code and catalogue templates

Closes the docs/09 §2.3 gap "Positional variables only in the builder; no OTP or catalogue templates". Built and tested without a Meta account: the payload shapes come from Meta's Cloud API documentation and are **unverified against a live WABA**.

**No database change.** `wa_templates.parameter_format` (`positional` | `named`) already existed and is now written by the builder; `category` is free text; authentication and catalogue templates are stored with `type = 'media_interactive'`, which is what the template sync already gives any template with buttons.

## What exists

| Part | Where | What it does |
|---|---|---|
| Name rules (pure) | `lib/templates/named-params.ts` | A name matches `^[a-z][a-z0-9_]*$`, is at most 40 characters (so `body.<name>` fits the 60-character mapping key), appears once per component, and has an example. Numbers (`{{1}}`) in a named template are an error. Also: name suggestions from the mapped field (`contact.first_name` becomes `first_name`), insert, and number/name conversion |
| Builder draft | `lib/templates/builder.ts` | New optional draft fields `parameterFormat`, `namedExamples`, `auth`; button type `CATALOG`; category `AUTHENTICATION`. Absent `parameterFormat` means positional, so every older draft, the gallery and the Campaign Copilot are unchanged (tests prove the positional payload and the round trip are byte-for-byte the same) |
| Named templates | same | Body examples go to Meta as `body_text_named_params`, the header's as `header_text_named_params`; the create request says `parameter_format: "NAMED"`. Carousels stay numbered. `convertParameterFormat` switches a draft both ways, keeping examples and the variable map; `pruneDraft` replaces the builder's old clean-up (same result for positional drafts) |
| Authentication templates | same | Meta writes the text. The author chooses the "keep it private" note (`add_security_recommendation`), an optional expiry of 1 to 90 minutes (`code_expiration_minutes`) and the copy button's label (`OTP` button, `otp_type: COPY_CODE`). `buildComponents` sends Meta that settings-only shape; `storedComponents` keeps a readable shape with one `{{1}}` (Pulse's own stand-in wording, replaced by Meta's text at the next sync) so previews and sends work before a sync. No `parameter_format` and no `allow_category_change` are sent for them |
| Catalogue templates | same | Marketing only, exactly one `CATALOG` button, no header (WhatsApp shows a catalogue picture there). Needs a catalogue connected to the WABA in Meta Commerce Manager |
| Send-time components | `lib/whatsapp/templates.ts` (`buildTemplateSend`) | Named templates send `parameter_name` (unchanged, already there). An authentication template's copy button (the `OTP` shape or the URL-to-whatsapp.com/otp shape Meta lists it back in) is not a variable: it gets the body's code as its `url` parameter automatically. A catalogue button is an **optional** variable (`button.<i>`, kind `catalog_thumbnail`): with a value it sends `sub_type: CATALOG` with `thumbnail_product_retailer_id`; without one it still sends the button component with an empty `action` and Meta shows the first catalogue item |
| Optional variables | `TemplateVariable.optional` | Never counted as missing by `renderTemplatePreview`, `buildTemplateSend`, `resolveVariables` or `unmappedVariables` |
| Sync | `lib/whatsapp/sync.ts` (unchanged) | Stores Meta's components as they are. The builder, preview and send code read all three shapes, including Meta's listed form of an authentication template (tests use synthetic copies of that shape) |
| Campaigns | `app/(app)/campaigns/actions.ts`, `new/page.tsx` | Authentication templates are not offered and are refused for campaigns |
| Automated senders | `lib/jobs/handlers/outbound.ts`, `authTemplateSendAllowed` | An Authentication template goes out only on a spec marked `otp: true`, which only the Inbox template send and the public API set; reminders, flows, waiting-list offers and every other automation fail closed. Their pickers (appointment and front-desk settings, the flow editor) do not list them, and retry-on-fail never re-sends one (`templateRetryDecision`, reason `authentication`) |
| UI | `app/(app)/templates/template-builder.tsx`, `components/phone-preview/phone-preview.tsx`, map dialog, inbox picker | "Variables: Numbered / Named" select (fixed once submitted), named example rows with the same source picker, the one-time code panel, a Catalogue button for marketing templates, a catalogue picture placeholder in the preview |

## Rules people must follow

- **Pulse never creates or sends one-time codes by itself.** An authentication template can be built, synced and sent through `queueOutbound` only by code that supplies the code as `body.1`. Note that, like every template send, the rendered body (with the code) is kept on the message row; a future feature that sends codes should decide whether to blank it.
- A submitted template's variable style and its authentication category cannot change (`submitTemplate` refuses; duplicate it instead), because Meta does not allow it on an edit.
- New code that reads template variables must respect `optional` (only the catalogue thumbnail today).

## Not done / unverified

- Live Meta: the authentication create shape, the listed URL-button form, and whether a catalogue send without a thumbnail may omit the button component entirely are taken from Meta's documentation, not a live account.
- One-tap and zero-tap authentication buttons are not offered; a synced one opens in the builder as copy-code (re-submitting would change it).
- Meta's own wording for authentication templates is shown only after a sync; the stand-in text is Pulse's.
- Flow-button templates remain out of scope.
