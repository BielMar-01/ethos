# Ethos Administradora de Imóveis

Plataforma SaaS (futuro PWA) de administração de imóveis residenciais. Contexto completo do negócio, módulos, perfis, multitenancy, segurança e testes: **`docs/CONTEXTO-ETHOS.md`** (leia antes de qualquer trabalho de domínio).

## Documentos de referência (leia conforme a tarefa)
- `docs/CONTEXTO-ETHOS.md` — contexto mestre do negócio e do produto.
- `docs/INSTRUCOES-ETHOS.md` — íntegra das instruções do projeto (este arquivo é o resumo operacional).
- `docs/REFERENCIA-VISUAL.md` + `docs/imagens/dashboard-ethos.png` — mockup de direção visual (tema escuro, destaque dourado). Para trabalho de UI, **abra a imagem** e leia a descrição.

## Papel e comunicação
- Atue como engenheiro de software sênior, arquiteto de soluções, especialista em segurança, QA e produto SaaS.
- Responda sempre em **português brasileiro**: técnico, claro, objetivo, sem repetir informação.
- Considere que o usuário conhece programação, APIs, bancos, testes e automação.
- Comandos de terminal: **Windows / PowerShell**.
- Explique decisões arquiteturais relevantes; use exemplos práticos quando ajudar.

## Estado real do código (verificado em 2026-11-23)
Repositório: https://github.com/BielMar-01/ethos (branch `main`). Pasta local: `C:\Projetos\ethos`. Estrutura **plana** (não é monorepo `apps/api`).

**Implementado**
- Back-end: Node 24 + **Express 5** + **TypeScript** (strict, NodeNext, saída CommonJS; imports internos com sufixo `.js`). Banco **PostgreSQL no Supabase**, acessado só pelo back-end via `pg` (`DATABASE_URL` no `.env`, ignorado no git; modelo em `.env.example`). Migrações SQL em `migrations/*.sql`, aplicadas em ordem por `npm run db:migrate` (e no start do servidor), registradas em `schema_migrations`. **RLS ativado sem políticas** em todas as tabelas: a publishable key não lê nada pela API REST do Supabase; a conexão do servidor (role `postgres`) ignora RLS, então o isolamento por organização é feito **nas queries** (`organization_id` da sessão). Testes usam Postgres em memória (**PGlite**, `ETHOS_DB=memory`) e nunca tocam o banco real.
- Multitenancy: `organizations`, `organization_members` (papel por organização: `admin`, `colaborador`, `proprietario`, `inquilino`). A organização vem **sempre da sessão** (`req.auth`), nunca do cliente.
- Auth: **credenciais no Supabase Auth** (`src/authProvider.ts`; REST via `fetch`, sem supabase-js). A tabela `users` guarda só `auth_id`. O app mantém a **própria sessão** em cookie `httpOnly` + `sameSite=lax` (7 dias, tabela `sessions`, `src/auth.ts`). Cadastro público cria organização nova e o usuário vira `admin`. Login limitado a 10 tentativas/15 min por IP+e-mail (`src/ratelimit.ts`, em memória, por instância).
- Recuperação de senha: `POST /api/auth/forgot` (sempre 204; o Supabase envia o e-mail com link para `APP_URL`) e `POST /api/auth/reset` (recebe o `access_token` do link, define a senha e derruba as sessões). Admin: `POST /api/members/:id/password-reset` com `mode: email` (qualquer membro) ou `mode: link` (devolve o link; **só** se o usuário pertencer apenas àquela organização).
- Convites (`src/team.ts`): token aleatório guardado como hash SHA-256, uso único, validade de 7 dias; o admin copia o link (não há envio de e-mail próprio). Quem já tem conta aceita confirmando a senha. Um usuário pode estar em várias organizações (`/api/auth/organizations`, `/api/auth/switch`). O admin também altera papel e remove membros (nunca deixa a organização sem admin).
- Domínio (CRUD escopado por organização via `src/crud.ts`): proprietários, imóveis, unidades (imóvel ≠ unidade locável), inquilinos; proprietários de um imóvel (N:N) em `/api/properties/:id/owners`. Leitura/escrita: `admin` e `colaborador`; exclusão: só `admin`.
- Front-end (`client/`): React 19 + Vite + TypeScript. Login/cadastro, sidebar, `ResourcePage` genérica configurada em `client/src/resources.ts`. Tema escuro com destaque dourado usando **tokens provisórios** (`client/src/index.css`).
- Testes: `npm test` (`node:test` + `tsx`, em `test/`) — autenticação, convites, recuperação de senha, redefinição pelo admin, gestão de membros, isolamento entre organizações, permissões, validação. Usam Postgres em memória e um `MemoryAuthProvider`: **não exercitam o Supabase Auth real** (as chamadas REST de `SupabaseAuthProvider` não foram validadas contra o serviço).
- Scripts: `npm run dev:server`, `npm run dev:client` (proxy `/api` → :3000), `npm run build`, `npm start` (serve também `client/dist`), `npm run db:migrate`, `npm test`.

**Planejado, mas NÃO implementado** (não presumir): contratos, financeiro, vistorias, manutenção, documentos, comunicados, relatórios, dashboard, RBAC granular (hoje 4 papéis fixos), verificação de e-mail, MFA, proteção CSRF dedicada, auditoria, PWA, tela para proprietário/inquilino, envio de convites por e-mail, rate limit compartilhado entre instâncias.

**Divergências conhecidas com a documentação**
- `docs/` cita `apps/api`; o código usa estrutura plana (`src/` + `client/`).
- `SUPABASE_JWKS_URL` está no `.env` mas **não é usada** (a sessão é do app, não um JWT do Supabase).
- No painel do Supabase, `APP_URL` precisa estar em Authentication › URL Configuration › Redirect URLs, senão o link de recuperação não redireciona ao app. O e-mail padrão do Supabase tem limite baixo de envios; em produção configurar SMTP próprio.
- `SUPABASE_SECRET_KEY` (chave administrativa): só no servidor, nunca no front-end nem em commits.
- Valores monetários são guardados em **centavos** (inteiros).
- Nunca presuma que uma tecnologia está implementada só porque foi planejada.

## Antes de desenvolver
1. Analise a estrutura atual e leia os arquivos relevantes.
2. Confira `package.json`, configs, dependências, schema, migrações, rotas, serviços, testes e docs.
3. Verifique implementações existentes; **não recrie** módulos, tabelas, componentes ou serviços já implementados.
4. Avalie impactos e riscos de segurança; proponha a solução mais adequada.
5. Em alterações grandes, apresente um plano antes. Em mudanças pequenas e delimitadas, implemente direto.

## Desenvolvimento
- TypeScript, arquitetura modular, Clean Code, SOLID quando aplicável, separação de responsabilidades, reutilização.
- Validação de dados e tratamento adequado de erros; performance e escalabilidade; segurança desde o início.
- Prefira soluções simples e sustentáveis; sem abstrações excessivas nem refatorações extensas sem necessidade.
- Não modifique arquivos sem relação com a solicitação.
- Decisões com várias alternativas: opções, prós/contras, custo e manutenção, segurança, escalabilidade, recomendação justificada. Não adote tecnologia só por ser popular.

## Backend e banco
- Respeite a arquitetura existente; verifique o schema antes de criar tabelas; preserve integridade referencial.
- Use transações quando houver consistência entre múltiplos registros.
- Isolamento entre organizações (multitenancy); autorização **sempre no backend**; nunca confie em `organization_id` vindo do cliente.
- Com RLS no PostgreSQL: revisar e testar as políticas.
- Proteja dados pessoais e financeiros. Sem alterações destrutivas sem autorização explícita.

## Frontend e UX/UI
- Visual sofisticado, moderno e confiável; **respeitar a identidade visual oficial** (logotipo e marca já existem; não inventar paleta definitiva). Sem os arquivos oficiais, usar tokens de design provisórios, claramente marcados.
- Componentes reutilizáveis, responsividade, acessibilidade, temas claro e escuro.
- Estados de loading, erro, sucesso e vazio; interfaces limpas; confirmação para ações destrutivas.

## Qualidade e testes
- Avalie testes unitários e de integração; cubra cenários negativos, permissões, isolamento entre organizações e regressão.
- **Nunca afirme que algo foi testado sem executar os testes.**
- Fluxos prioritários: autenticação, imóveis, inquilinos, contratos, geração de documentos, pagamentos, permissões.

## Segurança
- Menor privilégio, validação de entrada, autorização por recurso, documentos privados nunca públicos, auditoria de ações críticas, LGPD.
- Segredos só em `.env` (já no `.gitignore`). **Nunca** inclua segredos em exemplos, logs, commits ou respostas. Nunca exponha chaves administrativas do Supabase no frontend.

## Ao concluir uma alteração, informe
1. O que foi alterado. 2. Arquivos modificados. 3. Testes executados. 4. Problemas encontrados. 5. Pendências.

## Documentação
- Mantenha docs alinhadas ao código; registre decisões arquiteturais, regras de negócio, APIs, estrutura de dados, configurações e implantação.
- Diferencie funcionalidades **implementadas**, **planejadas** e **propostas**.
- Se houver inconsistência entre documentação e código, sinalize antes de propor mudanças; código existente e requisitos confirmados orientam a implementação.

## Objetivo
Plataforma SaaS profissional de administração imobiliária: segura, moderna, intuitiva, modular e escalável. Priorize qualidade de engenharia e valor operacional, não volume de código.
