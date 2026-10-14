// Regenerates the PNG app icons in public/icons from the Pulse mark (same artwork as app/icon.svg).
// Run: node scripts/pwa-icons.mjs   (needs `sharp`, which Next.js installs as an optional dependency)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

// sharp is not a direct dependency (Next.js pulls it in). Resolve it from wherever pnpm put it.
import { readdirSync } from "node:fs";
const store = path.join(process.cwd(), "node_modules/.pnpm");
const dir = readdirSync(store).find((d) => d.startsWith("sharp@"));
const require = createRequire(path.join(store, dir ?? "", "node_modules/sharp/package.json"));
const sharp = require("sharp");

const BLUE = "#277880"; // Al Das deep teal (white mark 5.1:1)
const line = (scale, offset) =>
  `<g transform="translate(${offset} ${offset}) scale(${scale})"><path d="M8 33h13l5-12 8 24 6-16 4 4h12" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></g>`;
// "any" icons keep the rounded tile; maskable icons are full-bleed with the mark inside the 80% safe zone.
const any = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${BLUE}"/>${line(1, 0)}</svg>`;
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BLUE}"/>${line(0.62, 12.2)}</svg>`;
const apple = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BLUE}"/>${line(0.8, 6.4)}</svg>`;

mkdirSync("public/icons", { recursive: true });
const jobs = [
  [any, 192, "public/icons/icon-192.png"],
  [any, 512, "public/icons/icon-512.png"],
  [maskable, 512, "public/icons/maskable-512.png"],
  [apple, 180, "public/icons/apple-touch-icon.png"],
];
for (const [svg, size, out] of jobs) {
  await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
  console.log("wrote", out);
}
