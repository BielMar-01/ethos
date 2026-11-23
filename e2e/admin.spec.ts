import { test, expect } from "@playwright/test";
import { DEMO_PASSWORD, TENANT, createColaborador, fakeDoc, loginApi, openPanel, unique } from "./helpers";

const menu = (page: import("@playwright/test").Page) => page.getByRole("complementary", { name: "Menu principal" });

test.describe("equipe: redefinir senha pela tela", () => {
  test("admin define uma senha nova: a antiga para de valer e a nova entra", async ({ page, request, browser }) => {
    await openPanel(page);
    const email = await createColaborador(request, page);
    await menu(page).getByRole("button", { name: "Equipe", exact: true }).click();
    const row = page.getByRole("row", { name: new RegExp(email) });
    await row.getByRole("button", { name: "Redefinir senha" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Redefinir senha de");
    await dialog.getByPlaceholder(/Nova senha/).fill("curta");
    await dialog.getByRole("button", { name: "Definir esta senha" }).click();
    await expect(dialog.getByRole("alert")).toContainText("pelo menos 8");
    await dialog.getByPlaceholder(/Nova senha/).fill("Nova-senha-E2E-1");
    await dialog.getByRole("button", { name: "Definir esta senha" }).click();
    await expect(page.getByText(/Senha de .* alterada/)).toBeVisible();

    const ctx = await browser.newContext();
    const old = await ctx.request.post("/api/auth/login", { data: { email, password: DEMO_PASSWORD } });
    expect(old.status()).toBe(401);
    const fresh = await ctx.request.post("/api/auth/login", { data: { email, password: "Nova-senha-E2E-1" } });
    expect(fresh.ok()).toBeTruthy();
    await ctx.close();
  });

  test("sem digitar nada gera senha temporária, mostrada uma única vez, com botão de copiar", async ({ page, request, browser }) => {
    await openPanel(page);
    const email = await createColaborador(request, page);
    await menu(page).getByRole("button", { name: "Equipe", exact: true }).click();
    await page.getByRole("row", { name: new RegExp(email) }).getByRole("button", { name: "Redefinir senha" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Gerar senha temporária" }).click();
    const code = dialog.locator("code");
    await expect(code).toHaveText(/^[A-Za-z0-9]{14}$/);
    await expect(dialog).toContainText("só aparece agora");
    const temp = (await code.textContent())!;
    await dialog.getByRole("button", { name: "Concluir" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const ctx = await browser.newContext();
    expect((await ctx.request.post("/api/auth/login", { data: { email, password: temp } })).ok()).toBeTruthy();
    await ctx.close();
  });

  test("Esc fecha a janela sem alterar nada", async ({ page, request }) => {
    await openPanel(page);
    const email = await createColaborador(request, page);
    await menu(page).getByRole("button", { name: "Equipe", exact: true }).click();
    await page.getByRole("row", { name: new RegExp(email) }).getByRole("button", { name: "Redefinir senha" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const ok = await request.post("/api/auth/login", { data: { email, password: DEMO_PASSWORD } });
    expect(ok.ok()).toBeTruthy();
  });

  test("convite: gera o link e o convidado entra com o papel certo", async ({ page, browser }) => {
    await openPanel(page);
    await menu(page).getByRole("button", { name: "Equipe", exact: true }).click();
    const email = `conv-${Date.now().toString(36)}@e2e.test`;
    await page.getByRole("button", { name: "Convidar pessoa" }).click();
    await page.getByRole("dialog").getByLabel("E-mail").fill(email);
    await page.getByRole("dialog").getByRole("button", { name: "Gerar convite" }).click();
    const link = await page.locator("input[readonly], .link-box code, .link-box input").first().inputValue().catch(async () => (await page.locator(".link-box").innerText()));
    expect(link).toContain("invite=");
    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    await guest.goto(link.match(/https?:\/\/\S+invite=\S+/)![0]);
    await guest.getByLabel("Seu nome").fill("Convidado E2E");
    await guest.locator('input[autocomplete$="-password"]').fill("senha-convidado-1");
    await guest.getByRole("button", { name: /Criar conta|Entrar|Aceitar/ }).click();
    await expect(guest.locator(".topbar")).toBeVisible();
    await ctx.close();
  });
});

test.describe("registros de atividade (somente admin)", () => {
  test("mostra o que foi feito, com autor, filtros e detalhes", async ({ page }) => {
    await openPanel(page);
    const name = unique("Dono Auditado");
    const created = await page.request.post("/api/owners", { data: { name, document: fakeDoc() } });
    expect(created.ok()).toBeTruthy();
    await menu(page).getByRole("button", { name: "Registros", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Registros de atividade" })).toBeVisible();
    const row = page.getByRole("row", { name: new RegExp(`Cadastrou proprietário.*${name}`) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Ana Administradora");

    // Filtro por texto e por tipo.
    await page.getByPlaceholder("Ação, pessoa, e-mail ou IP").fill(name);
    await expect(page.getByRole("row")).toHaveCount(2);
    await page.getByLabel("Tipo").selectOption("delete");
    await expect(page.getByText("Nenhum registro com esses filtros")).toBeVisible();
    await page.getByRole("button", { name: "Limpar filtros" }).click();

    // Detalhes ao clicar na linha.
    await page.getByPlaceholder("Ação, pessoa, e-mail ou IP").fill(name);
    await page.getByRole("row", { name: new RegExp(name) }).click();
    await expect(page.locator(".audit-detail")).toContainText("admin@demo.test");
    await expect(page.locator(".audit-detail")).toContainText("Proprietários #");
  });

  test("exportação em CSV baixa o arquivo", async ({ page }) => {
    await openPanel(page);
    await menu(page).getByRole("button", { name: "Registros", exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar CSV" }).click()]);
    expect(download.suggestedFilename()).toBe("auditoria-ethos.csv");
  });

  test("tentativa negada de um colaborador aparece para o admin; colaborador não acessa", async ({ page, request, browser }) => {
    await openPanel(page);
    const email = await createColaborador(request, page);
    const ctx = await browser.newContext();
    await loginApi(await ctx.newPage(), email);
    const colab = ctx.request;
    await colab.post("/api/auth/login", { data: { email, password: DEMO_PASSWORD } });
    expect((await colab.get("/api/audit")).status()).toBe(403);
    expect((await colab.post("/api/reminders/run")).status()).toBe(403);
    await ctx.close();
    await menu(page).getByRole("button", { name: "Registros", exact: true }).click();
    await page.getByLabel("Tipo").selectOption("denied");
    await expect(page.getByRole("row", { name: new RegExp(`Acesso negado.*lembretes`, "i") }).first()).toBeVisible();
  });

  test("a API não oferece como apagar ou editar registros", async ({ page }) => {
    await openPanel(page);
    for (const method of ["delete", "patch", "put"] as const) {
      const res = await page.request.fetch("/api/audit/1", { method });
      expect([404, 405]).toContain(res.status());
    }
  });
});

test.describe("área do cliente", () => {
  test("inquilino vê só o que é dele e não consegue abrir dados da equipe", async ({ page }) => {
    await openPanel(page, TENANT);
    await expect(page.getByRole("heading", { name: /Minha área|Olá|Carlos/ }).first()).toBeVisible();
    const charges = await page.request.get("/api/portal/tenant/charges");
    expect(charges.ok()).toBeTruthy();
    expect((await charges.json()).items.length).toBeGreaterThan(0);
    expect((await page.request.get("/api/portal/owner/properties")).status()).toBeGreaterThanOrEqual(400);
    expect((await page.request.get("/api/charges")).status()).toBe(403);
  });
});
