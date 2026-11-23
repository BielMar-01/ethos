import { test, expect } from "@playwright/test";
import { openPanel } from "./helpers";

const noHorizontalScroll = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe("celular", () => {
  test("home: sem rolagem lateral, menu em gaveta com as seções", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    // Menu de navegação fica escondido até abrir.
    await expect(page.getByRole("navigation", { name: "Principal" })).toBeHidden();
    await page.getByRole("button", { name: "Abrir menu" }).click();
    const drawer = page.getByRole("navigation", { name: "Menu" });
    await expect(drawer.getByRole("button", { name: "Funcionalidades" })).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-results/_mobile-home-menu.png" });
    await drawer.getByRole("button", { name: "Segurança" }).click();
    await expect(page.locator("#seguranca")).toBeInViewport();
  });

  test("login: formulário inteiro visível, sem painel lateral e sem rolagem lateral", async ({ page }) => {
    await page.goto("/#/entrar");
    await expect(page.locator(".auth-aside")).toBeHidden();
    await expect(page.getByRole("button", { name: "Entrar", exact: true })).toBeInViewport();
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.waitForTimeout(700);
    await page.screenshot({ path: "test-results/_mobile-login.png" });
  });

  test("painel: gaveta lista os itens na vertical, tem usuário e Sair, e fecha ao escolher", async ({ page }) => {
    await openPanel(page);
    expect(await noHorizontalScroll(page)).toBe(true);
    const sidebar = page.getByRole("complementary", { name: "Menu principal" });
    await expect(sidebar).toBeHidden();
    await page.getByRole("button", { name: /menu/i }).first().click();
    await expect(sidebar).toBeVisible();
    await page.waitForTimeout(450); // fim da animação da gaveta
    // Itens empilhados (um embaixo do outro), não numa linha só.
    const a = await sidebar.getByRole("button", { name: "Imóveis", exact: true }).boundingBox();
    const b = await sidebar.getByRole("button", { name: "Unidades", exact: true }).boundingBox();
    expect(b!.y).toBeGreaterThan(a!.y + a!.height - 2);
    expect(Math.abs(a!.x - b!.x)).toBeLessThan(2);
    await expect(sidebar.getByRole("button", { name: "Sair" })).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-results/_mobile-drawer.png" });
    await sidebar.getByRole("button", { name: "Imóveis", exact: true }).click();
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole("heading", { name: "Imóveis" })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test("Esc e o fundo escuro fecham a gaveta", async ({ page }) => {
    await openPanel(page);
    const sidebar = page.getByRole("complementary", { name: "Menu principal" });
    await page.getByRole("button", { name: /menu/i }).first().click();
    await expect(sidebar).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();
    await page.getByRole("button", { name: /menu/i }).first().click();
    await page.locator(".scrim").click({ position: { x: 380, y: 300 } });
    await expect(sidebar).toBeHidden();
  });

  test("listas e formulários não estouram a largura da tela", async ({ page }) => {
    await openPanel(page);
    for (const label of ["Proprietários", "Contratos", "Financeiro", "Manutenção", "Importar dados", "Registros"]) {
      await page.getByRole("button", { name: /menu/i }).first().click();
      await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByRole("heading", { name: new RegExp(label.split(" ")[0]!) }).first()).toBeVisible();
      expect(await noHorizontalScroll(page), `rolagem lateral em ${label}`).toBe(true);
    }
  });
});
