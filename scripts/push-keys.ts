/**
 * pnpm push:keys: generate a VAPID key pair for Web Push and print it as environment lines.
 * Nothing is written to disk. Put the lines in Vercel (Production and Preview) and `.env.local`; keep the
 * private key out of chat, git and screenshots. Changing the pair later makes every registered device stop
 * receiving pushes until its owner turns push on again (Settings, Notifications).
 */
import { generateVapidKeys } from "../lib/push/vapid";

const { publicKey, privateKey } = generateVapidKeys();
console.log("# Web Push (VAPID). Add these to the environment. The private key is a secret.");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(
  "VAPID_SUBJECT=mailto:it@your-clinic.example   # a contact address push services can reach",
);
