/**
 * WhatsApp message formatting for previews: *bold*, _italic_, ~strike~, ```mono``` (and `inline`).
 * Pure tokenizer; the component maps spans to elements. Markers only apply when they hug text
 * (no space just inside) and are not part of a word, as in WhatsApp itself.
 */
export type Span = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mono?: boolean;
};

const MARKS: Array<{ open: string; key: keyof Omit<Span, "text"> }> = [
  { open: "```", key: "mono" },
  { open: "`", key: "mono" },
  { open: "*", key: "bold" },
  { open: "_", key: "italic" },
  { open: "~", key: "strike" },
];

function isWordChar(c: string | undefined): boolean {
  return !!c && /[\p{L}\p{N}]/u.test(c);
}

export function tokenizeWhatsAppText(input: string): Span[] {
  const out: Span[] = [];
  const push = (text: string, style: Omit<Span, "text">) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (
      last &&
      last.bold === style.bold &&
      last.italic === style.italic &&
      last.strike === style.strike &&
      last.mono === style.mono
    )
      last.text += text;
    else out.push({ text, ...style });
  };

  const walk = (text: string, style: Omit<Span, "text">) => {
    let i = 0;
    let buf = "";
    while (i < text.length) {
      let matched = false;
      for (const m of MARKS) {
        if (!text.startsWith(m.open, i)) continue;
        const before = text[i - 1];
        const afterOpen = text[i + m.open.length];
        if (isWordChar(before) || afterOpen === undefined || /\s/.test(afterOpen)) continue;
        const close = text.indexOf(m.open, i + m.open.length);
        if (close < 0) continue;
        const inner = text.slice(i + m.open.length, close);
        const beforeClose = text[close - 1];
        const afterClose = text[close + m.open.length];
        if (!inner || /\s/.test(beforeClose) || isWordChar(afterClose)) continue;
        push(buf, style);
        buf = "";
        if (m.key === "mono") push(inner, { ...style, mono: true });
        else walk(inner, { ...style, [m.key]: true });
        i = close + m.open.length;
        matched = true;
        break;
      }
      if (!matched) buf += text[i++];
    }
    push(buf, style);
  };

  walk(input, {});
  return out;
}
