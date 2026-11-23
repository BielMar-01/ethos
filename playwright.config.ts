import { defineConfig, devices } from "@playwright/test";

/**
 * Testes de ponta a ponta (navegador real) sobre o MODO DEMONSTRAÇÃO: app completo em memória, com dados fictícios e logins prontos.
 * Nunca toca no Supabase. Antes de rodar: `npm run build` (o demo serve client/dist). `npm run test:e2e` já faz isso.
 */
const PORT = Number(process.env.E2E_PORT ?? 3199);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", testIgnore: /.*\.mobile\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", testMatch: /.*\.mobile\.spec\.ts/, use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run demo",
    // O servidor já responde ao /api/health ANTES de terminar de popular os dados e criar os logins de cliente:
    // esperamos a mensagem final, senão os primeiros testes (em paralelo) levam 401 no login do inquilino.
    wait: { stdout: /Tudo é descartado ao encerrar/ },
    env: {
      PORT: String(PORT),
      // Integrações: chave de cifra de teste e permissão para webhooks apontarem para um receptor local do próprio teste.
      INTEGRATIONS_SECRET: "e2e-segredo-com-mais-de-32-caracteres-ok",
      ETHOS_ALLOW_PRIVATE_WEBHOOKS: "1",
      ETHOS_WEBHOOK_BACKOFF_MS: "10",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
});
