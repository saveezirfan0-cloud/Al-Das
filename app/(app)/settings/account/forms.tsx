"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { changePassword, updateProfile, type FormState } from "./actions";

const TIMEZONES = [
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Europe/London",
  "UTC",
];

export function ProfileForm({
  profile,
  email,
  orgTimezone,
  roleName,
}: {
  profile: {
    first_name: string;
    last_name: string;
    designation: string;
    timezone: string;
    language: "en" | "ar";
  };
  email: string;
  orgTimezone: string;
  roleName: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateProfile, undefined);
  const tzOptions =
    TIMEZONES.includes(profile.timezone) || !profile.timezone
      ? TIMEZONES
      : [profile.timezone, ...TIMEZONES];
  return (
    <form action={action} className="grid max-w-xl gap-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="first_name">First name</Label>
          <Input id="first_name" name="first_name" defaultValue={profile.first_name} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="last_name">Last name</Label>
          <Input id="last_name" name="last_name" defaultValue={profile.last_name} />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label>Email</Label>
          <Input value={email} disabled />
        </div>
        <div className="grid gap-2">
          <Label>Role</Label>
          <Input value={roleName} disabled />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="designation">Designation</Label>
        <Input
          id="designation"
          name="designation"
          defaultValue={profile.designation}
          placeholder="e.g. Patient coordinator"
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="timezone">Timezone</Label>
          <Select name="timezone" defaultValue={profile.timezone || "__org__"}>
            <SelectTrigger id="timezone" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__org__">Workspace default ({orgTimezone})</SelectItem>
              {tzOptions.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="language">Language</Label>
          <Select name="language" defaultValue={profile.language}>
            <SelectTrigger id="language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="ar">العربية</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {state?.error && (
        <p className="text-destructive text-sm" role="alert">
          {state.error}
        </p>
      )}
      {state?.message && (
        <p className="text-sm text-emerald-700" role="status">
          {state.message}
        </p>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save profile
        </Button>
      </div>
    </form>
  );
}

export function PasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changePassword, undefined);
  return (
    <form action={action} className="grid max-w-xl gap-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="confirm">Confirm</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
      </div>
      {state?.error && (
        <p className="text-destructive text-sm" role="alert">
          {state.error}
        </p>
      )}
      {state?.message && (
        <p className="text-sm text-emerald-700" role="status">
          {state.message}
        </p>
      )}
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Update password
        </Button>
      </div>
    </form>
  );
}
