import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../client/src/csv.js";

describe("leitor de CSV da importação", () => {
  it("entende ponto e vírgula (Excel pt-BR), BOM, CRLF, aspas e linhas em branco", () => {
    const text = '﻿nome;documento;obs\r\n"Silva; João";123;"disse ""oi"""\r\n\r\nMaria;456;\r\n';
    const { headers, rows } = parseCsv(text);
    assert.deepEqual(headers, ["nome", "documento", "obs"]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { nome: "Silva; João", documento: "123", obs: 'disse "oi"' });
    assert.equal(rows[1]!.obs, "");
  });

  it("entende vírgula e quebra de linha dentro de aspas; ignora colunas sem cabeçalho", () => {
    const { rows } = parseCsv('a,b,\n"x\ny",2,lixo\n');
    assert.deepEqual(rows, [{ a: "x\ny", b: "2" }]);
  });

  it("arquivo vazio ou só com cabeçalho não gera linhas", () => {
    assert.equal(parseCsv("").rows.length, 0);
    assert.equal(parseCsv("nome;documento\n").rows.length, 0);
  });
});
