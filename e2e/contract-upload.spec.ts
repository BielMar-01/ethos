import { expect, test } from "@playwright/test";
import { openPanel, unique } from "./helpers";

test.describe("enviar modelo e documentos existentes", () => {
  test("modelo enviado vira o padrão do contrato; contrato ativo recebe os arquivos já existentes", async ({ page }, info) => {
    await openPanel(page);
    const menu = page.locator(".sidebar");

    // 1) Enviar o arquivo do modelo e revisar antes de salvar.
    await menu.getByRole("button", { name: "Modelos", exact: true }).click();
    await expect(page.getByRole("button", { name: "Enviar meu modelo" })).toBeVisible();
    const name = unique("Meu modelo");
    await page.getByLabel("Arquivo do modelo").setInputFiles({ name: `${name}.md`, mimeType: "text/markdown", buffer: Buffer.from("---\na: 1\n---\n# CONTRATO\n\n### 1 — PARTES\n\nLocatário: {{locatario.nome}}, aluguel {{contrato.valor_aluguel}}.\n", "utf8") });
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByText("Arquivo convertido")).toBeVisible();
    await expect(dlg.getByLabel("Texto do contrato")).toHaveValue(/## 1 — PARTES/);
    await expect(dlg.getByLabel("Nome", { exact: true })).toHaveValue(name);
    await expect(dlg.getByLabel(/modelo padrão dos próximos contratos/)).toBeChecked();
    await dlg.screenshot({ path: info.outputPath("modelo-enviado.png"), animations: "disabled" });
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("row").filter({ hasText: name })).toContainText("Padrão");

    // 2) No contrato ativo, o padrão já vem escolhido.
    await menu.getByRole("button", { name: "Contratos", exact: true }).click();
    const row = page.getByRole("row").filter({ hasText: "Vigente" }).first();
    await row.click();
    await expect(page.getByLabel("Modelo", { exact: true }).locator("option:checked")).toContainText(`${name} (v1) · padrão`);

    // 3) Anexar os documentos que já existem (vários de uma vez; o inválido é apontado e os outros seguem).
    const tag = unique("assinado");
    await page.getByLabel("Arquivos do contrato").setInputFiles([
      { name: `${tag}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`) },
      { name: `laudo ${tag}.png`, mimeType: "image/png", buffer: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(tag)]) },
      { name: "falso.pdf", mimeType: "application/pdf", buffer: Buffer.from("não sou um pdf") },
    ]);
    await expect(page.getByText("falso.pdf: O arquivo não é um PDF")).toBeVisible();
    const file = page.getByRole("row").filter({ hasText: tag }).first();
    await expect(file).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: `Baixar ${tag}`, exact: true }).click();
    expect((await download).suggestedFilename()).toBe(`${tag}.pdf`);
    await page.getByRole("button", { name: `Excluir ${tag}`, exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: /^Excluir/ }).click();
    await expect(page.getByRole("button", { name: `Baixar ${tag}`, exact: true })).toHaveCount(0);

    // Deixa o demo como estava: sem modelo padrão.
    const templates = (await (await page.request.get("/api/contract-templates")).json()).items as { id: number; name: string }[];
    const mine = templates.find((t) => t.name === name)!;
    expect((await page.request.delete(`/api/contract-templates/${mine.id}`)).ok()).toBeTruthy();
  });
});
