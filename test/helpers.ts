// Postgres em memória (PGlite) e provedor de identidade em memória: nunca tocam o Supabase.
process.env.ETHOS_DB = "memory";
process.env.REGISTER_RATE_MAX = "1000";
process.env.APP_URL = "http://app.test";

import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export const PASSWORD = "senha-segura-123";

export async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const { migrate, closeDb } = await import("../src/db.js");
  await migrate();
  const { createApp } = await import("../src/app.js");
  const server: Server = createApp().listen(0);
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.close();
      await closeDb();
    },
  };
}

/** Cliente mínimo que guarda o cookie de sessão. */
export class Client {
  cookie = "";
  constructor(public base: string) {}

  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(this.base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

/** Envia um corpo binário (foto) com o cookie da sessão. */
export async function upload(c: Client, path: string, body: Buffer, contentType = "image/jpeg") {
  const res = await fetch(c.base + path, {
    method: "POST",
    headers: { "Content-Type": contentType, ...(c.cookie ? { Cookie: c.cookie } : {}) },
    body: new Uint8Array(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Baixa um recurso binário (foto) com o cookie da sessão. */
export async function download(c: Client, path: string) {
  const res = await fetch(c.base + path, { headers: c.cookie ? { Cookie: c.cookie } : {} });
  return { status: res.status, type: res.headers.get("content-type"), bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

/** "Imagens" mínimas: só o cabeçalho que identifica o formato (o servidor valida pelo conteúdo). */
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake-jpeg-body-1234567890")]);
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")]);

export async function register(base: string, email: string, org: string): Promise<Client> {
  const c = new Client(base);
  const r = await c.call("POST", "/api/auth/register", {
    name: "Admin " + org,
    email,
    password: PASSWORD,
    organizationName: org,
  });
  assert.equal(r.status, 201);
  return c;
}

export async function memoryProvider() {
  const { getAuthProvider } = await import("../src/authProvider.js");
  return getAuthProvider() as import("../src/authProvider.js").MemoryAuthProvider;
}

/** Extrai o token de invite (?invite=) ou o access_token (#access_token=) de um link. */
export function tokenFrom(link: string): string {
  const url = new URL(link);
  const invite = url.searchParams.get("invite");
  if (invite) return invite;
  return new URLSearchParams(url.hash.slice(1)).get("access_token")!;
}
