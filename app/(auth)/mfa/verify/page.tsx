import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";

import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Two-step verification" };
export const dynamic = "force-dynamic";

export default async function MfaVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!(await getCurrentUser())) redirect("/login");
  const { next } = await searchParams;
  return <VerifyForm next={next} />;
}
