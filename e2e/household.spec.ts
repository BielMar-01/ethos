import { test, expect, type Page } from "@playwright/test";
import { TENANT, openPanel, unique } from "./helpers";

const menu = (page: Page) => page.getByRole("complementary", { name: "Menu principal" });
const goTo = (page: Page, label: string) => menu(page).getByRole("button", { name: label, exact: true }).click();

test.describe("boleto manual (sem integração, de verdade no servidor)", () => {
  test("registra um boleto manual pela cobrança, vê na aba Boletos e marca como pago", async ({ page }) => {
    await openPanel(page);
    const month = "2027-03";
    await page.request.post("/api/charges/generate", { data: { month } });
    await goTo(page, "Financeiro");
    await page.locator('input[type="month"]').fill(month);
    const row = page.getByRole("row").filter({ hasText: /Aluguel 03\/2027/ }).first();
    await expect(row).toBeVisible();
    await row.click();
    await page.getByRole("dialog").getByRole("button", { name: "Emitir boleto", exact: true }).click();

    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Boleto manual" })).toBeVisible();
    await dlg.getByLabel(/^Linha digitável/).fill("23793.38128 60000.000003 00000.000400 1 00000000000000");
    await dlg.getByLabel(/^Nosso número/).fill("0001234");
    await dlg.getByRole("button", { name: "Registrar boleto" }).click();
    await expect(page.getByText("Boleto manual registrado.")).toBeVisible();

    await page.getByRole("tab", { name: "Boletos" }).click();
    const brow = page.getByRole("row").filter({ hasText: /Aluguel 03\/2027/ }).first();
    await expect(brow).toContainText("Manual");
    await brow.click();
    const detail = page.getByRole("dialog");
    await expect(detail).toContainText("23793.38128");
    await expect(detail).toContainText("0001234");
    await detail.getByRole("button", { name: "Marcar como pago" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: /Confirmar|Sim|OK|Marcar/ }).click();
    await expect(detail.getByText("Pago", { exact: true })).toBeVisible();
    await expect(detail).toContainText("Marcado como pago pela equipe");
  });

  test("lote manual cria uma guia por cobrança em aberto do mês", async ({ page }) => {
    await openPanel(page);
    const month = "2027-04";
    await page.request.post("/api/charges/generate", { data: { month } });
    await goTo(page, "Financeiro");
    await page.locator('input[type="month"]').fill(month);
    await page.getByRole("tab", { name: "Boletos" }).click();
    await page.getByRole("button", { name: "Emitir boletos do mês" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Gerar guias" }).click();
    await expect(dlg).toContainText("emitido(s) agora");
    const open = (await (await page.request.get(`/api/boletos?month=${month}`)).json()).items;
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((b: { provider: string }) => b.provider === "manual")).toBe(true);
  });
});

test.describe("meu perfil", () => {
  test("edita dados com máscara, troca a senha e o menu mostra o novo nome", async ({ page }) => {
    await openPanel(page);
    // O demo é compartilhado entre os testes: guarda o nome original e o devolve no fim.
    const original = (await (await page.request.get("/api/profile")).json()).user;
    await menu(page).getByRole("button", { name: /Meu perfil/ }).click();
    await expect(page.getByRole("heading", { name: "Meu perfil" })).toBeVisible();

    const name = unique("Admin Perfil");
    await page.getByLabel("Nome", { exact: true }).fill(name);
    const phone = page.getByLabel("Telefone");
    await phone.pressSequentially("11912345678");
    await expect(phone).toHaveValue("(11) 91234-5678");
    await page.getByRole("button", { name: "Salvar dados" }).click();
    await expect(page.getByText("Perfil atualizado.")).toBeVisible();
    await expect(menu(page).getByText(name)).toBeVisible();
    const me = await (await page.request.get("/api/profile")).json();
    expect(me.user.name).toBe(name);
    expect(me.user.phone).toBe("(11) 91234-5678");

    // Senha: confirmação diferente é barrada no navegador; senha atual errada vem do servidor.
    await page.getByLabel("Senha atual", { exact: true }).fill("errada-errada");
    await page.getByLabel("Nova senha", { exact: true }).fill("outra-senha-123");
    await page.getByLabel("Repita a nova senha").fill("diferente-123");
    await page.getByRole("button", { name: "Alterar senha" }).click();
    await expect(page.getByText("A confirmação não é igual")).toBeVisible();
    await page.getByLabel("Repita a nova senha").fill("outra-senha-123");
    await page.getByRole("button", { name: "Alterar senha" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Senha atual incorreta/ })).toBeVisible();
    await page.request.put("/api/profile", { data: { name: original.name, phone: original.phone ?? "" } });
  });

  test("inquilino também edita o próprio perfil", async ({ page }) => {
    await openPanel(page, TENANT);
    await page.getByRole("button", { name: /Meu perfil/ }).click();
    await expect(page.getByRole("heading", { name: "Meu perfil" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dados pessoais" })).toBeVisible();
    await page.getByLabel("Data de nascimento").fill("1990-05-17");
    await page.getByRole("button", { name: "Salvar dados" }).click();
    await expect(page.getByText("Perfil atualizado.")).toBeVisible();
  });
});

test.describe("moradores e portaria", () => {
  test("inquilino cadastra morador e autoriza visitante; a portaria registra entrada e saída", async ({ page, browser }) => {
    const tctx = await browser.newContext();
    const tenant = await tctx.newPage();
    await openPanel(tenant, TENANT);

    // Moradores
    await tenant.getByRole("tab", { name: "Moradores" }).click();
    await tenant.getByRole("button", { name: "Cadastrar morador" }).click();
    const kid = unique("Filho Teste");
    let dlg = tenant.getByRole("dialog");
    await dlg.getByLabel("Nome completo").fill(kid);
    await dlg.getByLabel("Relação com o locatário").selectOption("filho");
    await dlg.getByLabel("Telefone").pressSequentially("11987654321");
    await expect(dlg.getByLabel("Telefone")).toHaveValue("(11) 98765-4321");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(tenant.getByText("Morador cadastrado.")).toBeVisible();
    await expect(tenant.getByRole("row").filter({ hasText: kid })).toContainText("Filho(a)");

    // Visitantes
    await tenant.getByRole("tab", { name: "Visitantes" }).click();
    await tenant.getByRole("button", { name: "Autorizar visitante" }).click();
    const visitor = unique("Visita Teste");
    dlg = tenant.getByRole("dialog");
    await dlg.getByLabel("Nome do visitante").fill(visitor);
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(tenant.getByText("Visitante autorizado.")).toBeVisible();
    const code = (await tenant.getByRole("dialog").locator(".access-code").textContent())!.trim();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    await tenant.getByRole("dialog").getByRole("button", { name: "Fechar", exact: true }).click();

    // Portaria (equipe): localiza pelo código e registra a entrada e a saída.
    await openPanel(page);
    await goTo(page, "Moradores e acessos");
    await page.getByLabel("Localizar visitante").fill(code);
    const item = page.locator(".visit-list li").filter({ hasText: visitor });
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: /Registrar entrada/ }).click();
    await expect(page.getByText(`Entrada de ${visitor} registrada.`)).toBeVisible();
    const inside = page.locator(".panel").filter({ hasText: "Dentro agora" }).locator(".visit-list li").filter({ hasText: visitor });
    await expect(inside).toBeVisible();

    // O inquilino foi avisado da chegada.
    await tenant.getByRole("button", { name: /Notificações/ }).first().click();
    await expect(tenant.getByText(`${visitor} chegou`).first()).toBeVisible();

    await inside.getByRole("button", { name: /Registrar saída/ }).click();
    await expect(page.getByText(`Saída de ${visitor} registrada.`)).toBeVisible();
    await expect(page.locator(".panel").filter({ hasText: "Movimento de hoje" })).toContainText(visitor);
    await tctx.close();
  });

  test("equipe vê o cadastro de moradores, com o titular do contrato", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Moradores e acessos");
    await page.getByRole("tab", { name: "Moradores" }).click();
    await expect(page.getByText("Locatário (titular)").first()).toBeVisible();
  });
});
