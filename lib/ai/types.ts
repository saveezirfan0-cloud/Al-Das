export const AI_FEATURES = ["summarize", "ask", "suggest_reply", "rewrite"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** Outcome of one AI call, mirrored in ai_usage.status. */
export type AiStatus = "ok" | "error" | "refused" | "needs_review";

/** A message reduced to what a prompt needs. No ids, phone numbers or media. */
export type TranscriptMessage = {
  direction: "in" | "out" | "note";
  kind: string;
  body: string | null;
  at: string;
  /** Outbound only: sent by a staff member (true) or automatically by a flow/template job (false). */
  byStaff?: boolean;
};

export type Passage = {
  chunkId: string;
  sourceId: string;
  sourceName: string;
  content: string;
  similarity: number;
};

export const TONES = ["professional", "friendly", "empathetic", "concise", "formal"] as const;
export type Tone = (typeof TONES)[number];

export const LANGUAGES = ["en", "ar"] as const;
export type Language = (typeof LANGUAGES)[number];

export type RewriteMode =
  | { kind: "tone"; tone: Tone }
  | { kind: "language"; language: Language }
  | { kind: "grammar" };

/** What a feature returns to the server action. Draft text only: nothing here is ever auto-sent. */
export type AiResult = {
  text: string;
  status: AiStatus;
  /** Why a draft needs a human look (empty when status is ok). */
  flags: string[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  /** KB chunks that grounded a suggested reply. */
  chunkIds: string[];
};

export class AiNotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} is not configured. Ask an administrator to set it up.`);
    this.name = "AiNotConfiguredError";
  }
}
