import { Activity } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    // A soft brand-tinted glow over the muted surface; tokens keep it right in dark mode.
    <div className="bg-muted/40 from-primary/12 flex min-h-svh flex-col items-center justify-center gap-6 bg-radial-[ellipse_at_top] to-transparent to-70% p-6 md:p-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg shadow-sm">
            <Activity className="size-5" aria-hidden />
          </span>
          Pulse
        </div>
        <p className="text-muted-foreground text-sm">Al Das Medical clinic platform</p>
      </div>
      <main className="w-full max-w-sm">{children}</main>
    </div>
  );
}
