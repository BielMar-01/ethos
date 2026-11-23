import { test, expect, type Page } from "@playwright/test";
import { fakeDoc, openPanel, unique } from "./helpers";

const PDF = { name: "contrato.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%fake") };

async function openIntake(page: Page, enabled: boolean) {
  await page.route("**/api/extract/status", (route) => route.fulfill({ json: { enabled, max_bytes: 4194304 } }));
  await openPanel(page);
  await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: "Ler documentos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cadastro por documento" })).toBeVisible();
}

const extraction = (over: Record<string, unknown> = {}) => ({
  kind: "contrato_locacao",
  people: [
    { role: "proprietario", name: "Maria Leitura", document: "529.982.247-25", document_valid: true, email: "maria@leitura.com", phone: "(11) 99999-0001" },
    { role: "inquilino", name: "Carlos Leitura", document: "111.111.111-11", document_valid: false, email: "", phone: "" },
  ],
  property: { name: "", type: "apartamento", zip: "", street: "Rua da Leitura", number: "42", complement: "", neighborhood: "Centro", city: "Curitiba", state: "PR" },
  unit: { identifier: "Apto 7", area_m2: 55, bedrooms: 2 },
  lease: { start_date: "2026-03-01", end_date: "2029-02-28", rent_cents: 190000, due_day: 10, guarantee: "Caução de 2 aluguéis" },
  notes: "",
  ...over,
});

test.describe("cadastro por documento (leitura automática)", () => {
  test("desligado: explica o que falta e oferece alternativas, sem permitir envio", async ({ page }) => {
    await openIntake(page, false);
    await expect(page.getByRole("alert")).toContainText("ainda não está ativada");
    await expect(page.locator(".dropzone")).toHaveAttribute("aria-disabled", "true");
  });

  test("exige o consentimento antes de aceitar arquivos", async ({ page }) => {
    await openIntake(page, true);
    await expect(page.getByText("Marque a confirmação acima para enviar")).toBeVisible();
    await page.getByLabel(/Entendo que cada arquivo é enviado/).check();
    await expect(page.getByText("Arraste os arquivos aqui ou clique para escolher")).toBeVisible();
  });

  test("lê o documento, mostra para conferir (com alerta de CPF) e cadastra tudo, inclusive o contrato em rascunho", async ({ page }) => {
    const owner = unique("Maria Leitura");
    const tenant = unique("Carlos Leitura");
    const street = unique("Rua da Leitura");
    const ownerDoc = fakeDoc();
    const tenantDoc = fakeDoc();
    let sent = 0;
    await page.route("**/api/extract", (route) => {
      sent++;
      return route.fulfill({
        json: extraction({
          people: [
            { role: "proprietario", name: owner, document: ownerDoc, document_valid: true, email: "", phone: "" },
            { role: "inquilino", name: tenant, document: tenantDoc, document_valid: false, email: "", phone: "" },
          ],
          property: { name: "", type: "apartamento", zip: "", street, number: "42", complement: "", neighborhood: "Centro", city: "Curitiba", state: "PR" },
        }),
      });
    });
    await openIntake(page, true);
    await page.getByLabel(/Entendo que cada arquivo é enviado/).check();
    await page.locator('input[type="file"]').setInputFiles(PDF);
    await expect(page.locator(".file-list")).toContainText("Contrato de locação");
    expect(sent).toBe(1);

    // Tudo pré-preenchido e editável.
    await expect(page.getByLabel("Nome", { exact: true }).first()).toHaveValue(owner);
    await expect(page.getByText("Dígitos verificadores não conferem")).toBeVisible();
    await expect(page.getByLabel("Rua")).toHaveValue(street);
    await expect(page.getByLabel("Identificação")).toHaveValue("Apto 7");
    await expect(page.getByLabel(/^Aluguel/)).toHaveValue("1.900,00");
    await expect(page.getByLabel("Dia do vencimento")).toHaveValue("10");
    await page.getByLabel("Quartos").fill("3"); // o usuário corrige antes de salvar

    await page.getByRole("button", { name: "3. Confirmar e cadastrar" }).click();
    await expect(page.getByRole("heading", { name: "Pronto" })).toBeVisible();
    await expect(page.getByText(/Contrato criado como RASCUNHO/)).toBeVisible();

    // Conferência no servidor: proprietário, inquilino, imóvel ligado ao dono, unidade corrigida e contrato em rascunho.
    const get = async (path: string) => (await (await page.request.get(path)).json()).items;
    expect((await get("/api/owners")).some((o: { name: string }) => o.name === owner)).toBe(true);
    const props = await get("/api/properties");
    const prop = props.find((p: { street: string }) => p.street === street);
    expect(prop).toBeTruthy();
    expect(prop.name).toBe(`${street}, 42`);
    expect(await get(`/api/properties/${prop.id}/owners`)).toHaveLength(1);
    const unit = (await get("/api/units")).find((u: { property_id: number }) => u.property_id === prop.id);
    expect(unit.bedrooms).toBe(3);
    expect(unit.rent_reference_cents).toBe(190000);
    const leases = await get("/api/leases");
    const lease = leases.find((l: { unit_id: number }) => l.unit_id === unit.id);
    expect(lease.status).toBe("rascunho");
    expect(lease.rent_cents).toBe(190000);
    expect(lease.tenant_names).toContain(tenant);
  });

  test("faltando dados do contrato, só cadastra e explica o que faltou", async ({ page }) => {
    const owner = unique("Só Cadastro");
    await page.route("**/api/extract", (route) =>
      route.fulfill({
        json: extraction({
          kind: "identidade",
          people: [{ role: "proprietario", name: owner, document: fakeDoc(), document_valid: null, email: "", phone: "" }],
          property: { name: "", type: "", zip: "", street: "", number: "", complement: "", neighborhood: "", city: "", state: "" },
          unit: { identifier: "", area_m2: null, bedrooms: null },
          lease: { start_date: "2026-03-01", end_date: "", rent_cents: null, due_day: null, guarantee: "" },
        }),
      }),
    );
    await openIntake(page, true);
    await page.getByLabel(/Entendo que cada arquivo é enviado/).check();
    await page.locator('input[type="file"]').setInputFiles({ name: "rg.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
    await expect(page.getByLabel("Nome", { exact: true }).first()).toHaveValue(owner);
    await page.getByRole("button", { name: "3. Confirmar e cadastrar" }).click();
    await expect(page.getByText(/Contrato NÃO criado: faltam/)).toBeVisible();
    expect((await (await page.request.get("/api/owners")).json()).items.some((o: { name: string }) => o.name === owner)).toBe(true);
  });

  test("vários documentos se juntam sem duplicar a mesma pessoa", async ({ page }) => {
    const doc = fakeDoc();
    const name = unique("Pessoa Dupla");
    let n = 0;
    await page.route("**/api/extract", (route) => {
      n++;
      return route.fulfill({
        json: extraction({
          people: [{ role: "proprietario", name, document: doc, document_valid: null, email: n === 2 ? "segunda@leitura.com" : "", phone: "" }],
          property: { name: "", type: "", zip: "", street: "", number: "", complement: "", neighborhood: "", city: "", state: "" },
          unit: { identifier: "", area_m2: null, bedrooms: null },
          lease: { start_date: "", end_date: "", rent_cents: null, due_day: null, guarantee: "" },
        }),
      });
    });
    await openIntake(page, true);
    await page.getByLabel(/Entendo que cada arquivo é enviado/).check();
    await page.locator('input[type="file"]').setInputFiles([
      { name: "rg-frente.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]) },
      { name: "rg-verso.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]) },
    ]);
    await expect(page.locator(".file-list li")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "3. Confirmar e cadastrar" })).toBeEnabled();
    await expect(page.locator(".person-row")).toHaveCount(1); // uma pessoa só
    await expect(page.getByLabel("E-mail").first()).toHaveValue("segunda@leitura.com"); // dados complementados
  });

  test("falha na leitura mostra a mensagem do servidor e permite tentar de novo", async ({ page }) => {
    await page.route("**/api/extract", (route) => route.fulfill({ status: 422, json: { error: "O serviço de leitura recusou este documento. Preencha manualmente." } }));
    await openIntake(page, true);
    await page.getByLabel(/Entendo que cada arquivo é enviado/).check();
    await page.locator('input[type="file"]').setInputFiles(PDF);
    await expect(page.locator(".file-list")).toContainText("recusou este documento");
    await expect(page.getByRole("heading", { name: "2. Confira e corrija" })).toHaveCount(0);
  });

  test("o servidor recusa arquivo falso e chamadas sem login", async ({ page, request }) => {
    expect((await request.post("/api/extract", { headers: { "Content-Type": "application/pdf" }, data: Buffer.from("%PDF-1.4") })).status()).toBe(401);
    await openPanel(page);
    const res = await page.request.post("/api/extract", { headers: { "Content-Type": "application/pdf" }, data: Buffer.from("MZ não sou pdf") });
    expect([400, 503]).toContain(res.status()); // 503 = não configurado no demo; 400 = conteúdo inválido
  });
});
