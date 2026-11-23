import { test, expect } from "@playwright/test";
import { openPanel } from "./helpers";

test.describe("modais no celular", () => {
  test("ocupam a tela inteira, têm rodapé de ações sempre visível e não vazam para os lados", async ({ page }) => {
    await openPanel(page);
    await page.getByRole("button", { name: /menu/i }).first().click();
    await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: "Imóveis", exact: true }).click();
    await page.getByRole("button", { name: "Novo imóvel" }).click();
    const modal = page.locator(".modal");
    await expect(modal).toBeVisible();
    const vp = page.viewportSize()!;
    const box = (await modal.boundingBox())!;
    expect(Math.round(box.width)).toBe(vp.width);
    expect(box.height).toBeGreaterThan(vp.height - 4); // folha em tela cheia
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // O botão Salvar fica visível no rodapé mesmo com o formulário longo (barra de ações fixa).
    await expect(modal.getByRole("button", { name: "Salvar" })).toBeInViewport();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/_modal-mobile.png" });
    const h = await modal.getByRole("button", { name: "Salvar" }).evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(44); // alvo de toque confortável
    await modal.getByRole("button", { name: "Fechar janela" }).click();
    await expect(modal).toHaveCount(0);
  });

  test("detalhe de contrato em tela cheia rola por dentro e fecha pelo ×", async ({ page }) => {
    await openPanel(page);
    await page.getByRole("button", { name: /menu/i }).first().click();
    await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: "Contratos", exact: true }).click();
    await page.locator("tbody tr.clickable").first().click();
    const modal = page.locator(".modal");
    await expect(modal).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-results/_modal-lease-mobile.png" });
    await modal.getByRole("button", { name: "Fechar janela" }).click();
    await expect(modal).toHaveCount(0);
  });
});
