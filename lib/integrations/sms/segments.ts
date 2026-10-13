/**
 * How many billable parts an SMS will be (pure). GSM-7 text is 160 characters in one part and 153 per part when joined;
 * anything outside the GSM alphabet (Arabic, most emoji, curly quotes) switches the whole message to UCS-2: 70 and 67.
 * Used for the daily counters and the cost estimate, and to keep reminders short.
 */
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "\f^{}\\[~]|€";

export type SmsLength = { encoding: "gsm7" | "ucs2"; units: number; segments: number };

export function smsLength(text: string): SmsLength {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch) && ch !== "\u001b") units += 1;
    else if (GSM_EXTENDED.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return {
      encoding: "gsm7",
      units,
      segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153),
    };
  }
  const ucs2Units = text.length; // UTF-16 code units, as the network counts them
  return {
    encoding: "ucs2",
    units: ucs2Units,
    segments: ucs2Units <= 70 ? 1 : Math.ceil(ucs2Units / 67),
  };
}
