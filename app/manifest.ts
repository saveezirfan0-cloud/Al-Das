import type { MetadataRoute } from "next";

/** Lets staff install Pulse on a phone or front-desk PC and open it like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pulse · Al Das Medical",
    short_name: "Pulse",
    description: "Clinic inbox, appointments and back office",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1d4f9c",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
