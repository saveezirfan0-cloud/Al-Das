import { describe, expect, it } from "vitest";

import { buildDigests, type DigestMember, type OpenException } from "@/lib/finance/digest";
import { holds, isOverdue, ownerPermission, RULE_CODES, RULE_INFO } from "@/lib/finance/rules";
import {
  currentMonth,
  groupRevenue,
  monthParam,
  monthsAgo,
  totals,
  type RevenueRow,
} from "@/lib/finance/summary";
import { csvEscape } from "@/lib/csv";

const TODAY = new Date("2026-10-09T08:00:00Z");

describe("rules helpers", () => {
  it("maps owner roles to the permission that shows their queue (mirrors app.fin_owner_perm)", () => {
    expect(ownerPermission("insurance")).toBe("finance.claims.view");
    expect(ownerPermission("billing")).toBe("finance.invoices.view");
    expect(ownerPermission("finance")).toBe("finance.view");
    expect(ownerPermission("admin")).toBe("finance.capture.manage");
    expect(ownerPermission("anything-else")).toBe("finance.capture.manage"); // unknown fails towards admins
  });

  it("every rule has a title, meaning and next step", () => {
    expect(RULE_CODES).toEqual([
      "E01",
      "E02",
      "E03",
      "E04",
      "E05",
      "E06",
      "E07",
      "E08",
      "E09",
      "E10",
    ]);
    for (const c of RULE_CODES) {
      expect(RULE_INFO[c].title.length).toBeGreaterThan(3);
      expect(RULE_INFO[c].meaning.length).toBeGreaterThan(10);
      expect(RULE_INFO[c].action.length).toBeGreaterThan(10);
    }
  });

  it("overdue means strictly before today and still active", () => {
    expect(isOverdue("2026-10-08", "open", TODAY)).toBe(true);
    expect(isOverdue("2026-10-09", "open", TODAY)).toBe(false);
    expect(isOverdue("2026-10-01", "closed", TODAY)).toBe(false);
    expect(isOverdue("2026-10-01", "auto_closed", TODAY)).toBe(false);
    expect(isOverdue(null, "open", TODAY)).toBe(false);
  });

  it("holds honours wildcards", () => {
    expect(holds(["*"], "finance.claims.view")).toBe(true);
    expect(holds(["finance.view"], "finance.claims.view")).toBe(false);
  });
});

describe("buildDigests", () => {
  const ex = (
    rule: string,
    owner: string,
    due: string | null = "2026-10-20",
    status = "open",
  ): OpenException => ({ rule_code: rule, owner_role: owner, due_date: due, status });
  const member = (id: string, perms: string[], email = `${id}@example.test`): DigestMember => ({
    userId: id,
    email,
    firstName: id,
    permissions: perms,
  });
  const exceptions = [
    ex("E01", "insurance"),
    ex("E01", "insurance", "2026-10-01"),
    ex("E04", "insurance"),
    ex("E03", "billing"),
    ex("E07", "admin"),
  ];

  it("sends each member only their queue, with overdue counts", () => {
    const mails = buildDigests(
      exceptions,
      [
        member("sharaf", [
          "finance.claims.view",
          "finance.claims.import",
          "finance.exceptions.manage",
        ]),
        member("bill", ["finance.invoices.view", "finance.exceptions.manage"]),
      ],
      "https://pulse.example.test/",
      TODAY,
    );
    const sharaf = mails.find((m) => m.to === "sharaf@example.test");
    const bill = mails.find((m) => m.to === "bill@example.test");
    expect(sharaf?.subject).toBe("Finance exceptions: 3 open, 1 overdue");
    expect(sharaf?.text).toContain("E01  Insurance invoice with no claim: 2 open, 1 overdue");
    expect(sharaf?.text).toContain("E04");
    expect(sharaf?.text).not.toContain("E03");
    expect(bill?.subject).toBe("Finance exceptions: 1 open");
    expect(bill?.text).toContain("https://pulse.example.test/finance/exceptions");
  });

  it("an admin sees every queue; members without the work permission or without items get nothing", () => {
    const mails = buildDigests(
      exceptions,
      [
        member("root", ["*"]),
        member("viewer", ["finance.claims.view"]),
        member("nobody", ["finance.invoices.view", "finance.exceptions.manage"], ""),
      ],
      "https://pulse.example.test",
      TODAY,
    );
    expect(mails.map((m) => m.to)).toEqual(["root@example.test"]);
    expect(mails[0].subject).toBe("Finance exceptions: 5 open, 1 overdue");
    expect(buildDigests([], [member("root", ["*"])], "https://x", TODAY)).toEqual([]);
  });

  it("never puts entity identifiers or patient detail in the e-mail", () => {
    const mails = buildDigests(
      [{ rule_code: "E01", owner_role: "insurance", due_date: null, status: "open" }],
      [member("root", ["*"])],
      "https://x",
      TODAY,
    );
    expect(mails[0].text).not.toMatch(/ADMC|PIN|\d{3}-\d{4}/);
  });
});

describe("summary helpers", () => {
  it("sums columns to cents and treats null as zero", () => {
    const t = totals([
      {
        month: "2026-03-01",
        branch_code: "P",
        generated: 100.1,
        claimed: 50,
        remitted: null,
        rejected: 0.2,
        outstanding: 49.8,
        self_pay_collected: null,
      },
      {
        month: "2026-03-01",
        branch_code: "M",
        generated: 0.2,
        claimed: null,
        remitted: 10,
        rejected: 0.1,
        outstanding: null,
        self_pay_collected: 5,
      },
    ]);
    expect(t).toEqual({
      generated: 100.3,
      claimed: 50,
      remitted: 10,
      rejected: 0.3,
      outstanding: 49.8,
      self_pay_collected: 5,
    });
  });

  it("validates month parameters and computes ranges", () => {
    expect(monthParam("2026-03", "x")).toBe("2026-03");
    expect(monthParam("2026-13", "x")).toBe("x");
    expect(monthParam("'; drop", "x")).toBe("x");
    expect(currentMonth(TODAY)).toBe("2026-10");
    expect(monthsAgo(11, TODAY)).toBe("2025-11");
    expect(monthsAgo(0, TODAY)).toBe("2026-10");
  });

  it("groups revenue by the chosen dimension, largest first, with sensible labels for blanks", () => {
    const rows: RevenueRow[] = [
      {
        branch_code: "P",
        department: "GP",
        doctor_name: "Dr A",
        doctor_dha_id: "D1",
        service_category: "Consult",
        gross: 100,
        discount: 10,
        net: 90,
        vat: 4.5,
      },
      {
        branch_code: "M",
        department: "GP",
        doctor_name: null,
        doctor_dha_id: "D2",
        service_category: null,
        gross: 50,
        discount: 0,
        net: 50,
        vat: 2.5,
      },
      {
        branch_code: null,
        department: null,
        doctor_name: null,
        doctor_dha_id: null,
        service_category: "Lab",
        gross: 10,
        discount: 0,
        net: 10,
        vat: 0,
      },
    ];
    expect(groupRevenue(rows, "department").map((g) => [g.label, g.net])).toEqual([
      ["GP", 140],
      ["No department", 10],
    ]);
    expect(groupRevenue(rows, "doctor").map((g) => g.label)).toEqual([
      "Dr A",
      "D2",
      "Unknown doctor",
    ]);
    expect(groupRevenue(rows, "service_category").map((g) => g.label)).toEqual([
      "Consult",
      "Unmapped",
      "Lab",
    ]);
    expect(groupRevenue(rows, "branch").map((g) => g.label)).toEqual(["P", "M", "Unknown branch"]);
  });

  it("CSV cells starting with a formula character are neutralised", () => {
    expect(csvEscape("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvEscape("@cmd")).toBe("'@cmd");
  });
});
