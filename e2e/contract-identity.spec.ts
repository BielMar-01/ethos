import { expect, test } from "@playwright/test";
import { fakeDoc, openPanel, unique } from "./helpers";

const qualify = { nationality: "brasileiro(a)", marital_status: "solteiro", profession: "analista", rg: "11.111.111-1 SSP/SP", address: "Rua das Partes, 10, Centro, São Paulo/SP" };

test.describe("contratos com identidade da Ethos", () => {
  test("modelo padrão pela tela, 2 locadores e 2 locatários: emite com número, marca d'água, assinaturas e imprime", async ({ page }, info) => {
    test.setTimeout(120_000);
    await openPanel(page);
    const post = async (url: string, data: unknown) => {
      const r = await page.request.post(url, { data: data as object });
      expect(r.ok(), `${url}: ${await r.text()}`).toBeTruthy();
      return r.json();
    };
    const person = async (kind: "owners" | "tenants", name: string) => (await post(`/api/${kind}`, { name, document: fakeDoc(), ...qualify })).item.id as number;
    const owners = [await person("owners", "Alice Locadora Teste"), await person("owners", "Bruno Locador Teste")];
    const tenants = [await person("tenants", "Carla Inquilina Teste"), await person("tenants", "Davi Inquilino Teste")];
    const propName = unique("Prédio Identidade");
    const prop = (await post("/api/properties", { name: propName, type: "apartamento", street: "Rua X", number: "1", city: "São Paulo", state: "SP" })).item.id;
    expect((await page.request.put(`/api/properties/${prop}/owners`, { data: { ownerIds: owners } })).ok()).toBeTruthy();
    const unit = (await post("/api/units", { property_id: prop, identifier: "Apto 7", energy_installation: "123456", water_supply: "654321" })).item.id;
    const lease = (await post("/api/leases", { unit_id: unit, tenantIds: tenants, start_date: "2027-01-01", end_date: "2027-12-31", rent_cents: 250000, due_day: 10 })).lease.id;
    await post(`/api/leases/${lease}/guarantees`, { kind: "caucao", amount_cents: 750000 });

    const menu = page.locator(".sidebar");
    // Dados da empresa pela tela.
    await menu.getByRole("button", { name: "Modelos", exact: true }).click();
    await page.getByRole("button", { name: "Dados da empresa" }).click();
    let dlg = page.getByRole("dialog");
    const company: [string, string][] = [["Razão social", "Ethos Administradora de Imóveis Ltda"], ["CNPJ", "00.000.000/0001-00"], ["Endereço completo", "Av. Central, 100"], ["Cidade/UF", "São Paulo, SP"], ["Telefone", "(11) 3000-0000"], ["WhatsApp", "(11) 90000-0000"], ["E-mail", "contato@ethos.example.com"]];
    for (const [label, value] of company) await dlg.getByLabel(label, { exact: true }).fill(value);
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Modelo padrão pela tela.
    await page.getByRole("button", { name: "Novo modelo" }).click();
    dlg = page.getByRole("dialog");
    await dlg.getByLabel("Começar de um modelo pronto").selectOption("residencial-caucao");
    const tplName = unique("Padrão Ethos");
    await dlg.getByLabel("Nome", { exact: true }).fill(tplName);
    await dlg.getByLabel(/^Variáveis/).fill("qualificacao");
    await expect(dlg.getByRole("button", { name: "{{locatario.qualificacao}}" })).toBeVisible();
    await dlg.screenshot({ path: info.outputPath("modelo-editor.png") });
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("row").filter({ hasText: tplName })).toContainText("Locação residencial");

    // Emissão pela tela.
    await menu.getByRole("button", { name: "Contratos", exact: true }).click();
    await page.getByRole("row").filter({ hasText: propName }).click();
    await page.getByLabel("Modelo", { exact: true }).selectOption({ label: `${tplName} (v1)` });
    await page.getByRole("button", { name: "Pré-visualizar" }).click();
    const doc = page.locator(".eth-doc");
    await expect(doc).toContainText("MINUTA");
    await expect(doc.locator(".eth-sign")).toHaveCount(5);
    await page.getByRole("button", { name: "Emitir e guardar" }).click();
    await expect(page.getByRole("row").filter({ hasText: /ETH-\d{4}-\d{4}/ })).toBeVisible();
    await page.getByRole("row").filter({ hasText: /ETH-\d{4}-\d{4}/ }).getByRole("button", { name: "Abrir" }).click();
    await expect(doc.locator(".eth-meta")).toContainText(/ETH-\d{4}-\d{4}/);
    await expect(doc.locator(".eth-draft")).toHaveCount(0);
    await expect(doc.locator(".eth-foot")).toContainText(/verificação [0-9a-f]{16}/);
    await expect(doc.locator(".eth-watermark")).toHaveCount(1);
    for (const name of ["Alice Locadora Teste", "Bruno Locador Teste", "Carla Inquilina Teste", "Davi Inquilino Teste"]) await expect(doc.locator(".eth-sign").filter({ hasText: name })).toHaveCount(1);
    await expect(doc).not.toContainText("{{");
    await expect(doc).not.toContainText("**");
    await doc.screenshot({ path: info.outputPath("documento-tela.png") });

    // Celular: o documento cabe na largura, sem rolagem horizontal.
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await doc.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("documento-celular.png"), animations: "disabled" });
    // Cabe na tela de verdade: o documento e cada parágrafo ficam dentro da largura visível.
    const outside = await doc.evaluate((el) => [el, ...el.querySelectorAll("h1, h2, p, .eth-head, .eth-sign")].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > window.innerWidth + 1) }).map((n) => `${n.tagName}.${n.className} ${Math.round(n.getBoundingClientRect().left)}..${Math.round(n.getBoundingClientRect().right)}`).slice(0, 6));
    expect(outside).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 900 });

    // PDF pela impressão do navegador.
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".shell")).toBeHidden();
    // Nada ocupa espaço antes do documento (senão a primeira folha sai em branco).
    expect(await doc.evaluate((el) => el.getBoundingClientRect().top + window.scrollY)).toBeLessThan(40);
    await page.pdf({ path: info.outputPath("contrato.pdf"), preferCSSPageSize: true, printBackground: true });
  });
});
