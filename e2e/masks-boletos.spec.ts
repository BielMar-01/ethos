import { test, expect, type Page } from "@playwright/test";
import writeExcelFile from "write-excel-file/node";
import { fakeDoc, openPanel, unique } from "./helpers";

const menu = (page: Page) => page.getByRole("complementary", { name: "Menu principal" });
async function goTo(page: Page, label: string) {
  await menu(page).getByRole("button", { name: label, exact: true }).click();
}

test.describe("máscaras de digitação", () => {
  test("telefone, CPF/CNPJ e moeda se formatam enquanto digita e salvam certo", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Proprietários");
    await page.getByRole("button", { name: "Novo proprietário" }).click();
    const name = unique("Máscara E2E");
    await page.getByLabel("Nome", { exact: true }).fill(name);

    const doc = page.getByLabel("CPF/CNPJ");
    await doc.pressSequentially("12345678900");
    await expect(doc).toHaveValue("123.456.789-00");
    await expect(page.getByText("CPF/CNPJ parece inválido")).toBeVisible();
    await doc.fill("");
    await doc.pressSequentially("12345678909");
    await expect(doc).toHaveValue("123.456.789-09");
    await expect(page.getByText("CPF/CNPJ parece inválido")).toHaveCount(0);
    await doc.fill("");
    await doc.pressSequentially("12345678000195");
    await expect(doc).toHaveValue("12.345.678/0001-95"); // vira CNPJ sozinho

    const phone = page.getByLabel("Telefone");
    await phone.pressSequentially("11912345678");
    await expect(phone).toHaveValue("(11) 91234-5678");
    await phone.fill("");
    await phone.pressSequentially("1132345678");
    await expect(phone).toHaveValue("(11) 3234-5678");
    await phone.fill("");
    await phone.pressSequentially("1191");
    await expect(page.getByText("Telefone incompleto")).toBeVisible();
    await phone.fill("");
    await phone.pressSequentially("11912345678");

    await doc.fill("");
    await doc.pressSequentially(fakeDoc());
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("cell", { name })).toBeVisible();
    const saved = (await (await page.request.get("/api/owners")).json()).items.find((o: { name: string }) => o.name === name);
    expect(saved.phone).toBe("(11) 91234-5678");
  });

  test("valor em reais: digita só números, mostra R$ e guarda em centavos", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Unidades");
    await page.getByRole("button", { name: "Nova unidade" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Imóvel").selectOption({ index: 1 });
    const ident = unique("Apto");
    await dlg.getByLabel("Identificação").fill(ident);
    const rent = dlg.getByLabel("Aluguel de referência");
    await rent.pressSequentially("250000");
    await expect(rent).toHaveValue("2.500,00");
    await rent.fill("");
    await rent.pressSequentially("5");
    await expect(rent).toHaveValue("0,05");
    await rent.fill("");
    await rent.pressSequentially("185050");
    await expect(rent).toHaveValue("1.850,50");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("row", { name: new RegExp(ident) })).toBeVisible();
    const unit = (await (await page.request.get("/api/units")).json()).items.find((u: { identifier: string }) => u.identifier === ident);
    expect(unit.rent_reference_cents).toBe(185050);

    // Ao editar, o valor volta formatado.
    await page.getByRole("row", { name: new RegExp(ident) }).getByRole("button", { name: "Editar" }).click();
    await expect(page.getByRole("dialog").getByLabel("Aluguel de referência")).toHaveValue("1.850,50");
  });
});

test.describe("importação: colar da planilha, Excel e novos tipos", () => {
  async function openImport(page: Page) {
    await openPanel(page);
    await goTo(page, "Importar dados");
    await expect(page.getByRole("heading", { name: "Importar dados" })).toBeVisible();
  }
  async function paste(page: Page, kind: string, text: string) {
    await page.getByLabel("Tipo dos dados colados").selectOption({ label: kind });
    await page.getByLabel("Dados colados da planilha").fill(text);
    await page.getByRole("button", { name: "Adicionar à lista" }).click();
  }

  test("cola contratos, cobranças e vistorias junto com os cadastros e importa tudo", async ({ page }) => {
    await openImport(page);
    const doc = fakeDoc();
    const docT = fakeDoc();
    const prop = unique("Res Cola");
    await paste(page, "Proprietários", `nome\tdocumento\ttelefone\nDono ${prop}\t${doc}\t11912345678`);
    await paste(page, "Inquilinos", `nome\tdocumento\nInq ${prop}\t${docT}`);
    await paste(page, "Imóveis", `nome\ttipo\tcep\tproprietarios\n${prop}\tapartamento\t01001000\t${doc}`);
    await paste(page, "Unidades", `imovel\tidentificador\n${prop}\tA1`);
    await paste(page, "Contratos", `imovel\tunidade\tlocatarios\tinicio\tfim\taluguel\tdia_vencimento\tsituacao\n${prop}\tA1\t${docT}\t01/01/2030\t31/12/2030\t2.500,00\t10\tvigente`);
    await paste(page, "Cobranças", `imovel\tunidade\tvencimento\tvalor\n${prop}\tA1\t10/06/2030\t2.500,00`);
    await paste(page, "Vistorias", `imovel\tunidade\ttipo\tdata\n${prop}\tA1\tentrada\t02/01/2030`);

    await page.getByRole("button", { name: /Conferir antes de importar/ }).click();
    await expect(page.getByText("Tudo certo — veja o que será feito")).toBeVisible();
    await page.getByRole("button", { name: /Importar 7 registro/ }).click();
    await expect(page.getByText("Importação concluída").first()).toBeVisible();
    await expect(page.getByText("Contratos: 1 criado(s)")).toBeVisible();
    await expect(page.getByText("Cobranças: 1 criado(s)")).toBeVisible();
    await expect(page.getByText("Vistorias: 1 criado(s)")).toBeVisible();

    const leases = (await (await page.request.get("/api/leases")).json()).items.filter((l: { property_name: string }) => l.property_name === prop);
    expect(leases).toHaveLength(1);
    expect(leases[0].status).toBe("vigente");
    expect(leases[0].rent_cents).toBe(250000);
    const charges = (await (await page.request.get("/api/charges?month=2030-06")).json()).items.filter((c: { property_name: string }) => c.property_name === prop);
    expect(charges).toHaveLength(1);
    const owner = (await (await page.request.get("/api/owners")).json()).items.find((o: { name: string }) => o.name === `Dono ${prop}`);
    expect(owner.phone).toBe("(11) 91234-5678");
  });

  test("colar sem cabeçalho/dados mostra instrução e erro por linha aponta a linha certa", async ({ page }) => {
    await openImport(page);
    await page.getByLabel("Dados colados da planilha").fill("só uma linha");
    await page.getByRole("button", { name: "Adicionar à lista" }).click();
    await expect(page.getByText("Cole as células com a primeira linha de cabeçalho")).toBeVisible();

    await paste(page, "Contratos", `imovel\tunidade\tlocatarios\tinicio\tfim\taluguel\nNão existe\tX\t\t31/02/2030\t31/12/2030\t100`);
    await page.getByRole("button", { name: /Conferir antes de importar/ }).click();
    await expect(page.getByText("Corrija os problemas abaixo")).toBeVisible();
    await expect(page.getByText(/Imóvel não encontrado/)).toBeVisible();
    await expect(page.getByText(/Colado \(Contratos\), linha 2/)).toBeVisible();
  });

  test("arquivo Excel (.xlsx): lê datas e recupera zeros à esquerda do CPF", async ({ page }) => {
    await openImport(page);
    const prop = unique("Res Xlsx");
    const header = ["nome", "documento", "email"].map((value) => ({ value, fontWeight: "bold" as const }));
    const buffer = await writeExcelFile([
      header,
      [{ value: `Dona ${prop}` }, { value: 1234567890, type: Number }, { value: "dona@x.com" }], // CPF 01234567890 sem o zero
    ]).toBuffer();
    const leaseBuf = await writeExcelFile([
      ["imovel", "unidade", "locatarios", "inicio", "fim", "aluguel"].map((value) => ({ value })),
      [{ value: prop }, { value: "U1" }, { value: "" }, { value: new Date(Date.UTC(2030, 0, 1)), type: Date, format: "dd/mm/yyyy" }, { value: new Date(Date.UTC(2030, 11, 31)), type: Date, format: "dd/mm/yyyy" }, { value: 1800.5, type: Number }],
    ]).toBuffer();
    await page.locator('input[type="file"]').setInputFiles([
      { name: "proprietarios.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer },
      { name: "contratos.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: leaseBuf },
    ]);
    await expect(page.getByLabel("Tipo de proprietarios.xlsx")).toHaveValue("owners");
    await expect(page.getByLabel("Tipo de contratos.xlsx")).toHaveValue("leases");
    // Só o proprietário (o contrato cita imóvel inexistente de propósito): conferência aponta o erro do contrato com data lida do Excel.
    await page.getByRole("button", { name: /Conferir antes de importar/ }).click();
    await expect(page.getByText(/Imóvel não encontrado/)).toBeVisible();
    await expect(page.getByText(/contratos\.xlsx, linha 2/)).toBeVisible();
    // Remove o contrato e importa só o proprietário: o CPF volta com 11 dígitos.
    await page.getByRole("button", { name: "Remover contratos.xlsx" }).click();
    await page.getByRole("button", { name: /Conferir antes de importar/ }).click();
    await page.getByRole("button", { name: /Importar 1 registro/ }).click();
    await expect(page.getByText("Importação concluída").first()).toBeVisible();
    const owner = (await (await page.request.get("/api/owners")).json()).items.find((o: { name: string }) => o.name === `Dona ${prop}`);
    expect(owner.document).toBe("012.345.678-90");
  });

  test("Excel antigo (.xls) recebe orientação clara", async ({ page }) => {
    await openImport(page);
    await page.locator('input[type="file"]').setInputFiles({ name: "velho.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("x") });
    await expect(page.getByText(/Excel antigo \(\.xls\)/)).toBeVisible();
  });
});

test.describe("boletos (Asaas simulado na tela)", () => {
  const charge = {
    id: 9001, lease_id: 1, kind: "aluguel", description: "Aluguel 12/2030", competence: "2030-12-01", due_date: "2030-12-10",
    amount_cents: 250000, paid_cents: 0, status: "aberta", cancelled_at: null,
    unit_identifier: "Apto 1", property_name: "Prédio Teste", tenant_names: "Fulano de Tal",
  };
  const boleto = {
    id: 5001, charge_id: 9001, status: "pendente", amount_cents: 250000, due_date: "2030-12-10",
    invoice_url: "https://sandbox.asaas.com/i/pay_1", bank_slip_url: null, identification_field: "23793.38128 60000.000003 00000.000400 1 00000000000000",
    paid_at: null, environment: "sandbox", description: "Aluguel 12/2030", unit_identifier: "Apto 1", property_name: "Prédio Teste", tenant_names: "Fulano de Tal",
  };

  async function openFinance(page: Page, opts: { connected: boolean; boletos?: unknown[] }) {
    await page.route("**/api/boletos/status", (r) => r.fulfill({ json: { connected: opts.connected, environment: opts.connected ? "sandbox" : null, fine_percent: 2, interest_percent: 1 } }));
    await page.route(/\/api\/boletos(\?.*)?$/, (r) => (r.request().method() === "GET" ? r.fulfill({ json: { items: opts.boletos ?? [] } }) : r.fallback()));
    await page.route(/\/api\/charges\?/, (r) => r.fulfill({ json: { items: [charge] } }));
    await openPanel(page);
    await goTo(page, "Financeiro");
    await page.locator('input[type="month"]').fill("2030-12");
  }

  test("sem Asaas conectado: não oferece emitir e a aba Boletos orienta a conectar", async ({ page }) => {
    await openFinance(page, { connected: false });
    await expect(page.getByRole("cell", { name: "Aluguel 12/2030" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Emitir boleto", exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Boletos" }).click();
    await expect(page.getByText("Asaas não conectado")).toBeVisible();
  });

  test("conectado: emite boleto individual pelo modal e mostra erro vindo do servidor", async ({ page }) => {
    let posted: Record<string, unknown> | null = null;
    await openFinance(page, { connected: true });
    await page.route("**/api/boletos", (r) => {
      if (r.request().method() !== "POST") return r.fallback();
      posted = r.request().postDataJSON();
      return r.fulfill({ status: 201, json: { item: boleto } });
    });
    await page.getByRole("button", { name: "Emitir boleto", exact: true }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("2.500,00");
    await dlg.getByLabel("Vencimento do boleto").fill("2030-12-12");
    await dlg.getByRole("button", { name: "Emitir boleto", exact: true }).click();
    await expect(page.getByText("Boleto emitido.")).toBeVisible();
    expect(posted).toEqual({ charge_id: 9001, due_date: "2030-12-12" });

    // Erro do servidor aparece dentro do modal, sem fechar.
    await page.unroute("**/api/boletos");
    await page.route("**/api/boletos", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 422, json: { error: "Fulano: o CPF/CNPJ cadastrado não é válido para emitir boleto." } }) : r.fallback()));
    await page.getByRole("button", { name: "Emitir boleto", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Emitir boleto", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("CPF/CNPJ");
  });

  test("com boleto em aberto: botão vira 'Boleto', detalhe mostra linha digitável, link e atualização", async ({ page }) => {
    await openFinance(page, { connected: true, boletos: [boleto] });
    await page.route("**/api/boletos/5001/sync", (r) => r.fulfill({ json: { item: { ...boleto, status: "paga", paid_at: "2030-12-09" } } }));
    await expect(page.getByRole("button", { name: "Emitir boleto", exact: true })).toHaveCount(0);
    await page.getByRole("row", { name: /Aluguel 12\/2030/ }).getByRole("button", { name: "Boleto" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("23793.38128");
    await expect(dlg.getByRole("link", { name: "Abrir boleto" })).toHaveAttribute("href", "https://sandbox.asaas.com/i/pay_1");
    await expect(dlg.getByRole("link", { name: "Abrir boleto" })).toHaveAttribute("rel", /noopener/);
    await dlg.getByRole("button", { name: "Atualizar situação" }).click();
    await expect(dlg.getByText("Pago", { exact: true })).toBeVisible();
    await expect(dlg).toContainText("registre o recebimento");
  });

  test("lote: confirma, mostra o resultado e as falhas por cobrança", async ({ page }) => {
    await openFinance(page, { connected: true });
    await page.route("**/api/boletos/bulk", (r) =>
      r.fulfill({ json: { eligible: 3, created: 2, failed: [{ charge_id: 3, label: "Aluguel 12/2030 · Apto 3", error: "Inq 3: o CPF/CNPJ cadastrado não é válido para emitir boleto." }], remaining: 0, stopped_by: null } }),
    );
    await page.getByRole("button", { name: "Emitir boletos do mês" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("12/2030");
    await dlg.getByRole("button", { name: "Emitir boletos" }).click();
    await expect(dlg).toContainText("2 boleto(s) emitido(s)");
    await expect(dlg).toContainText("1 não puderam ser emitidos");
    await expect(dlg).toContainText("Apto 3");
  });
});
