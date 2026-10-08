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
  });
}
