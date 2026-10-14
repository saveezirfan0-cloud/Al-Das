import { fieldsFor, headerKey, type ImportFormat } from "@/lib/finance/import-kinds";
import { redactStatementText } from "@/lib/redact";
import { buildUploadPreview, type UploadPreview } from "@/lib/upload/preview";

/**
 * The preview of a bank, settlement, lab or provider file before it is imported (Phase G, pure): only the columns the
 * layout maps (fin_import_formats) are shown, text passes through redactStatementText as it would be stored, a Unite PIN
 * is masked to its last characters, and every other column is listed by NAME only (its values are never read). The
 * import that follows the confirmation is the same server action as before, with its own parser and checks.
 */
export function previewImportTable(
  table: ReadonlyArray<ReadonlyArray<unknown>>,
  format: ImportFormat,
): UploadPreview {
  const fields = fieldsFor(format.kind, format.amountStyle).filter((f) => format.mapping[f.key]);
  const types = new Map(fields.map((f) => [f.key, f.spec.type]));
  return buildUploadPreview(
    table,
    fields.map((f) => ({ field: f.key, label: f.spec.label, header: format.mapping[f.key] })),
    {
      key: headerKey,
      format: (field, value) => {
        if (value === null || value === undefined) return "";
        if (value instanceof Date)
          return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
        const text = String(value);
        if (field === "patient_pin") {
          const t = text.trim();
          return t ? `•••${t.slice(-3)}` : "";
        }
        if (types.get(field) === "text") return redactStatementText(text, 80) ?? "";
        return text;
      },
    },
  );
}
