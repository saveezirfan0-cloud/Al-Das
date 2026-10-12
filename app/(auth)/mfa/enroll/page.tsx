import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";

import { EnrollForm } from "./enroll-form";

export const metadata: Metadata = { title: "Set up two-step verification" };
export const dynamic = "force-dynamic";

export default async function MfaEnrollPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!(await getCurrentUser())) redirect("/login");
  const { next } = await searchParams;
  return <EnrollForm next={next} />;
}
