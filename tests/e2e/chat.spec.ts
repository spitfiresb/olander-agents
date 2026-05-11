import { test, expect } from "@playwright/test";

// Golden-path smoke test for the chat shell.
//
// The full sign-in flow is gated by Microsoft Entra, which we don't try to
// stub here. Instead, we drive `/chat` with `ALLOW_UNAUTHED_DEV=1` set on
// the local dev server (per `.env.local`), confirming the shell renders, the
// composer accepts input, and the empty-state suggestions are clickable.
//
// To run end-to-end with a real LLM call (costs money), wire an isolated
// Anthropic key in the env and replace the assertion below.
test.describe("chat shell", () => {
  test("renders empty state with suggestion chips", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByRole("heading", { name: /how can i help/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /helicoil/i }),
    ).toBeVisible();
  });

  test("composer accepts text and the Send button is reachable", async ({
    page,
  }) => {
    await page.goto("/chat");
    const composer = page.locator("textarea[data-composer-input]");
    await composer.fill("hello");
    await expect(composer).toHaveValue("hello");
    await expect(page.getByRole("button", { name: /send message/i })).toBeEnabled();
  });
});
