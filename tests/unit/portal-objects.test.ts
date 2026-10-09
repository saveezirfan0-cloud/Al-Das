import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PORTAL_OBJECTS, getPortalObject, requirePortalObject } from "@/lib/portal/objects";
import { portalObjectPermissionKeys, isPortalPermissionKey } from "@/lib/portal/permissions";
import { isAssignablePermission } from "@/lib/auth/permissions";

const MIGRATIONS = join(__dirname, "../../supabase/migrations");
const framework = readFileSync(join(MIGRATIONS, "20261008001100_portal_framework.sql"), "utf8");

describe("portal object registry", () => {
  it("has unique object keys and unique, snake_case column keys", () => {
    expect(new Set(PORTAL_OBJECTS.map((o) => o.key)).size).toBe(PORTAL_OBJECTS.length);
    for (const o of PORTAL_OBJECTS) {
      expect(o.key).toMatch(/^[a-z][a-z0-9_]{0,48}$/);
      expect(o.table).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
      const keys = o.columns.map((c) => c.key);
      expect(new Set(keys).size, o.key).toBe(keys.length);
      for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("titleColumn, search columns and default sort refer to real columns", () => {
    for (const o of PORTAL_OBJECTS) {
      const keys = new Set([...o.columns.map((c) => c.key), "created_at", "updated_at"]);
      expect(keys.has(o.titleColumn), `${o.key}.titleColumn`).toBe(true);
      for (const c of o.searchColumns) expect(keys.has(c), `${o.key} search ${c}`).toBe(true);
      for (const s of o.defaultSort)
        expect(keys.has(s.field), `${o.key} sort ${s.field}`).toBe(true);
    }
  });

  it("link columns point at registered objects and select columns have options", () => {
    for (const o of PORTAL_OBJECTS) {
      for (const c of o.columns) {
        if (c.type === "link")
          expect(getPortalObject(c.link?.object ?? ""), `${o.key}.${c.key}`).toBeDefined();
        if (c.type === "select") expect(c.options?.length, `${o.key}.${c.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("permission keys follow the portal.<object>.read|write convention", () => {
    for (const o of PORTAL_OBJECTS) {
      expect(o.readPerm).toBe(`portal.${o.key}.read`);
      if (o.writePerm) expect(isPortalPermissionKey(o.writePerm)).toBe(true);
      expect(isAssignablePermission(o.readPerm)).toBe(true);
    }
    expect(portalObjectPermissionKeys().length).toBeGreaterThanOrEqual(PORTAL_OBJECTS.length);
  });

  it("requirePortalObject throws on unknown keys", () => {
    expect(() => requirePortalObject("nope")).toThrow();
  });

  it("seed_portal_objects in the migration stays in sync with the code registry", () => {
    for (const o of PORTAL_OBJECTS) {
      const row = new RegExp(
        `\\(p_org, '${o.key}',\\s*'[^']*',\\s*'[^']*',\\s*'${o.table}',\\s*'${o.sourceAirtable}',\\s*'${o.readPerm.replace(/\./g, "\\.")}',\\s*'${(o.writePerm ?? "").replace(/\./g, "\\.")}'`,
      );
      expect(framework, `seed row for ${o.key}`).toMatch(row);
    }
  });
});
