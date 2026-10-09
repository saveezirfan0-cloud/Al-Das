/**
 * Minimal Airtable REST reader: paginated, field-ID keyed, rate-limited
 * (5 req/s per base → ~220 ms between pages, 30 s back-off on 429).
 * Read-only by design: there is no write method.
 */
import { sleep } from "./common";

export type AirtableRecord = {
  id: string;
  createdTime: string;
  /** Keyed by field ID (returnFieldsByFieldId=true). */
  fields: Record<string, unknown>;
};

export type AirtableField = { id: string; name: string; type: string };

export class AirtableClient {
  constructor(private readonly pat: string) {}

  private async get(url: string): Promise<unknown> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.pat}` } });
      if (res.status === 429) {
        await sleep(30_000);
        continue;
      }
      if (res.status >= 500) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      if (!res.ok)
        throw new Error(
          `Airtable ${res.status} for ${url.replace(this.pat, "***")}: ${(await res.text()).slice(0, 200)}`,
        );
      return res.json();
    }
    throw new Error(`Airtable: too many retries for ${url}`);
  }

  /** Table schema (names, types) for the mapping-coverage report. */
  async tableFields(baseId: string, tableId: string): Promise<AirtableField[]> {
    const data = (await this.get(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`)) as {
      tables: Array<{ id: string; fields: AirtableField[] }>;
    };
    return data.tables.find((t) => t.id === tableId)?.fields ?? [];
  }

  /** Streams every record of a table, 100 per page. `since` restricts to records modified after the ISO timestamp. */
  async *records(
    baseId: string,
    tableId: string,
    opts: { since?: string } = {},
  ): AsyncGenerator<AirtableRecord> {
    let offset: string | undefined;
    do {
      const u = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
      u.searchParams.set("pageSize", "100");
      u.searchParams.set("returnFieldsByFieldId", "true");
      if (opts.since)
        u.searchParams.set("filterByFormula", `IS_AFTER(LAST_MODIFIED_TIME(), '${opts.since}')`);
      if (offset) u.searchParams.set("offset", offset);
      const page = (await this.get(u.toString())) as { records: AirtableRecord[]; offset?: string };
      for (const r of page.records) yield r;
      offset = page.offset;
      await sleep(220);
    } while (offset);
  }
}
