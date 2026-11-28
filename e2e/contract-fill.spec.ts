import { expect, test, type Locator } from "@playwright/test";
import { fakeDoc, openPanel, unique } from "./helpers";

/** Preenche todos os campos vazios do formulário com um valor válido para o tipo. */
async function fillEverything(dlg: Locator) {
  for (const select of await dlg.locator("select").all()) await select.selectOption({ index: 1 });
  for (const box of await dlg.locator("fieldset input[type=checkbox]").all()) {
    await box.check();
    break;
  }
  for (const input of await dlg.locator("form input:not([type=checkbox])").all()) {
    const label = await input.evaluate((el) => el.closest("label")?.textContent ?? "");
    const type = await input.getAttribute("type");
    const money = (await input.getAttribute("inputmode")) === "decimal";
    await input.fill(money ? "3000,00" : type === "number" ? "3" : type === "email" ? "contato@ethos.example.com" : label.startsWith("UF") ? "SP" : label.startsWith("CEP") ? "01000-000" : "Dado de teste");
  }
}

test.describe("completar dados na tela do contrato", () => {
  test("pré-visualizar com cadastro incompleto abre o preenchimento e, ao salvar, mostra o documento", async ({ page }, info) => {
    test.setTimeout(120_000);
    await openPanel(page);
    const post = async (url: string, data: unknown) => {
      const r = await page.request.post(url, { data: data as object });
      expect(r.ok(), `${url}: ${await r.text()}`).toBeTruthy();
      return r.json();
    };
    const owner = (await post("/api/owners", { name: "Olga Sem Dados", document: fakeDoc() })).item.id;
    const tenant = (await post("/api/tenants", { name: "Teo Sem Dados", document: fakeDoc() })).item.id;
    const propName = unique("Casa Incompleta");
    const prop = (await post("/api/properties", { name: propName, type: "casa" })).item.id;
    expect((await page.request.put(`/api/properties/${prop}/owners`, { data: { ownerIds: [owner] } })).ok()).toBeTruthy();
    const unit = (await post("/api/units", { property_id: prop, identifier: "U1" })).item.id;
    await post("/api/leases", { unit_id: unit, tenantIds: [tenant], start_date: "2027-01-01", end_date: "2027-12-31", rent_cents: 100000, due_day: 5 });
    const starter = (await (await page.request.get("/api/contract-starters")).json()).items[0];
    const tplName = unique("Padrão para completar");
    await post("/api/contract-templates", { name: tplName, type: starter.type, body: starter.body });

    await page.locator(".sidebar").getByRole("button", { name: "Contratos", exact: true }).click();
    await page.getByRole("row").filter({ hasText: propName }).click();
    await page.getByLabel("Modelo", { exact: true }).selectOption({ label: `${tplName} (v1)` });
    await page.getByRole("button", { name: "Pré-visualizar" }).click();

    const dlg = page.getByRole("dialog", { name: "Completar dados do contrato" });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole("heading", { name: "Locador: Olga Sem Dados" })).toBeVisible();
    await expect(dlg.getByRole("heading", { name: "Locatário: Teo Sem Dados" })).toBeVisible();
    await dlg.screenshot({ path: info.outputPath("completar.png"), animations: "disabled" });

    // Cabe no celular, sem campo cortado.
    await page.setViewportSize({ width: 390, height: 844 });
    const outside = await dlg.evaluate((el) => [...el.querySelectorAll("input, select, h4")].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > window.innerWidth + 1); }).length);
    expect(outside).toBe(0);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Fechar não perde o caminho: o botão reabre.
    await dlg.getByRole("button", { name: "Fechar janela" }).click();
    await expect(page.getByText(/Faltam \d+ informação/)).toBeVisible();
    await page.getByRole("button", { name: "Preencher agora" }).click();

    // Alguém preenche um dos campos por outro caminho com a janela aberta: salvar não pode travar nem sobrescrever.
    expect((await page.request.patch(`/api/tenants/${tenant}`, { data: { nationality: "preenchida por outra pessoa" } })).ok()).toBeTruthy();
    // Pode salvar aos poucos; os dados da empresa podem já existir por outro teste, então o laço vai até o documento sair.
    const doc = page.locator(".eth-doc");
    for (let round = 0; round < 3 && !(await doc.isVisible()); round++) {
      await expect(dlg).toBeVisible();
      await fillEverything(dlg);
      await dlg.getByRole("button", { name: "Salvar e pré-visualizar" }).click();
      await expect(doc.or(dlg.getByRole("button", { name: "Salvar e pré-visualizar", disabled: false }))).toBeVisible();
    }
    await expect(doc).toContainText("Teo Sem Dados");
    await expect(doc).toContainText("Dado de teste");
    await expect(page.getByText(/Faltam \d+ informação/)).toHaveCount(0);

    const saved = (await (await page.request.get(`/api/tenants/${tenant}`)).json()).item;
    expect(saved.profession).toBe("Dado de teste");
    expect(saved.nationality).toBe("preenchida por outra pessoa");
    await page.getByRole("button", { name: "Emitir e guardar" }).click();
    await expect(page.getByRole("row").filter({ hasText: /ETH-\d{4}-\d{4}/ })).toBeVisible();
  });
});
