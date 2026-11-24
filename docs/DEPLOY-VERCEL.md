# Publicar o Ethos na Vercel

## Como funciona
- **Interface**: `client/dist` (build do Vite) é servida como estático pela Vercel.
- **API**: `api/index.js` carrega o Express compilado (`dist/app.js`); `vercel.json` reescreve `/api/*` para ele.
- **Build** (`scripts/vercel-build.mjs`): compila servidor e interface; **só em Production** aplica as migrações (`npm run db:migrate`). Previews não tocam o banco.
- **Lembretes**: Vercel Cron chama `GET /api/reminders/cron` uma vez por dia (08h de Brasília, limite do plano Hobby; no Pro pode ser mais frequente). Exige `CRON_SECRET`; sem ele a rota fica desligada.
- **Segurança**: `vercel.json` define HSTS, CSP (sem `unsafe-inline` em scripts; o script do tema é liberado por hash), `X-Frame-Options`, etc. Um teste (`test/deploy.test.ts`) falha se alguém editar o script inline do `client/index.html` sem atualizar o hash.

## Passo a passo
1. **Rotacione os segredos** que já passaram pelo chat (senha do banco, `SUPABASE_SECRET_KEY`) e use os novos abaixo.
2. Vercel → *Add New Project* → importe `BielMar-01/ethos`. Framework: **Other** (o `vercel.json` já define comandos e saída).
3. *Settings → Environment Variables* (Production; Preview só se tiver banco de teste):
   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | **Transaction pooler** do Supabase (Connect → porta 6543). Conexão direta esgota em serverless. |
   | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | do painel do Supabase |
   | `APP_URL` | `https://seu-dominio` (sem barra no fim) |
   | `CRON_SECRET` | texto longo e aleatório (ex.: `openssl rand -hex 32`) |
   | `INTEGRATIONS_SECRET` | texto aleatório de 32+ caracteres (`openssl rand -base64 48`). Cifra as chaves de integrações. **Guarde uma cópia: se perder ou trocar, as chaves salvas ficam ilegíveis e precisam ser cadastradas de novo.** |
   | `ANTHROPIC_API_KEY` | (opcional) liga a leitura automática de documentos; sem ela a tela avisa que está desligada. Cada leitura é cobrada pela Anthropic. |
4. Supabase → *Authentication → URL Configuration*: **Site URL** = `APP_URL` e adicione-a em **Redirect URLs**. Configure também um **SMTP próprio** (o padrão tem limite baixo). **A troca de e-mail e a verificação de cadastro dependem desse envio**: o Supabase manda o link ao endereço novo. Em *Authentication → Providers → Email*, "Secure email change" ligado (padrão) pede a confirmação também no e-mail antigo; desligado, basta clicar no novo. Opcional: `REQUIRE_EMAIL_VERIFICATION=1` exige confirmar o e-mail no cadastro público. O 2FA exige `INTEGRATIONS_SECRET`.
5. Faça o deploy. Confira: `https://…/api/health` → `{"status":"ok"}`; abra o app, cadastre/entre e teste "Esqueci minha senha".
6. Domínio próprio: *Settings → Domains* (HTTPS é automático). Atualize `APP_URL` e as Redirect URLs.

## Limitações conhecidas em serverless
- O limite de tentativas das rotas de **segurança** (login, cadastro, senha, 2FA, convites) é **compartilhado entre instâncias** (guardado no banco). Os limites das rotas de baixo risco (CEP, leitura de documentos, chaves de API) ainda são por instância.
- O `setInterval` de lembretes não roda; quem faz o trabalho é o Cron (**precisão**: no Hobby é 1×/dia; veja docs/CONFIGURACAO-PENDENTES.md, seção 8).
- **Configuração de e-mail, WhatsApp, push, login social e demais serviços:** docs/CONFIGURACAO-PENDENTES.md.
- Corpo de requisição na Vercel: máx. 4,5 MB (as fotos já são limitadas a 3 MB).
- Fotos continuam no PostgreSQL; com volume, migrar para Supabase Storage (só `src/photos.ts` muda).
- O service worker guarda só a casca do app; ao publicar mudanças grandes, altere `VERSION` em `client/public/sw.js`.
