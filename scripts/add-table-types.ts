/**
 * Adds typed entries for new tables / views to lib/supabase/types.ts in the generator's format, from a
 * migrated database. The Supabase CLI (`pnpm gen:types`) is the normal route; this is for environments
 * without Docker (plain Postgres test database). Idempotent: tables already present are skipped.
 *
 *   TEST_DATABASE_URL=… pnpm tsx scripts/add-table-types.ts flows flow_versions flow_runs …
 */
import "dotenv/config";

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

const FILE = path.resolve(process.cwd(), "lib/supabase/types.ts");

const TS: Record<string, string> = {
  uuid: "string",
  text: "string",
  timestamptz: "string",
  timestamp: "string",
  date: "string",
  time: "string",
  int4: "number",
  int2: "number",
  int8: "number",
  numeric: "number",
  float8: "number",
  bool: "boolean",
  jsonb: "Json",
  json: "Json",
};

type Col = {
  column_name: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  is_generated: string;
  is_identity: string;
};

function tsType(udt: string, nullable = true): string {
  if (udt.startsWith("_")) return `${TS[udt.slice(1)] ?? "string"}[]`;
  if ((udt === "jsonb" || udt === "json") && !nullable) return "NonNullable<Json>";
  return TS[udt] ?? "string";
}

async function main() {
  const names = process.argv.slice(2);
  if (names.length === 0) throw new Error("pass table or view names");
  const url = (process.env.TEST_DATABASE_URL ?? "").split("?")[0];
  const c = new Client({ connectionString: url });
  await c.connect();
  let src = readFileSync(FILE, "utf8");

  for (const name of names) {
    const kind = (
      await c.query(
        `select table_type from information_schema.tables where table_schema='public' and table_name=$1`,
        [name],
      )
    ).rows[0]?.table_type as string | undefined;
    if (!kind) throw new Error(`${name} not found`);
    const isView = kind === "VIEW";
    const section = isView ? "Views" : "Tables";
    const marker = new RegExp(`^      ${name}: \\{$`, "m");
    // Only look inside the right section.
    const secStart = src.indexOf(`    ${section}: {`);
    const secEnd = src.indexOf("\n    };", secStart);
    const secText = src.slice(secStart, secEnd);
    if (marker.test(secText)) {
      console.log(`${name}: already present`);
      continue;
    }
    const cols = (
      await c.query<Col>(
        `select column_name, udt_name, is_nullable, column_default, is_generated, is_identity from information_schema.columns where table_schema='public' and table_name=$1 order by column_name`,
        [name],
      )
    ).rows;
    const fks = (
      await c.query(
        `select con.conname, a.attname as col, rt.relname as ref, ra.attname as refcol,
                exists (select 1 from pg_index i where i.indrelid = con.conrelid and i.indisunique and i.indnatts = 1 and i.indkey[0] = a.attnum) as one
         from pg_constraint con
         join pg_class t on t.oid = con.conrelid join pg_namespace n on n.oid = t.relnamespace
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
         join pg_class rt on rt.oid = con.confrelid
         join pg_attribute ra on ra.attrelid = con.confrelid and ra.attnum = con.confkey[1]
         where con.contype = 'f' and n.nspname = 'public' and t.relname = $1 and array_length(con.conkey, 1) = 1
         order by con.conname`,
        [name],
      )
    ).rows;

    const row = cols
      .map(
        (x) =>
          `          ${x.column_name}: ${tsType(x.udt_name, x.is_nullable === "YES")}${x.is_nullable === "YES" ? " | null" : ""};`,
      )
      .join("\n");
    const ins = cols
      .map((x) => {
        const optional =
          x.is_nullable === "YES" ||
          x.column_default !== null ||
          x.is_generated === "ALWAYS" ||
          x.is_identity === "YES";
        return `          ${x.column_name}${optional ? "?" : ""}: ${tsType(x.udt_name, x.is_nullable === "YES")}${x.is_nullable === "YES" ? " | null" : ""};`;
      })
      .join("\n");
    const upd = cols
      .map(
        (x) =>
          `          ${x.column_name}?: ${tsType(x.udt_name, x.is_nullable === "YES")}${x.is_nullable === "YES" ? " | null" : ""};`,
      )
      .join("\n");
    const rel = fks.length
      ? `        Relationships: [\n${fks
          .map(
            (f) =>
              `          {\n            foreignKeyName: "${f.conname}";\n            columns: ["${f.col}"];\n            isOneToOne: ${f.one};\n            referencedRelation: "${f.ref}";\n            referencedColumns: ["${f.refcol}"];\n          },`,
          )
          .join("\n")}\n        ];`
      : "        Relationships: [];";
    const block = isView
      ? `      ${name}: {\n        Row: {\n${row}\n        };\n        Relationships: [];\n      };\n`
      : `      ${name}: {\n        Row: {\n${row}\n        };\n        ComputedFields: never;\n        Insert: {\n${ins}\n        };\n        Update: {\n${upd}\n        };\n${rel}\n      };\n`;

    // Insert alphabetically inside the section.
    const entries = [...secText.matchAll(/^      ([a-z0-9_]+): \{$/gm)].map((m) => ({
      name: m[1],
      index: secStart + (m.index ?? 0),
    }));
    const after = entries.find((e) => e.name > name);
    const at = after ? after.index : secEnd + 1;
    src = src.slice(0, at) + block + src.slice(at);
    console.log(`${name}: added to ${section}`);
  }
  writeFileSync(FILE, src);
  await c.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
