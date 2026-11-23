import { test, expect } from "@playwright/test";
import { ADMIN, OWNER, TENANT, createColaborador, loginUi, openPanel } from "./helpers";

test.describe("painel: login, menu e sair", () => {
  test("login pela tela leva ao painel; Sair fica no menu (não no topo) e volta ao início", async ({ page }) => {
    await loginUi(page);
    const sidebar = page.getByRole("complementary", { name: "Menu principal" });
    await expect(sidebar.getByRole("button", { name: "Sair" })).toBeVisible();
    await expect(page.getByRole("banner").getByRole("button", { name: "Sair" })).toHaveCount(0);
    await expect(sidebar.getByText("Ana Administradora")).toBeVisible();
    await sidebar.getByRole("button", { name: "Sair" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Administração de imóveis");
    // Sessão encerrada de verdade no servidor.
    expect((await page.request.get("/api/auth/me")).ok()).toBeTruthy();
    expect((await (await page.request.get("/api/auth/me")).json()).user).toBeNull();
  });

  test("o menu recolhe e expande no computador e a escolha é lembrada", async ({ page }) => {
    await openPanel(page);
    const shell = page.locator(".shell");
    const toggle = page.getByRole("button", { name: /(Recolher|Expandir) menu/ });
    // Começa expandido em telas ≥ 1200 px.
    await expect(shell).not.toHaveClass(/collapsed/);
    const wide = (await page.locator(".sidebar").boundingBox())!.width;
    await toggle.click();
    await expect(shell).toHaveClass(/collapsed/);
    await expect.poll(async () => (await page.locator(".sidebar").boundingBox())!.width).toBeLessThan(100);
    expect(wide).toBeGreaterThan(200);
    // Recolhido: só ícones, com dica no hover (title) e o conteúdo ocupa o espaço.
    await expect(page.getByRole("button", { name: "Imóveis" }).first()).toHaveAttribute("title", "Imóveis");
    await page.reload();
    await expect(page.locator(".shell")).toHaveClass(/collapsed/);
    await page.getByRole("button", { name: "Expandir menu" }).click();
    await expect(page.locator(".shell")).not.toHaveClass(/collapsed/);
  });

  test("conteúdo do painel fica centralizado em telas largas", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await openPanel(page);
    const main = await page.locator("main").boundingBox();
    const sidebar = await page.locator(".sidebar").boundingBox();
    const free = 1920 - sidebar!.width;
    const leftGap = main!.x - sidebar!.width;
    const rightGap = 1920 - (main!.x + main!.width);
    expect(Math.abs(leftGap - rightGap)).toBeLessThan(free * 0.06);
  });

  test("administrador vê todas as áreas; colaborador não vê Equipe nem Registros", async ({ page, browser, request }) => {
    await openPanel(page);
    const nav = page.getByRole("complementary", { name: "Menu principal" });
    for (const label of ["Painel", "Imóveis", "Proprietários", "Inquilinos", "Ler documentos", "Importar dados", "Contratos", "Financeiro", "Manutenção", "Vistorias", "Comunicados", "Modelos", "Equipe", "Registros", "API"]) {
      await expect(nav.getByRole("button", { name: label, exact: true }), label).toBeVisible();
    }
    const email = await createColaborador(request, page);
    const ctx = await browser.newContext();
    const colab = await ctx.newPage();
    await openPanel(colab, email);
    const cnav = colab.getByRole("complementary", { name: "Menu principal" });
    await expect(cnav.getByRole("button", { name: "Contratos", exact: true })).toBeVisible();
    await expect(cnav.getByRole("button", { name: "Equipe", exact: true })).toHaveCount(0);
    await expect(cnav.getByRole("button", { name: "Registros", exact: true })).toHaveCount(0);
    await ctx.close();
  });

  test("inquilino e proprietário entram na área do cliente, sem menu da equipe", async ({ page, browser }) => {
    await openPanel(page, TENANT);
    const nav = page.getByRole("complementary", { name: "Menu principal" });
    await expect(nav.getByRole("button", { name: "Minha área" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Financeiro", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Equipe", exact: true })).toHaveCount(0);

    const ctx = await browser.newContext();
    const owner = await ctx.newPage();
    await openPanel(owner, OWNER);
    await expect(owner.getByRole("button", { name: "Minha área" })).toBeVisible();
    await expect(owner.getByRole("button", { name: "Imóveis", exact: true })).toHaveCount(0);
    await ctx.close();
  });

  test("a API recusa o inquilino em rotas da equipe (autorização no servidor)", async ({ page }) => {
    await openPanel(page, TENANT);
    expect((await page.request.get("/api/owners")).status()).toBe(403);
    expect((await page.request.get("/api/audit")).status()).toBe(403);
    expect((await page.request.get("/api/members")).status()).toBe(403);
  });

  test("painel mostra números e atalhos do demo", async ({ page }) => {
    await openPanel(page);
    await expect(page.getByText("Ocupação")).toBeVisible();
    await expect(page.getByText("Pede atenção agora")).toBeVisible();
    await page.getByRole("button", { name: "Gerar cobranças" }).click();
    await expect(page.getByRole("heading", { name: "Financeiro" })).toBeVisible();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void ADMIN;
  });
});
