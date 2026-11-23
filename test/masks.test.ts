import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { centsFromMoney, maskCep, maskDocument, maskMoney, maskPhone, moneyFromCents, validCpfCnpj, validPhone } from "../client/src/masks.js";

describe("máscaras de digitação (cliente)", () => {
  it("telefone: celular, fixo, digitação parcial, +55 e lixo", () => {
    assert.equal(maskPhone(""), "");
    assert.equal(maskPhone("1"), "(1");
    assert.equal(maskPhone("11"), "(11");
    assert.equal(maskPhone("119"), "(11) 9");
    assert.equal(maskPhone("11912"), "(11) 912");
    assert.equal(maskPhone("11912345678"), "(11) 91234-5678");
    assert.equal(maskPhone("1132345678"), "(11) 3234-5678");
    assert.equal(maskPhone("+55 (11) 91234-5678"), "(11) 91234-5678");
    assert.equal(maskPhone("5511912345678"), "(11) 91234-5678");
    assert.equal(maskPhone("(11) 91234-5678999"), "(11) 91234-5678", "corta o excesso");
    assert.equal(maskPhone("abc"), "");
  });

  it("CPF e CNPJ conforme o tamanho, parcial e idempotente", () => {
    assert.equal(maskDocument("123"), "123");
    assert.equal(maskDocument("1234"), "123.4");
    assert.equal(maskDocument("1234567"), "123.456.7");
    assert.equal(maskDocument("12345678909"), "123.456.789-09");
    assert.equal(maskDocument("123.456.789-09"), "123.456.789-09");
    assert.equal(maskDocument("123456789012"), "12.345.678/9012");
    assert.equal(maskDocument("12345678000195"), "12.345.678/0001-95");
    assert.equal(maskDocument("12.345.678/0001-95"), "12.345.678/0001-95");
    assert.equal(maskDocument("123456780001959999"), "12.345.678/0001-95", "corta o excesso");
  });

  it("CEP", () => {
    assert.equal(maskCep("01001"), "01001");
    assert.equal(maskCep("010010"), "01001-0");
    assert.equal(maskCep("01001000"), "01001-000");
    assert.equal(maskCep("01001-000999"), "01001-000");
  });

  it("moeda: digita da direita para a esquerda, milhar e conversão de/para centavos", () => {
    assert.equal(maskMoney(""), "");
    assert.equal(maskMoney("1"), "0,01");
    assert.equal(maskMoney("15"), "0,15");
    assert.equal(maskMoney("150"), "1,50");
    assert.equal(maskMoney("250000"), "2.500,00");
    assert.equal(maskMoney("2.500,00"), "2.500,00", "idempotente");
    assert.equal(maskMoney("123456789"), "1.234.567,89");
    assert.equal(maskMoney("0001"), "0,01", "zeros à esquerda");
    assert.equal(maskMoney("abc"), "");
    assert.equal(moneyFromCents(150000), "1.500,00");
    assert.equal(moneyFromCents(5), "0,05");
    assert.equal(moneyFromCents(null), "");
    assert.equal(centsFromMoney("1.500,00"), 150000);
    assert.equal(centsFromMoney("0,05"), 5);
    assert.equal(centsFromMoney(""), null);
    for (const c of [1, 99, 100, 150000, 99999999]) assert.equal(centsFromMoney(moneyFromCents(c)), c);
  });

  it("valida CPF/CNPJ (dígito verificador) e telefone", () => {
    assert.equal(validCpfCnpj("123.456.789-09"), true);
    assert.equal(validCpfCnpj("111.222.333-96"), true);
    assert.equal(validCpfCnpj("123.456.789-00"), false);
    assert.equal(validCpfCnpj("111.111.111-11"), false);
    assert.equal(validCpfCnpj("11.222.333/0001-81"), true);
    assert.equal(validCpfCnpj("11.222.333/0001-80"), false);
    assert.equal(validCpfCnpj("123"), false);
    assert.equal(validPhone("(11) 91234-5678"), true);
    assert.equal(validPhone("(11) 3234-5678"), true);
    assert.equal(validPhone("(11) 8234-56789"), false);
    assert.equal(validPhone("(11) 9123"), false);
  });
});
