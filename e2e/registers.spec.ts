import { test, expect, type Page } from "@playwright/test";
import { fakeDoc, openPanel, unique } from "./helpers";

async function goTo(page: Page, label: string) {
  await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: label, exact: true }).click();
}

test.describe("cadastros", () => {
  test("proprietário: criar, buscar, editar e excluir (com confirmação)", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Proprietários");
    const name = unique("Proprietário E2E");
    await page.getByRole("button", { name: "Novo proprietário" }).click();
    await page.getByLabel("Nome", { exact: true }).fill(name);
    await page.getByLabel("CPF/CNPJ").fill(fakeDoc());
    await page.getByLabel("E-mail").fill("e2e@exemplo.com");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Proprietário salvo com sucesso.")).toBeVisible(); // aviso (toast)
    await expect(page.getByRole("cell", { name })).toBeVisible();

    // Busca filtra a lista.
    await page.getByPlaceholder("Buscar…").fill(name);
    await expect(page.getByRole("row")).toHaveCount(2); // cabeçalho + 1
    await page.getByPlaceholder("Buscar…").fill("zzzz-nao-existe");
    await expect(page.getByText("Nada encontrado para a busca.")).toBeVisible();
    await page.getByPlaceholder("Buscar…").fill(name);

    // Editar.
    await page.getByRole("row", { name }).getByRole("button", { name: "Editar" }).click();
    await page.getByLabel("Telefone").fill("(11) 98888-7777");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("cell", { name: "(11) 98888-7777" })).toBeVisible();

    // Excluir: o diálogo pergunta antes; "Voltar" não apaga.
    await page.getByRole("row", { name }).getByRole("button", { name: "Excluir" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("não pode ser desfeita");
    await dialog.getByRole("button", { name: "Voltar" }).click();
    await expect(page.getByRole("cell", { name })).toBeVisible();
    await page.getByRole("row", { name }).getByRole("button", { name: "Excluir" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Excluir" }).click();
    await expect(page.getByRole("cell", { name })).toHaveCount(0);
  });

  test("documento duplicado mostra erro claro", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Inquilinos");
    const doc = fakeDoc();
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "Novo inquilino" }).click();
      await page.getByLabel("Nome", { exact: true }).fill(unique("Inquilino E2E"));
      await page.getByLabel("CPF/CNPJ").fill(doc);
      await page.getByRole("button", { name: "Salvar" }).click();
      if (i === 0) await expect(page.getByText(/salvo com sucesso/)).toBeVisible();
    }
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("CEP: ao completar 8 números preenche rua, bairro, cidade e UF e leva ao número", async ({ page }) => {
    await page.route("**/api/cep/**", (route) =>
      route.fulfill({ json: { zip: "01001-000", street: "Praça da Sé", neighborhood: "Sé", city: "São Paulo", state: "SP", complement: "lado ímpar" } }),
    );
    await openPanel(page);
    await goTo(page, "Imóveis");
    await page.getByRole("button", { name: "Novo imóvel" }).click();
    await page.getByLabel("CEP").fill("01001000");
    await expect(page.getByLabel("CEP")).toHaveValue("01001-000"); // máscara
    await expect(page.getByLabel("Rua")).toHaveValue("Praça da Sé");
    await expect(page.getByLabel("Bairro")).toHaveValue("Sé");
    await expect(page.getByLabel("Cidade")).toHaveValue("São Paulo");
    await expect(page.getByLabel("UF")).toHaveValue("SP");
    await expect(page.getByLabel("Complemento")).toHaveValue("lado ímpar");
    await expect(page.locator('input[name="number"]')).toBeFocused();
    await expect(page.getByText("Endereço preenchido")).toBeVisible();

    // Salva o imóvel com o endereço vindo do CEP.
    const name = unique("Imóvel CEP");
    await page.getByLabel("Nome", { exact: true }).fill(name);
    await page.getByLabel("Tipo").selectOption("casa");
    await page.locator('input[name="number"]').fill("10");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("cell", { name })).toBeVisible();
    await expect(page.getByRole("row", { name }).getByText("São Paulo")).toBeVisible();
  });

  test("CEP inexistente avisa sem travar o formulário", async ({ page }) => {
    await page.route("**/api/cep/**", (route) => route.fulfill({ status: 404, json: { error: "CEP não encontrado. Confira os números ou preencha o endereço manualmente." } }));
    await openPanel(page);
    await goTo(page, "Imóveis");
    await page.getByRole("button", { name: "Novo imóvel" }).click();
    await page.getByLabel("CEP").fill("99999999");
    await expect(page.getByRole("alert").filter({ hasText: "CEP não encontrado" })).toBeVisible();
    await page.getByLabel("Rua").fill("Rua Manual");
    await expect(page.getByLabel("Rua")).toHaveValue("Rua Manual");
  });

  test("o servidor valida o CEP (8 números) e exige login", async ({ page, request }) => {
    expect((await request.get("/api/cep/01001000")).status()).toBe(401);
    await openPanel(page);
    expect((await page.request.get("/api/cep/123")).status()).toBe(400);
  });
});
