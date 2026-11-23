# Ethos — estado do projeto

> Atualizado em 2026-11-23. Fonte da verdade do **código** é o `CLAUDE.md`; este documento é o balanço de produto: o que existe e o que falta.
> Legenda: ✅ feito e testado por API · 🟡 feito, mas **não validado em navegador/serviço real** · ⬜ não feito.

## 1. O que já foi feito

### Base e plataforma
- ✅ Back-end Node 24 + Express 5 + TypeScript; PostgreSQL no Supabase; 8 migrações versionadas; **RLS em todas as 30 tabelas** (a chave pública não lê nada).
- ✅ Multi-organização: isolamento por `organization_id` vindo **sempre da sessão**; um usuário pode participar de várias organizações.
- ✅ Autenticação: credenciais no Supabase Auth, sessão própria em cookie `httpOnly`; cadastro, login, logout, recuperação de senha, redefinição pelo admin (e-mail ou link), convites de uso único (7 dias), limite de tentativas.
- ✅ Papéis: administrador, colaborador, proprietário, inquilino; gestão de equipe (papel, remoção, nunca fica sem admin).
- ✅ **Chaves de API** somente leitura + **documentação OpenAPI** pública gerada de registro com exemplos (teste garante que todo endpoint documentado existe).
- ✅ 110 testes automatizados (API, regras de negócio, isolamento entre organizações, permissões) sobre Postgres em memória.

### Módulos de negócio
- ✅ **Cadastros**: proprietários, imóveis (vários proprietários), unidades locáveis, inquilinos; proteção contra apagar o que está em uso.
- ✅ **Contratos**: modelos com variáveis e versão; contratos com vários locatários; status controlado; bloqueio de sobreposição na mesma unidade; documentos emitidos **imutáveis**; geração recusada se faltar dado.
- ✅ **Financeiro**: cobrança, pagamento, baixa e repasse separados; status derivado; geração mensal idempotente; recibos numerados; estorno com histórico; repasses por proprietário com taxa de administração; resumo do mês.
- ✅ **Manutenção**: chamados com prioridade, responsável, fluxo de status, orçamentos com aprovação do admin, linha do tempo (notas internas × visíveis ao cliente), fotos.
- ✅ **Vistorias**: checklist por ambiente, fotos, conclusão só com tudo avaliado, laudo, registro de ciência, comparação entrada × saída, imutável depois de concluída.
- ✅ **Comunicados e notificações**: comunicados por público (todos, inquilinos, proprietários, imóvel); notificações internas por eventos; **lembretes automáticos** (vencimento próximo, atraso, fim de contrato); preferências por categoria.
- ✅ **Registros de atividade (auditoria)**: toda escrita e toda negação de permissão, login e login falho; só o admin vê; filtros, paginação e CSV; imutável.
- ✅ **CEP**: máscara e preenchimento automático do endereço (ViaCEP → BrasilAPI, via servidor).
- 🟡 **Cadastro por documento (IA)**: foto/PDF de RG, CNH, contrato, matrícula, IPTU → sugestões de proprietário, inquilino, imóvel, unidade e **rascunho** de contrato, com revisão antes de gravar. **Só liga com `ANTHROPIC_API_KEY`; nunca testado com a API real** (os testes usam cliente falso). Qualidade de leitura depende do documento: sempre conferir.
- ✅ **Testes E2E em navegador (Playwright)**: 54 testes (desktop e celular) sobre o demo; rodam no CI.
- ✅ **Redefinição de senha pelo admin** (e-mail, link ou senha definida na hora/temporária), com sessões encerradas e auditoria.
- ✅ **Importação em massa** por CSV (proprietários, inquilinos, imóveis, unidades — vários arquivos de uma vez), com simulação, tudo-ou-nada, linha do erro e sem duplicar. 🟡 tela nunca vista em navegador.
- 🟡 **Áreas públicas** com animações, transições e login em tela dividida (nunca vistas em navegador).
- 🟡 **PWA**: instalável, abre offline com tela de aviso (dados nunca em cache); ícones provisórios.
- 🟡 **Avisos e confirmações** padronizados (toasts, erros inline, diálogo de confirmação, esqueletos de carregamento).
- ✅ **Painel** da equipe: ocupação, contratos, financeiro do mês, chamados, vistorias e "pede atenção agora".
- ✅ **Área do cliente** (inquilino e proprietário): cobranças, recibos, contrato, documentos, manutenção, vistorias (com ciência), comunicados, repasses — sempre pelo vínculo com o cadastro.

### Interface e design
- 🟡 **Tema claro, escuro e do sistema** (escolha lembrada); tokens de cor com contraste calculado; fontes **locais** (Inter + Fraunces, sem CDN).
- 🟡 Layout responsivo: barra lateral agrupada com ícones que vira **gaveta no celular**, alvos de toque de 44 px, campos de 16 px (sem zoom no iOS), tabelas com rolagem indicada, áreas seguras (notch).
- 🟡 **Home pública** com funcionalidades, públicos, segurança, API, FAQ e botões de ação; documentação da API pública.
- 🟡 Sino de notificações, telas de Equipe, API, Contratos, Financeiro, Manutenção, Vistorias, Comunicados e Modelos.
- ✅ Dados de demonstração: `npm run demo` (em memória) e `npm run seed:demo` (organização vazia).

## 2. O que ainda falta

### Prioridade alta (antes de colocar clientes reais)
1. ⬜ **Ver tudo em navegador e em celular de verdade.** Nenhuma tela foi aberta em navegador nesta sessão (só build, lint e renderização no servidor). Esperar ajustes visuais.
2. 🟡 **Testes de interface**: Playwright cobre os fluxos principais; faltam contratos (criar/ativar/emitir documento), recebimento e estorno, manutenção, vistorias e **acessibilidade automatizada** (axe), além de testar contra a API real da Anthropic.
3. ⬜ **Testar o e-mail de recuperação de senha e o link do admin** contra o Supabase real; cadastrar `APP_URL` nas *Redirect URLs*; configurar **SMTP próprio** (o padrão do Supabase tem limite baixo).
4. ⬜ **Trocar os segredos expostos na conversa** (senha do banco, `SUPABASE_SECRET_KEY`, senha temporária do admin).
5. 🟡 **Deploy na Vercel preparado** (`docs/DEPLOY-VERCEL.md`): falta criar o projeto, definir variáveis, domínio, SMTP e backup do banco; CI (testes a cada push) ainda não existe.
6. ⬜ **Identidade visual oficial** (logotipo e paleta): hoje são tokens provisórios.
7. ⬜ **Segurança de produção**: cabeçalhos (CSP/HSTS), CSRF dedicado, limite de requisições compartilhado entre instâncias, logs estruturados, revisão de segurança externa.

### Produto (módulos previstos na documentação)
8. ⬜ **Contratos**: renovação, aditivos, reajustes, rescisão detalhada (multa), anexos, assinatura eletrônica qualificada.
9. ⬜ **Financeiro**: multa e juros automáticos, pro rata do primeiro mês, descontos, boleto/Pix e conciliação bancária, despesas de manutenção e abatimento no repasse, informe de rendimentos, valor por extenso no recibo.
10. ⬜ **Relatórios** (receita por período, inadimplência, vacância, desempenho da carteira) com exportação (CSV/PDF) e gráficos no painel.
11. ⬜ **Documentos gerais** (upload de documentos de pessoas e imóveis com controle de acesso).
12. ⬜ **Cadastros mais ricos**: dados bancários, estado civil, profissão, endereço, vários contatos; validação e deduplicação de CPF/CNPJ; características do imóvel e fotos das unidades.
13. ⬜ **Notificações externas**: e-mail, WhatsApp, push (exigem provedor de envio e consentimento/LGPD); envio dos convites por e-mail.
14. ⬜ **PWA** (instalável, cache, push).
15. ⬜ **Permissões granulares** por módulo (hoje são 4 papéis fixos) e **auditoria** das ações críticas.
16. ⬜ **SaaS**: superadministrador da plataforma, planos/assinaturas e cobrança, limites, onboarding, identidade por organização. **Modelo comercial ainda não definido.**
17. ⬜ **Conta do usuário**: trocar senha dentro do app, perfil, MFA, verificação de e-mail, sessões ativas.
18. ⬜ **Listagens grandes**: paginação, busca e ordenação no servidor, exportação. Importação aceita só CSV (não .xlsx) e não cobre contratos nem cobranças.
19. ⬜ **LGPD**: exportar e excluir dados do titular, política de retenção, termos de uso e privacidade (a home ainda não tem).
20. ⬜ **Fotos em armazenamento de objetos** (hoje no PostgreSQL) quando o volume crescer.
21. ⬜ **Páginas públicas adicionais**: preços, contato, institucional; SEO (sitemap, pré-renderização).

### Decisões que dependem de você
- Modelo comercial (planos, preços, quem pode se cadastrar sozinho).
- Provedor de e-mail/WhatsApp e regras de consentimento.
- Manter a **autenticação própria sobre o Supabase Auth** ou migrar a sessão para tokens do Supabase.
- Texto jurídico oficial dos contratos (o modelo de exemplo **não tem validade jurídica**).
