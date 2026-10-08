import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <LoginForm
      next={next}
      initialError={error === "auth" ? "That sign-in link is invalid or has expired." : undefined}
    />
  );
}
