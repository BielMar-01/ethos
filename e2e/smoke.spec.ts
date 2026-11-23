import { test, expect } from "@playwright/test";

test("a API do demo responde e a home abre", async ({ page, request }) => {
  expect((await request.get("/api/health")).ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Administração de imóveis");
  await page.waitForTimeout(1800);
  await page.screenshot({ path: "test-results/_home-desktop.png", fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "test-results/_home-desktop-2.png", fullPage: false });
});
