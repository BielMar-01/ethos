import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Client, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;

before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  delete process.env.CRON_SECRET;
  await close();
});

describe("preparação para a Vercel", () => {
  it("a CSP de vercel.json autoriza exatamente o script inline do tema (hash confere)", () => {
    const html = fs.readFileSync("client/index.html", "utf8").replace(/\r\n/g, "\n");
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(inline.length, 1, "só um script inline é permitido");
    const hash = createHash("sha256").update(inline[0]![1]!).digest("base64");
    const config = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
    const csp = config.headers.flatMap((h: { headers: { key: string; value: string }[] }) => h.headers).find((h: { key: string }) => h.key === "Content-Security-Policy").value;
    assert.ok(csp.includes(`'sha256-${hash}'`), "edite o script do index.html? atualize o hash na CSP de vercel.json");
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  });

  it("o cron de lembretes fica desligado sem CRON_SECRET e exige o segredo quando ligado", async () => {
    delete process.env.CRON_SECRET;
    assert.equal((await new Client(base).call("GET", "/api/reminders/cron")).status, 404);
    process.env.CRON_SECRET = "segredo-de-teste-bem-longo";
    assert.equal((await new Client(base).call("GET", "/api/reminders/cron")).status, 401);
    const wrong = await fetch(`${base}/api/reminders/cron`, { headers: { Authorization: "Bearer errado" } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${base}/api/reminders/cron`, { headers: { Authorization: "Bearer segredo-de-teste-bem-longo" } });
    assert.equal(ok.status, 200);
  });

  it("respostas levam cabeçalhos básicos de segurança", async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });
});
