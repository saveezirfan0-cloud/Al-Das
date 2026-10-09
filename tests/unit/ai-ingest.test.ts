import { describe, expect, it } from "vitest";

import { chunkText } from "@/lib/ai/ingest/chunk";
import { contentHash, extractText, htmlToText, UnsupportedContentError } from "@/lib/ai/ingest/extract";

describe("chunkText", () => {
  it("merges short paragraphs up to the size and keeps paragraph breaks", () => {
    const chunks = chunkText("First para.\n\nSecond para.\n\nThird para.", { size: 30 });
    expect(chunks).toEqual(["First para.\n\nSecond para.", "Third para."]);
  });

  it("splits a long paragraph on sentence boundaries with overlap and never exceeds the size", () => {
    const sentence = "The clinic is open every day of the week. ";
    const text = sentence.repeat(60);
    const chunks = chunkText(text, { size: 200, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks[0].endsWith(".")).toBe(true);
    // overlap: the start of chunk n+1 repeats the tail of chunk n
    const tail = chunks[0].slice(-15);
    expect(chunks[1].includes(tail.trim().split(" ").slice(-2).join(" "))).toBe(true);
  });

  it("splits text with no spaces (e.g. a long token) without looping forever", () => {
    const chunks = chunkText("a".repeat(2500), { size: 800, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => c.length <= 800)).toBe(true);
  });

  it("is deterministic and handles empty / whitespace input", () => {
    const text = "Alpha beta gamma.\n\nDelta epsilon.";
    expect(chunkText(text)).toEqual(chunkText(text));
    expect(chunkText("")).toEqual([]);
    expect(chunkText(" \n\n \t ")).toEqual([]);
  });

  it("chunks Arabic text", () => {
    const chunks = chunkText("مرحبا بكم في العيادة. " + "نحن نعمل كل يوم. ".repeat(100), { size: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("مرحبا");
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles, nav/footer and comments, decodes entities, keeps block breaks", () => {
    const html = `<!doctype html><html><head><title>Opening &amp; Hours</title><style>p{color:red}</style></head>
      <body><nav>Menu</nav><script>alert('x')</script><!-- hidden -->
      <h1>Hours</h1><p>Open 8&nbsp;am &ndash; 8 pm</p><ul><li>Sat</li><li>Sun&#33;</li></ul><footer>Copyright</footer></body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("Opening & Hours");
    expect(text).toContain("Hours");
    expect(text).toContain("Open 8 am – 8 pm");
    expect(text).toContain("Sun!");
    expect(text).not.toMatch(/alert|color:red|Menu|Copyright|hidden/);
    expect(text.split("\n\n").length).toBeGreaterThan(2);
  });

  it("leaves unknown entities alone and survives broken markup", () => {
    expect(htmlToText("<p>a &unknown; b <b>bold</p>").text).toBe("a &unknown; b bold");
  });
});

describe("extractText", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("reads plain text and markdown", async () => {
    expect((await extractText({ bytes: bytes("# Title\nBody"), mime: "text/markdown" })).text).toBe("# Title\nBody");
    expect((await extractText({ bytes: bytes("hi"), mime: "application/octet-stream", filename: "notes.txt" })).text).toBe("hi");
  });

  it("detects html by mime or extension", async () => {
    const r = await extractText({ bytes: bytes("<p>Hello</p>"), mime: "text/html; charset=utf-8" });
    expect(r.text).toBe("Hello");
    expect((await extractText({ bytes: bytes("<p>Hi</p>"), mime: "application/octet-stream", filename: "a.html" })).text).toBe("Hi");
  });

  it("extracts text from a real PDF", async () => {
    // A minimal one-page PDF. The xref offsets are deliberately omitted: pdf.js rebuilds them.
    const stream = "BT /F1 18 Tf 20 100 Td (The clinic opens at 8am) Tj ET";
    const pdf = [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
      `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
      "trailer<</Root 1 0 R/Size 6>>",
      "%%EOF",
    ].join("\n");
    const r = await extractText({ bytes: new TextEncoder().encode(pdf), mime: "application/pdf" });
    expect(r.text).toContain("The clinic opens at 8am");
  });

  it("rejects unsupported types with a clear reason", async () => {
    await expect(extractText({ bytes: bytes("x"), mime: "image/png", filename: "a.png" })).rejects.toThrow(UnsupportedContentError);
    await expect(extractText({ bytes: bytes("x"), mime: "application/zip" })).rejects.toThrow(/Unsupported file type/);
  });
});

describe("contentHash", () => {
  it("is stable and sensitive to content", () => {
    expect(contentHash("a")).toBe(contentHash("a"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
    expect(contentHash("a")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("htmlToText on hostile input", () => {
  const time = (fn: () => unknown) => {
    const t = Date.now();
    fn();
    return Date.now() - t;
  };

  it("stays linear on unclosed or dense block tags (a quadratic regex took seconds here)", () => {
    expect(time(() => htmlToText("<script ".repeat(200_000)))).toBeLessThan(1500);
    expect(time(() => htmlToText("<nav>x</nav>".repeat(150_000)))).toBeLessThan(1500);
    expect(time(() => htmlToText("<title ".repeat(200_000)))).toBeLessThan(1500);
    expect(time(() => htmlToText("<script ".repeat(200_000) + ">"))).toBeLessThan(1500);
    expect(time(() => htmlToText("<!--".repeat(200_000)))).toBeLessThan(1500);
    expect(time(() => htmlToText("<a".repeat(300_000)))).toBeLessThan(1500);
  });

  it("only removes real block tags, handles case and unclosed openers", () => {
    expect(htmlToText("<p>keep</p><NAV>menu</NAV><navigation>stay</navigation><SCRIPT>bad()</SCRIPT>").text).toBe("keep\n\nstay");
    expect(htmlToText("<p>before</p><script src=x><p>after</p>").text).toBe("before\n\nafter");
  });

  it("ignores everything past the size cap", () => {
    const html = "<p>start</p>" + "a".repeat(2_100_000) + "<p>TAIL-MARKER</p>";
    expect(htmlToText(html).text).not.toContain("TAIL-MARKER");
  });
});
