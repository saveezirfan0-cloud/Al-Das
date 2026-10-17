/**
 * Ties the migration status page (lib/migration/status.ts) to the importers, so the two cannot drift:
 *   - every Airtable entity the status page counts is one the importer writes, and every entity the importer writes is
 *     listed on the status page (or explained below);
 *   - every Sanoflow entity the status page counts is one the Sanoflow importer reports, and the entity lists in
 *     scripts/import/sanoflow/entities.ts match the importer's own sources.
 * A new importer table or Sanoflow step fails here until the status page knows about it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { entityMap } from "../../scripts/import/registry";
import {
  SANOFLOW_REF_ENTITIES,
  SANOFLOW_RUN_ENTITIES,
  SANOFLOW_RUN_ONLY_ENTITIES,
} from "../../scripts/import/sanoflow/entities";
import { MIGRATION_REGISTRY, refKey } from "@/lib/migration/status";

const SANOFLOW_DIR = join(__dirname, "../../scripts/import/sanoflow");

/** Importer entities the status page deliberately does not list, with the reason. Empty today. */
const AIRTABLE_UNLISTED: Record<string, string> = {};

/** Sanoflow steps the status page cannot count (nothing is written). */
const SANOFLOW_NOT_COUNTED: Record<string, string> = {
  segment_dynamic: "report only: a dynamic segment is a filter and is rebuilt by hand",
};

const evidences = MIGRATION_REGISTRY.map((e) => e.evidence);
const listed = (source: "airtable" | "sanoflow") =>
  new Set(
    evidences.flatMap((ev) =>
      (ev.kind === "refs" || ev.kind === "run") && (ev.source ?? "airtable") === source
        ? [ev.entity]
        : [],
    ),
  );

function sanoflowSources(): string {
  return readdirSync(SANOFLOW_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "entities.ts")
    .map((f) => readFileSync(join(SANOFLOW_DIR, f), "utf8"))
    .join("\n");
}

describe("Airtable entities", () => {
  const importer = new Set(entityMap().values());

  it("every entity the status page counts is one the importer writes", () => {
    for (const entity of listed("airtable"))
      expect(
        importer.has(entity),
        `status page lists ${entity}, the importer never writes it`,
      ).toBe(true);
  });

  it("every entity the importer writes is on the status page", () => {
    const onPage = listed("airtable");
    for (const entity of importer)
      expect(
        onPage.has(entity) || entity in AIRTABLE_UNLISTED,
        `importer writes ${entity}, the status page does not list it`,
      ).toBe(true);
  });

  it("no unlisted exception is stale", () => {
    for (const entity of Object.keys(AIRTABLE_UNLISTED)) expect(importer.has(entity)).toBe(true);
  });

  it("each status entry counts an entity once", () => {
    const keys = evidences.flatMap((ev) =>
      ev.kind === "refs" ? [refKey(ev.entity, ev.source)] : [],
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("Sanoflow entities", () => {
  const src = sanoflowSources();

  it("the run entities are exactly the steps the importer creates", () => {
    const fromNewRun = [...src.matchAll(/newRun\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    const fromListKinds = [
      ...(/type ListKind = ([^;]+);/.exec(src)?.[1] ?? "").matchAll(/"([a-z_]+)"/g),
    ].map((m) => m[1]!);
    expect([...new Set([...fromNewRun, ...fromListKinds])].sort()).toEqual(
      [...SANOFLOW_RUN_ENTITIES].sort(),
    );
  });

  it("every entity the importer links in external_refs is in the ref list", () => {
    const literal = [...src.matchAll(/upsertRef\(\{[^}]*?entity:\s*"([a-z_]+)"/g)].map(
      (m) => m[1]!,
    );
    for (const e of literal) expect(SANOFLOW_REF_ENTITIES as readonly string[], e).toContain(e);
    // list steps pass their kind as the entity
    expect(src).toMatch(/upsertRef\(\{\s*entity:\s*kind/);
    // and nothing in the run-only list links records
    for (const e of SANOFLOW_RUN_ONLY_ENTITIES) expect(literal).not.toContain(e);
  });

  it("every Sanoflow entity is on the status page or explained", () => {
    const onPage = listed("sanoflow");
    for (const e of SANOFLOW_RUN_ENTITIES)
      expect(
        onPage.has(e) || e in SANOFLOW_NOT_COUNTED,
        `status page does not list sanoflow/${e}`,
      ).toBe(true);
  });

  it("every Sanoflow entry on the status page is a real entity, with the right kind of evidence", () => {
    for (const ev of evidences) {
      if (ev.kind !== "refs" && ev.kind !== "run") continue;
      if ((ev.source ?? "airtable") !== "sanoflow") continue;
      expect(SANOFLOW_RUN_ENTITIES as readonly string[], ev.entity).toContain(ev.entity);
      if (ev.kind === "refs")
        expect(
          SANOFLOW_REF_ENTITIES as readonly string[],
          `${ev.entity} links no records`,
        ).toContain(ev.entity);
      else
        expect(
          SANOFLOW_RUN_ONLY_ENTITIES as readonly string[],
          `${ev.entity} links records: count them with refs`,
        ).toContain(ev.entity);
    }
  });

  it("the reconciled entities of the sign-off are all real Sanoflow entities", async () => {
    const { RECONCILED_ENTITIES } = await import("../../scripts/import/sanoflow/report");
    for (const e of RECONCILED_ENTITIES)
      expect(SANOFLOW_RUN_ENTITIES as readonly string[]).toContain(e);
  });
});
