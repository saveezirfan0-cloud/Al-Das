import { z } from "zod";

/**
 * Lazily validated environment access. Each getter validates only what it needs,
 * so `next build` and unit tests work without a full .env.local.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  JOB_SECRET: z.string().min(16, "JOB_SECRET must be at least 16 characters"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default("Pulse <no-reply@example.com>"),
  ALLOW_WORKSPACE_CREATION: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // Phase 3: Meta / WhatsApp. Optional here; the code paths that need them throw clear errors.
  ENCRYPTION_KEY: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_SYSTEM_USER_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z.string().default("v21.0"),
  // Phase 10: AI + knowledge base. Optional; lib/ai throws a clear "not configured" error where needed.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_PROVIDER: z.enum(["voyage", "fake"]).default("voyage"),
  EMBEDDINGS_MODEL: z.string().default("voyage-3"),
});

export function publicEnv() {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

export function serverEnv() {
  return serverSchema.parse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    JOB_SECRET: process.env.JOB_SECRET,
    APP_URL: process.env.APP_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM: process.env.RESEND_FROM,
    ALLOW_WORKSPACE_CREATION: process.env.ALLOW_WORKSPACE_CREATION,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    META_APP_ID: process.env.META_APP_ID,
    META_APP_SECRET: process.env.META_APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: process.env.META_WEBHOOK_VERIFY_TOKEN,
    META_SYSTEM_USER_TOKEN: process.env.META_SYSTEM_USER_TOKEN,
    META_GRAPH_VERSION: process.env.META_GRAPH_VERSION,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || undefined,
    EMBEDDINGS_API_KEY: process.env.EMBEDDINGS_API_KEY,
    EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER || undefined,
    EMBEDDINGS_MODEL: process.env.EMBEDDINGS_MODEL || undefined,
  });
}
