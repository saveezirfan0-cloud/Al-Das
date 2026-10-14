/**
 * Where a signed-in person lands: the one rule now lives in lib/shell/landing.ts (Phase D, every role). Kept as a
 * re-export so older imports and the Receptionist / Doctor tests keep working.
 */
export { DEFAULT_LANDING_PATH, landingPathFor } from "@/lib/shell/landing";

export const FRONT_DESK_PATH = "/front-desk";
export const MY_DAY_PATH = "/my-day";
