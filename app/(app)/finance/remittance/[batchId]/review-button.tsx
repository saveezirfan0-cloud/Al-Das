"use client";

import { RunButton } from "@/components/finance/forms";

import { reviewRemittanceLine } from "../actions";

export function ReviewButton({ id }: { id: string }) {
  return <RunButton action={() => reviewRemittanceLine({ id })}>Mark reviewed</RunButton>;
}
