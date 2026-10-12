import type { MetadataRoute } from "next";

/** Lets staff install Pulse on a phone or front-desk PC and open it like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Pulse · Al Das Medical",
    short_name: "Pulse",
    description: "Clinic inbox, appointments and back office",
    start_url: "/", // the home route sends each role to its own landing page
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#1d4f9c",
    lang: "en",
    categories: ["medical", "business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    // Long-press the installed icon for these.
    shortcuts: [
      {
        name: "Inbox",
        short_name: "Inbox",
        url: "/inbox",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Tasks",
        short_name: "Tasks",
        url: "/tasks",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Appointments",
        short_name: "Diary",
        url: "/appointments",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Notifications",
        short_name: "Alerts",
        url: "/notifications",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
