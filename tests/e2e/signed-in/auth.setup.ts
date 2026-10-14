import { expect, test as setup } from "@playwright/test";

import { authFile, loadSeed, ROLES, SIGNED_IN_SKIP_REASON, signedIn } from "../fixtures/e2e";

setup.skip(!signedIn, SIGNED_IN_SKIP_REASON);

const LANDING: Record<(typeof ROLES)[number], RegExp> = {
  admin: /\/dashboard/,
  receptionist: /\/front-desk/,
  agent: /\/inbox/,
};

/** Each role signs in once through the real login form (password tab); the specs reuse the saved session. */
for (const role of ROLES) {
  setup(`sign in as ${role}`, async ({ page }) => {
    const { email, password } = loadSeed().users[role];
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.locator("input#password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // Each role's home (lib/shell/landing.ts): Receptionist → Front desk, Agent → Inbox, Admin → dashboard.
    await expect(page).toHaveURL(LANDING[role], { timeout: 30_000 });
    await page.context().storageState({ path: authFile(role) });
  });
}
