"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { checkRateLimit, clientIp, RATE_RULES, waitText } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const credentials = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  next: z.string().optional(),
});

export type AuthState = { error?: string; message?: string } | undefined;

function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  return next;
}

async function throttled(
  checks: Array<[scope: string, id: string, rule: (typeof RATE_RULES)[keyof typeof RATE_RULES]]>,
): Promise<AuthState> {
  const admin = createAdminClient();
  for (const [scope, id, rule] of checks) {
    const r = await checkRateLimit(admin, scope, id, rule);
    if (!r.allowed) return { error: `Too many attempts. Try again in ${waitText(r.retryAfter)}.` };
  }
  return undefined;
}

export async function signInWithPassword(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const blocked = await throttled([
    ["login-ip", clientIp(await headers()), RATE_RULES.loginPerIp],
    ["login-email", parsed.data.email, RATE_RULES.loginPerEmail],
  ]);
  if (blocked) return blocked;

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) return { error: "Email or password is incorrect." };
  redirect(safeNext(parsed.data.next));
}

export async function sendMagicLink(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = z
    .object({
      email: z.string().trim().email("Enter a valid email address"),
      next: z.string().optional(),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const blocked = await throttled([
    ["login-ip", clientIp(await headers()), RATE_RULES.loginPerIp],
    ["magic-link-email", parsed.data.email, RATE_RULES.magicLinkPerEmail],
  ]);
  if (blocked) return blocked;

  const supabase = await createClient();
  const { APP_URL } = serverEnv();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${APP_URL}/auth/callback?next=${encodeURIComponent(safeNext(parsed.data.next))}`,
    },
  });
  if (error)
    return {
      error: "We couldn't send a link to that address. Ask your admin for an invite if you're new.",
    };
  return { message: "Check your inbox for a sign-in link." };
}
