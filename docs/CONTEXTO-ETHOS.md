# Ethos Administradora de Imóveis — Contexto mestre

> Copiado do documento do Projeto "Ethos" no Claude. Descreve visão e requisitos; **não** indica o que já está implementado (ver `CLAUDE.md` para o estado real do código).

## 1. Visão geral
- **Nome:** Ethos Administradora de Imóveis (comercial: Ethos). **Local inicial:** São Paulo, Brasil.
- **Produto:** plataforma SaaS de administração de imóveis, com evolução planejada para PWA.
- Duas dimensões: (1) Ethos como negócio (imóveis, proprietários, inquilinos, contratos, pagamentos, vistorias, manutenção); (2) Ethos como software que digitaliza e automatiza esses processos.
- Atende primeiro a própria administradora; a arquitetura deve permitir uso por outros proprietários e administradoras.

## 2. Missão, visão e valores
- **Missão:** simplificar e profissionalizar a administração imobiliária com tecnologia, transparência, organização e processos eficientes.
- **Visão:** referência em administração imobiliária digital, com plataforma moderna, confiável e acessível a proprietários, administradores e inquilinos.
- **Valores:** transparência, segurança das informações, eficiência operacional, organização e rastreabilidade, inovação, experiência do usuário, profissionalismo, confiabilidade.

## 3. Identidade da marca
- Transmitir sofisticação, confiança, estabilidade, exclusividade e modernidade. Personalidade: sofisticada, minimalista, moderna, profissional, confiável, elegante, tecnológica.
- Linguagem premium: tipografia refinada, composição equilibrada, espaçamento consistente, interfaces limpas, hierarquia clara. Temas claro e escuro nativos.
- **Já existe identidade visual e logotipo.** Não substituir a marca nem inventar paleta definitiva. Usar arquivos oficiais de branding quando estiverem no repositório; antes disso, tokens provisórios claramente identificados.

## 4. Objetivo do software
Centralizar e automatizar a administração de imóveis residenciais: proprietários, inquilinos, imóveis/unidades, contratos (com modelos e renovação), aluguéis e pagamentos, inadimplência, recibos, caução/garantias, vistorias com fotos, ocorrências e manutenções, comunicados, documentos, dashboards e relatórios, usuários e permissões, automações. Simples para pequenos proprietários, robusto para administradoras com muitos imóveis.

## 5. Modelo de negócio
- Uso inicial na própria Ethos; depois SaaS para terceiros (assinaturas mensais/anuais, planos por unidades administradas, recursos avançados por plano, limites de armazenamento, integrações opcionais, premium). **Modelo comercial ainda não definido.**
- Arquitetura preparada para múltiplos clientes empresariais, com isolamento de dados por organização.

## 6. Perfis de usuário
- **Superadministrador da plataforma:** organizações, planos, configurações globais, permissões administrativas, indicadores operacionais.
- **Administrador da organização:** imóveis, contratos, pagamentos, inquilinos, documentos, vistorias, usuários autorizados.
- **Colaborador:** permissões específicas (atendimento, financeiro, contratos, manutenção, vistorias).
- **Proprietário:** consulta imóveis, contratos, pagamentos, repasses, documentos e relatórios disponibilizados.
- **Inquilino:** consulta locação, contratos, cobranças, comprovantes, comunicados; solicita manutenção.
- Um usuário pode ter vínculos e permissões distintos em organizações diferentes.

## 7. Autenticação e autorização
- Escopo: cadastro, login/logout, recuperação e redefinição de senha, verificação de e-mail, gerenciamento e revogação de sessões, proteção contra tentativas abusivas, MFA (evolução), convites, vínculo usuário–organização, RBAC (papéis e permissões).
- Segurança: sem senha em texto puro; mecanismos seguros; autorização no backend (nunca confiar só no frontend); menor privilégio; isolamento entre organizações; registro de eventos administrativos; LGPD.

## 8. Módulos
**8.1 Dashboard:** total de imóveis e unidades, ocupadas/disponíveis, contratos ativos e a vencer, receita prevista/recebida, valores em atraso, taxa de inadimplência, solicitações de manutenção, vistorias pendentes — sempre respeitando o escopo de acesso.

**8.2 Proprietários:** nome/razão social, CPF/CNPJ, contatos, endereço, dados bancários quando necessários, imóveis, documentos, histórico. Um proprietário tem vários imóveis; um imóvel pode ter mais de um proprietário.

**8.3 Imóveis e unidades:** separar *imóvel* de *unidade locável* (ex.: terreno com dez casas independentes, cada uma com contrato e inquilino).
- Imóvel: identificação, endereço, proprietários, tipo, características, documentos, áreas comuns.
- Unidade: identificação interna, número, área, cômodos, valor de referência do aluguel, situação de ocupação, fotos, características, histórico de locações. Estados controlados de forma consistente.

**8.4 Inquilinos:** nome, CPF, RG/documento, nacionalidade, estado civil, profissão, contatos, endereço, documentos, contratos, histórico de pagamentos, ocorrências. Múltiplos locatários/responsáveis por contrato; evitar cadastros duplicados.

**8.5 Contratos (prioritário):** modelos com variáveis dinâmicas, pré-visualização, PDF, histórico de versões, renovação, aditivos, reajustes, rescisão, anexos, vigência, registro de assinatura.
- Variáveis: `{{locador.nome}}`, `{{locador.documento}}`, `{{locatario.nome}}`, `{{locatario.cpf}}`, `{{imovel.endereco}}`, `{{unidade.identificacao}}`, `{{contrato.valor_aluguel}}`, `{{contrato.data_inicio}}`, `{{contrato.data_fim}}`, `{{contrato.dia_vencimento}}`, `{{contrato.garantia}}`.
- Validar variáveis antes de gerar. O documento gerado preserva a versão do modelo e os dados daquele momento; alterações posteriores no cadastro **não** alteram contratos emitidos.
- Usar modelos jurídicos aprovados pela administração; o sistema não presume validade jurídica de cláusulas geradas.

**8.6 Financeiro:** cobranças, aluguéis mensais, vencimentos, pagamentos parciais/integrais, multas e juros contratuais, descontos, inadimplência, recibos, histórico, repasses a proprietários, despesas de manutenção, relatórios. **Separar cobrança, pagamento, baixa e repasse.** Boleto/Pix gerado ou solicitado não significa cobrança paga. Integrações bancárias no futuro.

**8.7 Vistorias:** entrada, saída e periódicas; checklist por ambiente, estado de conservação, fotos (vinculadas à vistoria e ao ambiente), observações, data, responsável, assinaturas, laudo, comparação entre vistorias, histórico.

**8.8 Manutenção:** abertura, categoria, descrição, fotos, prioridade, responsável, orçamentos, aprovação, execução, conclusão, custos, histórico; acompanhamento da abertura ao encerramento.

**8.9 Comunicados e notificações:** vencimento próximo, pagamento identificado, atraso, contrato a encerrar, renovação pendente, vistoria agendada, manutenção atualizada, comunicados gerais. Canais futuros: e-mail, WhatsApp, internas, push no PWA. Considerar consentimento, preferências e requisitos legais.

**8.10 Documentos:** contratos, aditivos, laudos, recibos, cadastrais, comprovantes, anexos, versões, controle de acesso. Documentos privados nunca públicos.

**8.11 Relatórios:** receita por período, inadimplência, ocupação, vacância, contratos a vencer, despesas por imóvel, histórico de pagamentos, desempenho da carteira, repasses; com exportação quando necessário.

**8.12 Configurações:** organização, identidade visual, usuários, permissões, modelos documentais, parâmetros financeiros, notificações, integrações, segurança, auditoria.

## 9. Arquitetura técnica (segundo o planejamento)
- Repositório de desenvolvimento citado: `ethos-administracao`, com backend em `apps/api`; Node.js; variáveis em `.env`; Supabase + PostgreSQL em desenvolvimento; ambiente local Windows/PowerShell.
- **Stack completa (frontend, framework HTTP, ORM, migrações, auth, hospedagem) deve ser confirmada nos arquivos do repositório.** Não presumir tecnologia só por constar do planejamento.
- Antes de alterar código, inspecionar: `package.json`, estrutura de diretórios, configs, dependências, schemas, migrações, serviços, rotas, testes, scripts, documentação. Respeitar decisões já consolidadas no código.

## 10. Multitenancy
Isolamento de dados por organização; usuários vinculados a organizações; permissões por organização; consultas filtradas pelo contexto autorizado; controle de acesso a documentos; auditoria de ações sensíveis; prevenção de acesso cruzado. Se houver RLS, revisar e testar políticas. Nunca confiar só no identificador de organização enviado pelo cliente.

## 11. Modelagem de dados (proposta, não necessariamente existente)
Organizations, Users, OrganizationMembers, Roles, Permissions, Owners, Properties, Units, Tenants, Leases, LeaseParties, ContractTemplates, ContractVersions, ContractDocuments, Charges, Payments, PaymentAllocations, OwnerTransfers, Inspections, InspectionItems, InspectionPhotos, MaintenanceRequests, MaintenanceUpdates, Documents, Notifications, AuditLogs, OrganizationSettings.
Verificar schema e migrações reais antes de criar tabelas; evitar duplicação; manter integridade referencial; usar transações em operações multi-registro.

## 12. Experiência do usuário
Responsivo (desktop, tablet, smartphone), tema claro/escuro, componentes reutilizáveis, navegação consistente, formulários organizados, validação clara, loading, estados vazios, erros compreensíveis, confirmação em operações destrutivas, acessibilidade, boa performance. Tarefas frequentes em poucos passos: cadastrar inquilino, vincular unidade, gerar contrato, registrar pagamento, emitir recibo, abrir manutenção.

## 13. PWA (futuro)
Instalação, interface mobile, ícones, manifest, service worker, estratégias de cache, push, boa experiência em conexões instáveis. Avaliar com cuidado o armazenamento offline de dados pessoais e documentos sensíveis.

## 14. Segurança e privacidade
HTTPS em produção, autenticação segura, autorização por recurso, isolamento entre organizações, validação de entrada, proteção contra SQL Injection/XSS/CSRF, gestão de segredos, logs sem credenciais, controle de acesso a arquivos, auditoria, backup e recuperação, política de retenção, LGPD. Nunca expor chaves administrativas do Supabase no frontend; nunca incluir senhas, tokens ou segredos em commits, logs ou respostas.

## 15. Qualidade de software
Código limpo, responsabilidades bem definidas, modularidade, baixo acoplamento, alta coesão, reutilização, validação, tratamento de erros, tipagem consistente, testabilidade, segurança por padrão.
Testes: unitários (regras de negócio), integração (banco/serviços), API, autorização, isolamento entre organizações, E2E de fluxos críticos, regressão.
Fluxos prioritários: 1) autenticação, 2) cadastro de imóveis, 3) cadastro de inquilinos, 4) criação de contratos, 5) geração de documentos, 6) registro de pagamentos, 7) controle de permissões.
