# Ethos — administração de imóveis

Plataforma web para administradoras de imóveis: cadastros, contratos, financeiro, manutenção, vistorias, comunicados e uma área própria para inquilinos e proprietários, com API de leitura.

- **Estado do projeto** (feito × falta): [`docs/STATUS.md`](docs/STATUS.md)
- **Contexto do negócio**: [`docs/CONTEXTO-ETHOS.md`](docs/CONTEXTO-ETHOS.md)
- **Guia técnico para quem desenvolve** (arquitetura, regras e decisões): [`CLAUDE.md`](CLAUDE.md)

## Requisitos
Node.js 24+, um projeto no Supabase (PostgreSQL + Auth).

## Configuração
```bash
npm install && npm --prefix client install
cp .env.example .env     # preencha com as chaves do Supabase; NUNCA commite o .env
npm run db:migrate       # aplica as migrações no banco
```

## Rodar
```bash
npm run dev:server       # API em http://localhost:3000
npm run dev:client       # interface em http://localhost:5173 (proxy para a API)
npm run build && npm start   # produção: a API serve a interface compilada
```

## Experimentar sem tocar no banco
```bash
npm run build && npm run demo   # http://localhost:3100, tudo em memória, dados fictícios
```
Logins de demonstração (senha `demo-1234-senha`): `admin@demo.test`, `demo.inquilino@example.com`, `demo.proprietario@example.com`.

## Testes de ponta a ponta (Playwright)
```bash
npx playwright install chromium   # uma vez
npm run test:e2e                  # build + 70 testes em navegador (desktop e celular) sobre o modo demo
npm run test:e2e:run              # sem rebuild
npx playwright show-report        # relatório da última execução
```

## Publicar
Vercel: veja [`docs/DEPLOY-VERCEL.md`](docs/DEPLOY-VERCEL.md).

## Testes e verificação
```bash
npm test                 # 100+ testes de API e regras de negócio (Postgres em memória)
npx tsc --noEmit         # tipos do servidor
npm --prefix client run lint
```

## Operação
```bash
npm run user:reset-password -- <email>   # senha temporária para um usuário (sem argumento, lista os admins)
npm run seed:demo -- <email-do-admin>    # dados fictícios em organização VAZIA
```

API: documentação em `/api/openapi.json` (pública) e na aba **API** do painel.
