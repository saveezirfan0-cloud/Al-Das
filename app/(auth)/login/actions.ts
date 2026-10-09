"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { magicLinkErrorMessage } from "@/lib/auth/magic-link-error";
import { serverEnv } from "@/lib/env";
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

export async function signInWithPassword(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

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

  const supabase = await createClient();
  const { APP_URL } = serverEnv();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${APP_URL}/auth/callback?next=${encodeURIComponent(safeNext(parsed.data.next))}`,
    },
  });
  if (error) {
    console.warn("[auth] magic link failed", { code: error.code, status: error.status });
    return { error: magicLinkErrorMessage(error) };
  }
  return { message: "Check your inbox for a sign-in link." };
}
