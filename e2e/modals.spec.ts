import { test, expect, type Page } from "@playwright/test";
import { fakeDoc, openPanel, unique } from "./helpers";

const menu = (page: Page) => page.getByRole("complementary", { name: "Menu principal" });
const goTo = (page: Page, label: string) => menu(page).getByRole("button", { name: label, exact: true }).click();

async function createOwner(page: Page, name: string) {
  const r = await page.request.post("/api/owners", { data: { name, document: fakeDoc(), email: "modal@exemplo.com" } });
  expect(r.ok()).toBeTruthy();
}

test.describe("tudo abre em modal (computador)", () => {
  test("cadastros: Novo, Ver, Editar e Excluir são janelas; a lista fica por trás", async ({ page }) => {
    await openPanel(page);
    const name = unique("Dono Modal");
    await createOwner(page, name);
    await goTo(page, "Proprietários");

    // Novo → modal com título; não existe mais formulário inline na página.
    await page.getByRole("button", { name: "Novo proprietário" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole("heading", { name: "Novo proprietário" })).toBeVisible();
    await expect(page.locator("main form")).toHaveCount(0);
    await dlg.getByRole("button", { name: "Cancelar" }).click();
    await expect(dlg).toHaveCount(0);

    // Linha clicável → Ver (somente leitura) com ações.
    await page.getByRole("row", { name }).click();
    await expect(dlg.getByRole("heading", { name })).toBeVisible();
    await expect(dlg.getByText("modal@exemplo.com")).toBeVisible();
    await expect(dlg.locator("input")).toHaveCount(0); // visualização não tem campos
    await dlg.getByRole("button", { name: "Editar" }).click();
    await expect(dlg.getByRole("heading", { name: "Editar proprietário" })).toBeVisible();
    await dlg.getByLabel("Telefone").fill("(11) 97777-6666");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "(11) 97777-6666" })).toBeVisible();

    // Excluir pelo modal de visualização: pede confirmação por cima.
    await page.getByRole("row", { name }).getByRole("button", { name: "Ver" }).click();
    await dlg.getByRole("button", { name: "Excluir" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Excluir" }).click();
    await expect(page.getByRole("cell", { name })).toHaveCount(0);
  });

  test("Esc, clique no fundo e o × fecham; a rolagem do fundo trava; o foco fica preso e volta", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Proprietários");
    const novo = page.getByRole("button", { name: "Novo proprietário" });
    await novo.click();
    const dlg = page.getByRole("dialog");
    await expect(page.locator("body")).toHaveClass(/has-modal/);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
    // O foco começa no primeiro campo e o Tab não escapa da janela.
    await expect(dlg.getByLabel("Nome", { exact: true })).toBeFocused();
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".modal"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/has-modal/);
    await expect(novo).toBeFocused(); // foco volta ao botão de origem

    await novo.click();
    await page.mouse.click(5, 5); // fundo escuro
    await expect(dlg).toHaveCount(0);
    await novo.click();
    await dlg.getByRole("button", { name: "Fechar janela" }).click();
    await expect(dlg).toHaveCount(0);
  });

  test("selecionar texto dentro e soltar fora NÃO fecha (não perde o formulário)", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Proprietários");
    await page.getByRole("button", { name: "Novo proprietário" }).click();
    const nome = page.getByRole("dialog").getByLabel("Nome", { exact: true });
    await nome.fill("Texto importante");
    const box = (await nome.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(2, 2); // solta no fundo
    await page.mouse.up();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(nome).toHaveValue("Texto importante");
  });

  test("contratos, manutenção e vistorias abrem o detalhe em modal grande", async ({ page }) => {
    await openPanel(page);
    for (const area of ["Contratos", "Manutenção", "Vistorias"]) {
      await goTo(page, area);
      await expect(page.getByRole("heading", { name: area, exact: true })).toBeVisible();
      await page.locator("tbody tr.clickable").first().click();
      const dlg = page.getByRole("dialog");
      await expect(dlg).toBeVisible();
      await expect(dlg.locator(".page-head h2").first()).toBeVisible();
      await expect(dlg.locator(".back-btn")).toBeHidden(); // o "voltar" some: quem fecha é o modal
      await page.keyboard.press("Escape");
      await expect(dlg).toHaveCount(0);
    }
  });

  test("novo contrato, novo chamado e nova vistoria também são modais", async ({ page }) => {
    await openPanel(page);
    for (const [area, button] of [["Contratos", "Novo contrato"], ["Manutenção", "Nova solicitação"], ["Vistorias", "Nova vistoria"]] as const) {
      await goTo(page, area);
      await page.getByRole("button", { name: button }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });

  test("financeiro: cobrança abre em modal (Ver), receber e nova cobrança avulsa também", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Financeiro");
    await page.locator("tbody tr.clickable").first().click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByText("Locatário")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Nova cobrança avulsa" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Nova cobrança avulsa" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Receber" }).first().click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Receber pagamento" })).toBeVisible();
  });

  test("modelos, comunicados e equipe: ver/editar/criar em modal", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Modelos");
    await page.getByRole("button", { name: "Novo modelo" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await goTo(page, "Comunicados");
    await page.getByRole("button", { name: "Ver", exact: true }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await goTo(page, "Equipe");
    await page.getByRole("button", { name: "Ver", exact: true }).first().click();
    await expect(page.getByRole("dialog")).toContainText("E-mail");
    await page.screenshot({ path: "test-results/_modal-desktop.png" });
  });

  test("imprimir: o recibo em modal vira a página e esconde o resto no @media print", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Financeiro");
    await page.getByRole("tab", { name: "Pagamentos" }).click();
    await page.getByRole("button", { name: /Recibo/ }).first().click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.locator(".paper")).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".shell")).toBeHidden();
    await expect(dlg.locator(".paper")).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Fechar janela" })).toBeHidden(); // botões não saem no papel
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".modal-scrim")!).position)).toBe("static");
  });
});
