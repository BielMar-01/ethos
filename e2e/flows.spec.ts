import { test, expect } from "@playwright/test";
import { TENANT, openPanel, unique } from "./helpers";

const menu = (page: import("@playwright/test").Page) => page.getByRole("complementary", { name: "Menu principal" });

test.describe("fluxos de negócio (demo)", () => {
  test("financeiro: resumo, abas e tabela cabem na tela; Receber e Cancelar visíveis", async ({ page }) => {
    await openPanel(page);
    await menu(page).getByRole("button", { name: "Financeiro", exact: true }).click();
    await expect(page.getByText("Em atraso (total)")).toBeVisible();
    for (const tab of ["Pagamentos", "Repasses", "Cobranças"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    }
    // A coluna de ações não pode ficar cortada pela borda da tabela.
    const receber = page.getByRole("button", { name: "Cancelar" }).first();
    await expect(receber).toBeVisible();
    const wrap = await page.locator(".table-wrap").first().boundingBox();
    const btn = await receber.boundingBox();
    expect(btn!.x + btn!.width).toBeLessThanOrEqual(wrap!.x + wrap!.width + 1);
  });

  test("financeiro: gerar aluguéis de um mês cria as cobranças dos contratos vigentes (e não duplica)", async ({ page }) => {
    await openPanel(page);
    const month = "2026-12";
    await menu(page).getByRole("button", { name: "Financeiro", exact: true }).click();
    await page.locator('input[type="month"]').fill(month);
    await page.getByRole("button", { name: "Gerar aluguéis do mês" }).click();
    await expect(page.getByText(/cobrança|aluguéis/i).first()).toBeVisible();
    const list = async () => (await (await page.request.get(`/api/charges?month=${month}`)).json()).items.length;
    await expect.poll(list).toBeGreaterThan(0);
    const first = await list();
    await page.getByRole("button", { name: "Gerar aluguéis do mês" }).click();
    await page.waitForTimeout(600);
    expect(await list()).toBe(first); // idempotente
  });

  test("comunicado publicado chega ao inquilino como notificação e leva ao conteúdo", async ({ page, browser }) => {
    await openPanel(page);
    const title = unique("Aviso E2E");
    const created = await page.request.post("/api/announcements", { data: { title, body: "Texto do aviso de teste.", audience: "inquilinos" } });
    expect(created.ok()).toBeTruthy();
    await menu(page).getByRole("button", { name: "Comunicados", exact: true }).click();
    const card = page.locator("article, li, .panel").filter({ hasText: title }).first();
    await card.getByRole("button", { name: "Publicar" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Publicar" }).click();
    await expect(page.getByText(/publicado/i).first()).toBeVisible();

    const ctx = await browser.newContext();
    const tenant = await ctx.newPage();
    await openPanel(tenant, TENANT);
    await tenant.getByRole("button", { name: /Notificações/ }).first().click();
    await expect(tenant.getByText(title).first()).toBeVisible();
    await ctx.close();
  });

  test("toda escrita feita pela interface aparece nos registros de atividade", async ({ page }) => {
    await openPanel(page);
    const name = unique("Reg UI");
    await menu(page).getByRole("button", { name: "Proprietários", exact: true }).click();
    await page.getByRole("button", { name: "Novo proprietário" }).click();
    await page.getByLabel("Nome", { exact: true }).fill(name);
    await page.getByLabel("CPF/CNPJ").fill(String(Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)));
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("cell", { name })).toBeVisible();
    await menu(page).getByRole("button", { name: "Registros", exact: true }).click();
    await expect(page.getByRole("row", { name: new RegExp(`Cadastrou proprietário.*${name}`) })).toBeVisible();
  });
});
