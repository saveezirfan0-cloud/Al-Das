import { config } from "dotenv";
import path from "node:path";

// Local overrides first, then the shared dev env. Neither is required for unit tests.
config({ path: path.resolve(process.cwd(), ".env.test.local"), override: false });
config({ path: path.resolve(process.cwd(), ".env.local"), override: false });
