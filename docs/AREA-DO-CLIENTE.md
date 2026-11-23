# Área do cliente e API — desenho e estado

> Estado real do código está no `CLAUDE.md`. Este documento descreve o **desenho** da área do cliente e da API pública e separa o que **existe** do que é **proposta**.

## Princípios
- O cliente (inquilino ou proprietário) acessa por **convite** do administrador, que o **vincula a um cadastro** (`organization_members.tenant_id` / `owner_id`). É só por esse vínculo que ele enxerga dados — nenhum identificador de pessoa é aceito do navegador.
- Cada consulta do portal filtra por organização **e** pelo vínculo (`src/portal.ts`). Dado pessoal de terceiros não sai: o proprietário não recebe CPF/e-mail do inquilino.
- Acesso sem vínculo recebe orientação (409), nunca dados.

## O que existe hoje (implementado)

| Perfil | Funcionalidade | Onde |
|---|---|---|
| Inquilino | Valor em aberto, próximo vencimento, atrasos | `PortalPage` (cartões) |
| Inquilino | Cobranças (situação derivada) e histórico | `GET /api/portal/tenant/charges` |
| Inquilino | Pagamentos e **recibos** (ver/imprimir/PDF pelo navegador) | `…/tenant/payments[/:id]` |
| Inquilino | Dados do contrato e **documentos emitidos** | `…/tenant/leases`, `…/tenant/documents[/:id]` |
| Proprietário | Imóveis e unidades (ocupação, locatário, aluguel, fim do contrato) | `…/owner/properties`, `…/owner/units` |
| Proprietário | Repasses (recebido, taxa, líquido, pago/pendente) | `…/owner/transfers` |
| Inquilino | **Solicitar manutenção** (fotos, comentários, acompanhamento, cancelar enquanto aberta) | `…/tenant/maintenance` |
| Inquilino / Proprietário | **Vistorias concluídas**: checklist com fotos, laudo e registro de ciência | `…/inspections` |
| Proprietário | Chamados de manutenção dos imóveis (custo só após concluir) | `…/owner/maintenance` |
| Administrador | Convidar cliente já vinculado; ver a quem cada acesso pertence | página **Equipe** |
| Integrador | Chaves de API **somente leitura** + documentação OpenAPI com exemplos | página **API**, `/api/openapi.json` |

## Página pública (implementada)
- A raiz do site, sem login, é uma **home** com proposta de valor, funcionalidades, como funciona, públicos, segurança, FAQ e botões de ação (`Começar agora` → cadastro, `Entrar`). Rotas por hash: `#/entrar`, `#/cadastro`, `#/api` (documentação da API também pública). Texto só promete o que existe; o que está no roteiro (boleto/Pix, comunicados, PWA) aparece como tal.

## Proposta (NÃO implementado)
1. **Comunicados** da administradora e preferências de notificação (e-mail/WhatsApp/push) — depende do módulo de comunicados e de consentimento (LGPD).
2. **Segunda via de boleto / Pix copia-e-cola** — depende de integração bancária; hoje o sistema só registra o que foi recebido.
3. **Extrato do proprietário em PDF** e relatório anual (informe de rendimentos).
4. **PWA**: instalação, ícones, cache e push. Avaliar com cuidado o que ficar offline (dados pessoais e financeiros).
5. **Webhooks e escopos por chave** para a API (hoje a chave lê tudo da organização, somente leitura).
6. **Paginação e filtros** nas listagens (hoje devolvem a lista completa).

## API para terceiros
- Contrato em OpenAPI 3 em `GET /api/openapi.json` (público), gerado de `src/apiSpec.ts`. Um teste garante que **todo endpoint documentado existe** e que o aviso “aceita chave de API” é verdadeiro.
- Autenticação: `Authorization: Bearer ethos_…` (chave criada por um admin, mostrada **uma única vez**, guardada só como hash, revogável, 600 req/min por chave). Chaves **não escrevem**, **não administram** chaves/equipe e **não** acessam a área do cliente.
- Valores monetários em **centavos**; datas `AAAA-MM-DD`; erros `{ "error": "mensagem" }`.
- Os exemplos de resposta na documentação são **dados fictícios** (mocks) do mesmo universo da demonstração.

## Demonstração
- `npm run build && npm run demo` → http://localhost:3100, app completo **em memória** (não toca no Supabase), com logins prontos (administrador, inquilino, proprietário) e dados fictícios.
- `npm run seed:demo -- <e-mail-do-admin>` popula uma organização **vazia** do banco real com os mesmos dados (recusa organização que já tenha imóveis).
