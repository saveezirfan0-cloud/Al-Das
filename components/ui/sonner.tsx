"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useIsDark } from "@/lib/hooks/use-is-dark";

const Toaster = ({ ...props }: ToasterProps) => {
  // Follow the app theme (not the OS) so rich success / error colours suit the page.
  const isDark = useIsDark();
  return (
    <Sonner
      theme={isDark ? "dark" : "light"}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
