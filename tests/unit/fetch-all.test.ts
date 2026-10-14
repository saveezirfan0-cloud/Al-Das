import { describe, expect, it } from "vitest";

import { fetchAll } from "@/lib/supabase/fetch-all";

/** A fake PostgREST table: serves `[from, to]` slices, capped at `cap` rows per response like max_rows. */
function fakeTable(total: number, cap = 1000) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: Array<[number, number]> = [];
  const build = (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to + 1, from + cap);
    return Promise.resolve({ data: rows.slice(from, end), error: null });
  };
  return { build, calls };
}

describe("fetchAll", () => {
  it("returns every row past the 1,000-row server cap", async () => {
    const t = fakeTable(2500);
    const res = await fetchAll(t.build);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2500);
    expect(res.data?.map((r) => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
    expect(res.truncated).toBe(false);
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("stops after one request when the first page is short", async () => {
    const t = fakeTable(10);
    const res = await fetchAll(t.build);
    expect(res.data).toHaveLength(10);
    expect(t.calls).toHaveLength(1);
  });

  it("asks one more page when the total is an exact multiple of the page size", async () => {
    const t = fakeTable(2000);
    const res = await fetchAll(t.build);
    expect(res.data).toHaveLength(2000);
    expect(t.calls).toHaveLength(3);
    expect(res.truncated).toBe(false);
  });

  it("handles an empty table", async () => {
    const t = fakeTable(0);
    const res = await fetchAll(t.build);
    expect(res).toEqual({ data: [], error: null, truncated: false });
  });

  it("honours a smaller page size and clamps a larger one to 1,000", async () => {
    const small = fakeTable(450);
    expect((await fetchAll(small.build, { pageSize: 200 })).data).toHaveLength(450);
    expect(small.calls).toEqual([
      [0, 199],
      [200, 399],
      [400, 599],
    ]);
    const big = fakeTable(1500);
    expect((await fetchAll(big.build, { pageSize: 5000 })).data).toHaveLength(1500);
    expect(big.calls[0]).toEqual([0, 999]);
  });

  it("stops at the hard max and reports truncation", async () => {
    const t = fakeTable(10_000);
    const res = await fetchAll(t.build, { max: 2500 });
    expect(res.data).toHaveLength(2500);
    expect(res.truncated).toBe(true);
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2499],
    ]);
  });

  it("does not loop forever on a builder that always returns a full page", async () => {
    let n = 0;
    const res = await fetchAll(
      (from, to) => {
        n++;
        return Promise.resolve({
          data: Array.from({ length: to - from + 1 }, () => ({ x: 1 })),
          error: null,
        });
      },
      { max: 5000 },
    );
    expect(n).toBe(5);
    expect(res.truncated).toBe(true);
    expect(res.data).toHaveLength(5000);
  });

  it("returns the error and no rows when any page fails", async () => {
    let n = 0;
    const res = await fetchAll((from, to) => {
      n++;
      if (n === 2) return Promise.resolve({ data: null, error: { message: "boom" } });
      return Promise.resolve({
        data: Array.from({ length: to - from + 1 }, (_, i) => from + i),
        error: null,
      });
    });
    expect(res).toEqual({ data: null, error: { message: "boom" }, truncated: false });
  });
});
