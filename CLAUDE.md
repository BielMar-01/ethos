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
- Pasta local: `C:\Projetos\ethos` (repositório git sem commits ainda; branch `master`).
- Stack atual: Node.js + **Express 5** + **TypeScript** (strict, NodeNext, CommonJS). Apenas `express` como dependência.
- Arquivos: `src/server.ts`, `public/index.html`, `tsconfig.json`, `package.json`.
- Scripts: `npm run dev` (tsx watch), `npm run build` (tsc), `npm start`. **Não há testes** (`npm test` é placeholder).
- **Divergência a sinalizar:** a documentação cita repositório `ethos-administracao` com backend em `apps/api` e integração Supabase/PostgreSQL. Esta pasta é plana (`src/` na raiz) e **não tem** Supabase, ORM, auth, migrações nem `.env`. Confirmar com o usuário qual é o repositório de referência antes de estruturar o projeto (monorepo vs. pasta atual).
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
