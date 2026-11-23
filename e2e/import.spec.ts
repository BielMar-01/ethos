import { test, expect, type Page } from "@playwright/test";
import { fakeDoc, openPanel, unique } from "./helpers";

const csv = (name: string, body: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from("﻿" + body, "utf8") });

async function openImport(page: Page) {
  await openPanel(page);
  await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: "Importar dados", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Importar dados" })).toBeVisible();
}

test.describe("importação em massa", () => {
  test("vários arquivos de uma vez: confere, importa e os cadastros aparecem ligados entre si", async ({ page }) => {
    await openImport(page);
    const doc = fakeDoc();
    const docT = fakeDoc();
    const prop = unique("Residencial Import");
    await page.locator('input[type="file"]').setInputFiles([
      csv("proprietarios.csv", `nome;documento;email\nDono ${prop};${doc};dono@x.com\n`),
      csv("inquilinos.csv", `nome;documento\nInquilino ${prop};${docT}\n`),
      csv("imoveis.csv", `nome;tipo;cidade;uf;proprietarios\n${prop};Apartamento;Curitiba;PR;${doc}\n`),
      csv("unidades.csv", `imóvel;identificador;quartos;aluguel\n${prop};Apto 11;2;R$ 1.800,00\n${prop};Apto 12;3;2.100,00\n`),
    ]);
    // Cada arquivo foi reconhecido pelo nome.
    await expect(page.getByLabel("Tipo de proprietarios.csv")).toHaveValue("owners");
    await expect(page.getByLabel("Tipo de unidades.csv")).toHaveValue("units");

    await page.getByRole("button", { name: /Conferir antes de importar/ }).click();
    await expect(page.getByText("Tudo certo — veja o que será feito")).toBeVisible();
    // Nada foi gravado ainda (era só a conferência).
    expect((await (await page.request.get("/api/properties")).json()).items.some((p: { name: string }) => p.name === prop)).toBe(false);

    await page.getByRole("button", { name: /Importar 5 registro/ }).click();
    await expect(page.getByText("Importação concluída").first()).toBeVisible();
    await expect(page.getByText("Unidades: 2 criado(s)")).toBeVisible();

    const props = (await (await page.request.get("/api/properties")).json()).items;
    const created = props.find((p: { name: string }) => p.name === prop);
    expect(created.type).toBe("apartamento");
    const owners = (await (await page.request.get(`/api/properties/${created.id}/owners`)).json()).items;
    expect(owners).toHaveLength(1);
    const units = (await (await page.request.get("/api/units")).json()).items.filter((u: { property_id: number }) => u.property_id === created.id);
    expect(units.map((u: { rent_reference_cents: number }) => u.rent_reference_cents).sort()).toEqual([180000, 210000]);

    // Importar de novo não duplica.
    await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: "Importar dados", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles(csv("proprietarios.csv", `nome;documento\nDono ${prop};${doc}\n`));
    await page.getByRole("button", { name: /Conferir antes de importar/ }).click();
    await expect(page.getByText("Tudo isso já existe: não há nada novo para criar.")).toBeVisible();
  });

  test("erro em uma linha: mostra arquivo e linha e NÃO importa nada", async ({ page }) => {
    await openImport(page);
    const good = unique("Pessoa Boa");
    await page.locator('input[type="file"]').setInputFiles(
      csv("proprietarios.csv", `nome;documento;email\n${good};${fakeDoc()};ok@x.com\n;${fakeDoc()};\nSem Doc;;\nEmail Ruim;${fakeDoc()};isso-nao-e-email\n`),
    );
    await page.getByRole("button", { name: /Conferir antes de importar/ }).click();
    await expect(page.getByText("Corrija os problemas abaixo")).toBeVisible();
    const errors = page.locator(".error-list li");
    await expect(errors).toHaveCount(3);
    await expect(errors.first()).toContainText("proprietarios.csv, linha 3");
    await expect(errors.first()).toContainText("nome");
    await expect(page.getByRole("button", { name: /Importar \d+ registro/ })).toHaveCount(0);
    const owners = (await (await page.request.get("/api/owners")).json()).items;
    expect(owners.some((o: { name: string }) => o.name === good)).toBe(false);
  });

  test("arquivo que não é CSV é recusado com orientação; tipo desconhecido exige escolha", async ({ page }) => {
    await openImport(page);
    await page.locator('input[type="file"]').setInputFiles({ name: "planilha.xlsx", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("x") });
    await expect(page.getByText("Salvar como → CSV UTF-8")).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(csv("dados.csv", "nome;documento\nAlguém;123\n"));
    await expect(page.getByText("Escolha o tipo dos arquivos marcados para continuar.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Conferir antes de importar/ })).toBeDisabled();
    await page.getByLabel("Tipo de dados.csv").selectOption("tenants");
    await expect(page.getByRole("button", { name: /Conferir antes de importar/ })).toBeEnabled();
  });

  test("modelos para baixar abrem com as colunas certas", async ({ page }) => {
    await openImport(page);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Baixar modelo" }).first().click()]);
    expect(download.suggestedFilename()).toBe("modelo-proprietarios.csv");
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toContain("nome;documento;email;telefone");
  });
});
