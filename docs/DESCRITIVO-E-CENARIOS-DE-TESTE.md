# Ethos Administradora de Imóveis: descritivo do produto e cenários de teste

Documento autocontido, feito para ser usado em outro assistente ou por um testador. Descreve o que **existe no código** (novembro de 2026). O que não existe está na seção 6.

## 0. Como usar este documento em outro chat

Cole este pedido junto com o arquivo:

> Você é um QA sênior. Use o documento anexo como a única fonte sobre o produto. Não invente funcionalidades; se faltar informação, pergunte. A partir dele: (1) detalhe os cenários em casos de teste com pré-condições, passos, dados e resultado esperado; (2) aponte lacunas e riscos; (3) priorize por risco (P0, P1, P2). Em cada teste executado, registre: ID, resultado (passou, falhou, bloqueado), evidência e, se falhou, passos para reproduzir.

Regras para quem testar:
- Use somente dados fictícios.
- Prefira o **modo demonstração** (`npm run demo`): roda em memória, não toca no banco real e mostra no terminal os logins prontos de equipe e de clientes. Tudo é descartado ao encerrar.
- Em produção, não faça teste de carga, de força bruta nem ações destrutivas. Não use CPF, cartão ou chave real.
- E-mail, WhatsApp, push, login social e Asaas só funcionam depois de configurados (seção 5). Sem isso, marque o teste como **bloqueado**, não como falha.

---

## 1. Visão geral

SaaS web (instalável como PWA) para administradoras de imóveis residenciais. Cada administradora é uma **organização** isolada: ninguém vê dados de outra.

Fluxo principal: cadastrar proprietários, imóveis, unidades e inquilinos → criar o contrato de locação → gerar cobranças → emitir boletos → registrar recebimentos (com recibo) → repassar aos proprietários. Em paralelo há manutenção, vistorias, portaria, comunicados, relatórios e área do cliente.

**Tecnologia:** React 19 + Vite (front), Node + Express 5 + TypeScript (back), PostgreSQL e autenticação no Supabase, hospedagem na Vercel. Valores são guardados em centavos. "Hoje" segue o fuso de Brasília. Interface em português, com tema claro, escuro ou do sistema. No celular o menu vira gaveta e os modais ocupam a tela inteira.

**Padrão de tela:** a lista fica sempre visível; criar, ver, editar e confirmar abrem em **modal**. Exclusões pedem confirmação.

**Área pública:** página inicial, login, cadastro de nova administradora, documentação da API, vitrine de unidades disponíveis (por link), página de assinatura de documento e aceite de convite.

---

## 2. Perfis de acesso

| Perfil | O que faz |
|---|---|
| **Administrador** | Tudo, incluindo equipe, registros de atividade, integrações, chaves de API, exclusões, estornos, cancelamento de cobrança e boleto, pagamento de repasse e aprovação de orçamento. |
| **Colaborador** | Operação do dia a dia (cadastros, contratos, financeiro, manutenção, vistorias, portaria). Não faz as ações exclusivas do administrador. |
| **Inquilino** | Área do cliente: só o que está ligado ao cadastro dele (contrato, cobranças, boletos, manutenção, vistorias concluídas, moradores, visitantes, comunicados e avisos). |
| **Proprietário** | Área do cliente: só os imóveis dele (leitura), repasses, informe de rendimentos, vistorias concluídas e comunicados. Não vê documento nem e-mail do inquilino, nem moradores e visitantes. |
| **Chave de API** | Integração **somente leitura**, na organização que a criou. Sem acesso a rotas de administrador, área do cliente e leituras sensíveis (crédito, extrato bancário, DIMOB, arquivos). |

Um mesmo usuário pode participar de várias organizações e alternar entre elas. A organização nunca é escolhida pelo navegador em uma requisição: vem da sessão.

---

## 3. Módulos e regras de negócio

### 3.1 Conta, acesso e segurança
- Cadastro público cria uma organização nova; quem cadastra vira administrador.
- Login com limite de 10 tentativas em 15 minutos por IP e e-mail. Sessão de 7 dias.
- Recuperação de senha por e-mail; a resposta não revela se o e-mail existe. Redefinir a senha derruba as sessões.
- Política de senha: mínimo de 8 caracteres, recusa senhas comuns, iguais ao e-mail ou vazadas (consulta HIBP; se o serviço cair, não bloqueia).
- **Meu perfil** (clicar no usuário no rodapé do menu): nome, telefone, CPF/CNPJ, nascimento, foto (até 1 MB), troca de e-mail e de senha (pedem a senha atual).
- Troca de e-mail: o link vai para o endereço **novo**; até confirmar aparece "aguardando". Dá para cancelar o pedido pendente.
- Verificação em duas etapas (aplicativo autenticador): 10 códigos de recuperação mostrados **uma vez**; desafio de login vale 5 minutos e é queimado após 5 erros; código já usado não vale de novo. Exige `INTEGRATIONS_SECRET` no servidor.
- Passkeys (biometria ou chave de segurança): até 10 por usuário; entrar com passkey dispensa o código do 2FA.
- Login com Google ou Microsoft (se configurado): só entra quem já tem conta; respeita o 2FA.
- Lista de aparelhos conectados, com encerramento individual ou de todos os outros.
- Alerta de aparelho novo e de troca de senha ou e-mail.
- Bloqueio opcional de login por país.
- Expiração por inatividade por organização: 15 a 1440 minutos (em Equipe).
- LGPD: exportar os próprios dados e excluir a conta (pede senha, a palavra EXCLUIR e o 2FA, se houver). O único administrador não pode se excluir. A exclusão anonimiza o usuário e preserva registros da organização.
- Proteção contra requisição de outro site (CSRF) nas escritas.

### 3.2 Equipe e convites
- Convite por e-mail e papel. Inquilino e proprietário precisam ser ligados a um cadastro.
- Pode **enviar por e-mail** (marcado por padrão) e sempre mostra o **link para copiar**.
- O link abre o cadastro do convidado com o **e-mail preenchido e travado**, mostrando quem convidou, a organização e o papel. Conta nova pede nome, senha e repetição. Quem já tem conta confirma a senha atual.
- Validade de 7 dias, uso único. Convidar de novo o mesmo e-mail invalida o convite anterior.
- Pendentes: "Reenviar e-mail", "Novo link" (os dois invalidam o link anterior e renovam a validade) e "Revogar".
- Limite de 30 envios de convite por e-mail por hora, por organização.
- Administrador muda papel e remove membros (sessões encerradas). A organização nunca fica sem administrador.
- Administrador redefine senha (por e-mail, link ou definindo na hora) e o 2FA de um membro. Link, senha direta e reset de 2FA só valem para quem pertence **apenas** àquela organização.

### 3.3 Cadastros
- Proprietários, inquilinos, imóveis e unidades. **Imóvel é diferente de unidade** (a unidade é o que se aluga). Um imóvel pode ter vários proprietários.
- CEP preenche o endereço automaticamente. Máscaras de telefone, CPF/CNPJ, CEP e moeda.
- Quem tem contrato não pode ser apagado (unidade, imóvel, inquilino).
- **Importar dados:** CSV, Excel .xlsx ou colar da planilha; proprietários, inquilinos, imóveis, unidades, contratos, cobranças e vistorias. Até 2000 linhas. **Tudo ou nada**, com simulação e erros por linha. Duplicados são ignorados. Arquivo .xls antigo não é aceito.
- **Ler documentos (IA):** foto ou PDF de até 4 MB gera **sugestões** de pessoas, imóvel e contrato; nada é gravado antes da revisão; pede consentimento; o arquivo não é guardado; contrato entra como rascunho. Precisa de um provedor de IA configurado. Limite de 30 por hora.

### 3.4 Contratos
- Modelos com variáveis `{{...}}` de uma lista fixa; variável desconhecida é recusada.
- Status: rascunho → vigente → encerrado ou rescindido. Só rascunho pode ser editado ou excluído.
- Para ativar: pelo menos um locatário e **sem outro contrato vigente sobreposto** na mesma unidade. Ativar e encerrar mudam a situação da unidade.
- Documento emitido é **imutável**. Falta de dado para uma variável impede a emissão. PDF é feito pela impressão do navegador.
- **Aditivos:** renovação, reajuste (percentual ou novo valor) e outros; data futura fica agendada. Índices IGP-M e IPCA vêm do Banco Central, com digitação manual se falhar.
- **Rescisão guiada:** multa proporcional = multa × dias restantes ÷ dias do contrato; pode isentar e cancelar aluguéis futuros não pagos.
- **Garantias:** fiador, caução, seguro-fiança, título de capitalização e outra; aviso 30 dias antes de vencer.
- **Assinatura eletrônica simples:** link pessoal, nome digitado, hash do texto e IP. **Não é ICP-Brasil.**

### 3.5 Financeiro
Quatro conceitos separados: **cobrança** (o que se deve), **pagamento** (dinheiro recebido, com recibo numerado), **baixa** (quanto cada pagamento quita) e **repasse** (ao proprietário).
- Status da cobrança é calculado: aberta, parcial, vencida, paga ou cancelada.
- Geração mensal de aluguel não duplica. Vencimento em dia inexistente vai para o último dia do mês. Pro rata opcional no primeiro e no último mês.
- A soma das baixas tem de ser igual ao pagamento e não pode passar do saldo da cobrança.
- Estorno apenas marca o pagamento (com motivo); só administrador.
- **Multa e juros** automáticos (configuráveis) viram cobranças separadas, depois da carência; a original não muda. Multa única; juros a cada bloco de 30 dias.
- **Repasse:** aluguéis **recebidos** no mês, em partes iguais entre os proprietários, menos a taxa de administração. Regerar atualiza os pendentes e não toca nos pagos.
- **Conciliação:** importa extrato OFX ou CSV (até 3 MB), não duplica lançamentos, sugere a cobrança e concilia com recibo. CNAB não é lido.
- **Rateio:** divide uma despesa por partes iguais ou por área entre unidades com contrato vigente; só cancela se nada foi pago.
- Manutenção cobrada do proprietário é descontada do repasse se couber no valor líquido.
- **Relatórios:** inadimplência, DRE por imóvel, fluxo de caixa (regime de caixa), informe do proprietário e DIMOB (planilha de apoio, **não** é o arquivo oficial), com exportação CSV.

### 3.6 Boletos
**Manuais (sem integração):**
- São guias de cobrança do Ethos; **sem linha digitável ou link de banco, não são boleto bancário**.
- Emissão individual, do mês ou **carnê do contrato** (até 36 meses; só contrato vigente; cria os aluguéis que faltam; repetir não duplica).
- Só um boleto em aberto por cobrança. Valor de 1 centavo até o saldo.
- Baixa individual ou **em lote** (por mês ou contrato), **escolhendo com caixas de seleção** quais baixar, até 100 por vez. Data: o vencimento de cada um ou uma data única (nunca futura). "Registrar o recebimento" emite recibo e quita a cobrança; sem isso, só o boleto fica pago.
- Editáveis enquanto em aberto. Cancelamento só por administrador.

**Asaas (precisa conectar):** individual ou em lote; valor = saldo; vencimento passado vira hoje; inquilino precisa de CPF/CNPJ; situação atualizada pelo botão "Atualizar situações". Pagamento no Asaas **não quita a cobrança sozinho**. Não há Pix.

**Segunda via:** reenvio ao inquilino, com limite de 5 por hora.

### 3.7 Manutenção, prestadores e preventiva
- Status: aberta → em análise → aguardando aprovação → aprovada → em execução → concluída; cancelar exige motivo.
- Enviar para aprovação exige orçamento. **Só administrador** aprova ou recusa; aprovar um recusa os demais.
- Notas da equipe são internas por padrão; cliente nunca vê orçamentos; custo só aparece após concluir. Chamado encerrado é somente leitura.
- Inquilino abre chamado só de contrato vigente (máximo de 10 por hora, sem prioridade urgente), comenta, anexa foto e cancela enquanto "aberta".
- Fotos: JPEG, PNG ou WebP, até 3 MB, 10 por chamado.
- Prestadores com nota de 1 a 5 e comparativo de orçamentos.
- Preventiva: repete a cada 1 a 60 meses e abre o chamado com antecedência.

### 3.8 Vistorias
- Entrada, saída ou periódica, com checklist por ambiente (novo, bom, regular, ruim, danificado).
- Só conclui com todos os itens avaliados; depois fica imutável.
- Ciência por papel (vistoriador, locatário, proprietário): nome digitado e data, **não** é assinatura qualificada.
- Laudo em texto e comparação entrada × saída (concluídas da mesma unidade). Até 5 fotos por item. Cliente só vê concluídas.

### 3.9 Moradores, visitantes, portaria e encomendas
- Moradores por contrato (até 30 ativos); locatários aparecem como titulares; saída é registrada e depois não se edita.
- Visitante com validade de uma data ou período de até 365 dias, sem começar no passado, com código de 6 caracteres. Criado pela equipe ou pelo inquilino (30 por hora; até 100 ativas por unidade).
- Visita recorrente (dias da semana, horário, permanência máxima), renovação, foto com consentimento (apagada 30 dias após o fim).
- Portaria (só equipe): entrada e saída. Recusa bloqueado, cancelado, fora da validade, entrada dupla e saída sem entrada. Não cancela nem bloqueia quem está dentro. Entrada avisa o inquilino.
- Encomendas: aviso, retirada, devolução e lembrete após 3 dias.
- Relatório de acessos com CSV. Proprietário vê apenas números.
- É registro conferido por pessoas; **não** controla catraca ou fechadura.

### 3.10 Ocorrências, enquetes e comunicados
- Ocorrência: registrada → notificada → multada ou arquivada. O morador contesta **uma vez**. A multa vira cobrança.
- Enquete: 2 a 10 opções, um voto por pessoa, resultado só após votar ou encerrar; anônima esconde quem votou até da equipe.
- Comunicado: público (todos, inquilinos, proprietários ou um imóvel); rascunho → publicado (não volta) → arquivado.

### 3.11 Captação e documentos dos imóveis
- Vitrine pública por link, só unidades disponíveis e sem endereço completo; formulário com proteção contra robô e limite por IP.
- Funil de interessados e agenda de visitas (sem conflito dentro de 30 minutos; lembrete 24 h antes).
- Análise de crédito **manual**, com consentimento obrigatório; referência: renda de pelo menos 3 vezes o aluguel. Sem consulta a Serasa ou SPC.
- Documentos do imóvel (PDF, JPEG, PNG até 5 MB) com alerta de vencimento.

### 3.12 Avisos
Sino no sistema (canal principal) e, se configurados, e-mail, WhatsApp (exige consentimento e modelo aprovado) e push. Preferência por categoria e canal. Lembretes de vencimento (até 3 dias), atraso, contratos terminando (60 dias) e outros. Na Vercel o agendador roda **uma vez por dia**, então avisos que dependem de horário podem atrasar.

### 3.13 Administração
- **Painel** com indicadores.
- **Registros:** trilha de auditoria das escritas e negações, com filtros e CSV; ninguém edita nem apaga. Só administrador.
- **Integrações:** Asaas (sandbox ou produção), provedores de IA, até 10 webhooks (somente HTTPS público, assinatura HMAC) e chaves de API (até 20, valor mostrado uma vez, 600 requisições por minuto). Segredos cifrados que não voltam ao navegador.
- Documentação da API pública (OpenAPI).
- PWA instalável; sem conexão, o portal do cliente permite leitura do que já foi carregado. Monitoramento interno de erros.

---

## 4. Cenários de teste

Prioridade: **P0** crítico (dinheiro, acesso, vazamento), **P1** importante, **P2** complementar.

### 4.1 Autenticação e conta
| ID | P | Cenário | Esperado |
|---|---|---|---|
| AUT-01 | P0 | Cadastrar nova administradora | Entra no painel como administrador, organização vazia |
| AUT-02 | P0 | Login certo e errado | Certo entra; errado dá mensagem genérica |
| AUT-03 | P1 | 11 logins errados seguidos | Bloqueio temporário |
| AUT-04 | P1 | Recuperar senha com e-mail existente e inexistente | Mesma resposta para os dois |
| AUT-05 | P1 | Senha curta, comum ou igual ao e-mail | Recusada |
| AUT-06 | P0 | Ativar 2FA e entrar | Pede código; sem ele não há sessão |
| AUT-07 | P0 | Usar o mesmo código de recuperação duas vezes | Segunda vez recusada |
| AUT-08 | P1 | Errar o código 2FA 5 vezes | Desafio invalidado; recomeça o login |
| AUT-09 | P1 | Trocar senha com outro aparelho conectado | O outro cai; o atual continua |
| AUT-10 | P1 | Trocar e-mail e não confirmar; cancelar | Login segue com o antigo |
| AUT-11 | P1 | Confirmar a troca de e-mail pelo link | Login passa a ser o novo |
| AUT-12 | P2 | Cadastrar passkey, entrar com ela e remover | Funciona; removida não entra |
| AUT-13 | P1 | Excluir conta sendo o único administrador | Recusado |
| AUT-14 | P1 | Exportar meus dados | Arquivo sem senhas nem segredos |
| AUT-15 | P2 | Configurar inatividade e ficar parado | Pede login novamente |

### 4.2 Convites e equipe
| ID | P | Cenário | Esperado |
|---|---|---|---|
| CON-01 | P0 | Convidar colaborador e abrir o link em janela anônima | E-mail preenchido e travado; mostra quem convidou, organização e papel |
| CON-02 | P0 | Concluir o cadastro pelo convite | Entra com o papel certo |
| CON-03 | P1 | Senhas diferentes nos dois campos | Aviso e nada é criado |
| CON-04 | P0 | Reusar link aceito | "Convite inválido" |
| CON-05 | P0 | "Novo link" ou "Reenviar" e abrir o antigo | Antigo inválido; novo funciona |
| CON-06 | P1 | Revogar e abrir o link | Inválido |
| CON-07 | P1 | Convidar sem marcar o envio | Mostra só o link; nenhum e-mail |
| CON-08 | P1 | Envio marcado sem provedor de e-mail | Convite criado, aviso de que o e-mail não saiu, link funciona |
| CON-09 | P1 | Convidar inquilino sem escolher o cadastro | Recusado |
| CON-10 | P1 | Convidar quem já é membro | Recusado |
| CON-11 | P1 | Convidar quem já tem conta em outra organização | Pede a senha atual; passa a alternar organizações |
| CON-12 | P0 | Remover ou rebaixar o único administrador | Recusado |
| CON-13 | P0 | Colaborador tenta convidar ou ver convites | Acesso negado |

### 4.3 Cadastros, importação e leitura de documentos
| ID | P | Cenário | Esperado |
|---|---|---|---|
| CAD-01 | P1 | Criar, ver, editar e excluir cada cadastro | Tudo em modal; exclusão pede confirmação |
| CAD-02 | P2 | CEP válido, inexistente e serviço fora | Preenche; avisa; permite digitar |
| CAD-03 | P1 | Excluir unidade ou inquilino com contrato | Recusado com explicação |
| CAD-04 | P0 | Importar com uma linha inválida | Nada é gravado; erro indica a linha |
| CAD-05 | P1 | Simular e depois importar duas vezes | Simulação não grava; repetição não duplica |
| CAD-06 | P1 | Importar contrato vigente sobreposto | Recusado |
| CAD-07 | P2 | CSV com acentos, `;` e datas dd/mm/aaaa | Lido corretamente |
| CAD-08 | P2 | Documento com texto que tenta dar ordens à IA | Tratado como dado; nada gravado sem revisão |

### 4.4 Contratos
| ID | P | Cenário | Esperado |
|---|---|---|---|
| CTR-01 | P0 | Ativar sem locatário | Recusado |
| CTR-02 | P0 | Ativar dois contratos sobrepostos na mesma unidade | Segundo recusado |
| CTR-03 | P1 | Editar contrato vigente | Bloqueado |
| CTR-04 | P1 | Emitir documento, mudar o modelo e reabrir | Documento emitido não muda |
| CTR-05 | P1 | Emitir com dado faltando | Recusado, indicando o que falta |
| CTR-06 | P1 | Reajuste por percentual com data futura | Fica agendado; aluguel atual não muda antes |
| CTR-07 | P0 | Rescisão no meio do contrato | Multa proporcional conforme a fórmula; isenção funciona |
| CTR-08 | P1 | Assinar pelo link; usar o link de novo | Registra nome, data e hash; não assina duas vezes |

### 4.5 Financeiro
| ID | P | Cenário | Esperado |
|---|---|---|---|
| FIN-01 | P0 | Gerar aluguéis do mês duas vezes | Sem duplicar |
| FIN-02 | P1 | Vencimento dia 31 em fevereiro | Último dia do mês |
| FIN-03 | P0 | Pagamento parcial e depois o restante | parcial → paga; recibos numerados |
| FIN-04 | P0 | Baixa maior que o saldo ou soma diferente do pagamento | Recusada |
| FIN-05 | P0 | Estornar como administrador e como colaborador | Administrador estorna e a cobrança reabre; colaborador não |
| FIN-06 | P0 | Multa e juros após a carência, rodando a rotina duas vezes | Cobranças separadas, sem duplicar; original intacta |
| FIN-07 | P0 | Repasse de imóvel com 3 proprietários e centavos sobrando | Soma exata; sobra vai aos primeiros |
| FIN-08 | P0 | Regerar repasse com um já pago | Pago não muda |
| FIN-09 | P1 | Importar o mesmo extrato duas vezes | Sem lançamentos duplicados |
| FIN-10 | P1 | Rateio e cancelamento com e sem pagamento | Só cancela sem pagamento |
| FIN-11 | P1 | Relatórios contra os lançamentos | Totais batem; CSV abre com acentos |

### 4.6 Boletos
| ID | P | Cenário | Esperado |
|---|---|---|---|
| BOL-01 | P0 | Emitir segundo boleto para cobrança com um em aberto | Recusado |
| BOL-02 | P0 | Carnê de 12 meses, repetido | 12 boletos; repetir não cria nada |
| BOL-03 | P1 | Carnê com mais de 36 meses ou contrato não vigente | Recusado |
| BOL-04 | P0 | Baixa em lote, desmarcando um | Só os marcados são baixados |
| BOL-05 | P1 | Desmarcar todos | Botão de baixa desabilitado |
| BOL-06 | P0 | Baixa com e sem "registrar o recebimento" | Com: recibo e cobrança paga. Sem: cobrança continua em aberto |
| BOL-07 | P1 | Data de pagamento futura | Recusada |
| BOL-08 | P1 | Baixar boleto já pago | Falha só nele, os demais seguem |
| BOL-09 | P1 | Colaborador tenta cancelar boleto | Negado |
| BOL-10 | P1 | Asaas sandbox: emitir, pagar no painel e atualizar | Boleto "paga"; cobrança só quita após registrar o recebimento |

### 4.7 Manutenção, vistorias e operação
| ID | P | Cenário | Esperado |
|---|---|---|---|
| OPE-01 | P1 | Pular etapa do fluxo do chamado | Recusado |
| OPE-02 | P0 | Colaborador aprova orçamento | Negado |
| OPE-03 | P0 | Inquilino abre o chamado dele | Não vê orçamentos nem notas internas |
| OPE-04 | P1 | Foto acima de 3 MB ou arquivo falso com extensão de imagem | Recusado |
| OPE-05 | P1 | Concluir vistoria com item sem avaliação; editar concluída | Os dois recusados |
| OPE-06 | P2 | Plano preventivo perto da data | Abre um chamado e avança a próxima data |
| OPE-07 | P1 | Contestar ocorrência duas vezes | Segunda recusada |
| OPE-08 | P1 | Votar duas vezes; enquete anônima | Um voto; equipe não vê quem votou |
| OPE-09 | P1 | Publicar comunicado para um imóvel | Só clientes daquele imóvel recebem |

### 4.8 Portaria
| ID | P | Cenário | Esperado |
|---|---|---|---|
| POR-01 | P0 | Entrada fora da validade, bloqueado ou cancelado | Recusada |
| POR-02 | P0 | Duas entradas seguidas (inclusive em duas abas) | Só uma é registrada |
| POR-03 | P1 | Saída sem entrada; cancelar quem está dentro | Recusado |
| POR-04 | P1 | Inquilino autoriza visitante | Aparece para a portaria com código |
| POR-05 | P1 | Visita recorrente fora do dia ou horário | Entrada recusada, informando os dias ou o horário autorizados |
| POR-06 | P2 | Registrar e retirar encomenda | Inquilino avisado; histórico correto |

### 4.9 Isolamento, permissões e segurança (P0)
| ID | Cenário | Esperado |
|---|---|---|
| SEG-01 | Com duas organizações, usar na B os IDs de registros da A (URL ou API) | 404 ou negado, em todos os módulos |
| SEG-02 | Inquilino A tenta ver dados do inquilino B | Negado |
| SEG-03 | Proprietário procura documento ou e-mail do inquilino | Não aparece |
| SEG-04 | Cliente chama rotas da equipe | Negado, e a negação aparece nos Registros |
| SEG-05 | Chave de API tenta gravar ou ler dado sensível | Negado |
| SEG-06 | Chave de API revogada | Deixa de funcionar na hora |
| SEG-07 | Abrir foto ou documento privado sem sessão ou de outra organização | Não entrega |
| SEG-08 | Escrita vinda de outro domínio (CSRF) | Bloqueada |
| SEG-09 | Texto com HTML ou script em nomes e descrições | Mostrado como texto, sem executar |
| SEG-10 | Webhook para endereço interno ou http | Recusado |
| SEG-11 | Conferir telas, respostas e Registros | Sem senhas, tokens ou chaves completas |
| SEG-12 | Voltar no navegador após sair | Não mostra dados; pede login |

### 4.10 Interface, celular e acessibilidade
| ID | P | Cenário | Esperado |
|---|---|---|---|
| UI-01 | P1 | Principais telas em celular, tablet e computador | Sem rolagem horizontal da página; tabelas rolam por dentro |
| UI-02 | P2 | Temas claro, escuro e sistema | Legível nos três |
| UI-03 | P1 | Navegar só pelo teclado; Esc nos modais | Foco visível, preso no modal e devolvido ao fechar |
| UI-04 | P2 | Listas vazias, carregando e com erro | Mensagem clara em cada estado |
| UI-05 | P1 | Duplo clique em botões que gravam dinheiro | Não duplica |
| UI-06 | P2 | Instalar como PWA e ficar sem internet | Aviso de offline; portal mostra leitura já carregada |
| UI-07 | P2 | Imprimir recibo, contrato e boleto | Só o documento sai na impressão |

### 4.11 Roteiro de ponta a ponta (P0)
1. Cadastrar uma administradora.
2. Criar proprietário, imóvel, unidade e inquilino.
3. Criar o contrato, ativar e emitir o documento.
4. Gerar o carnê de 3 meses.
5. Convidar o inquilino e o proprietário e concluir os dois cadastros pelo link.
6. Dar baixa em lote em 2 boletos, registrando o recebimento.
7. Conferir recibos, cobranças, repasse e relatórios.
8. Como inquilino: conferir financeiro, abrir chamado e autorizar visitante.
9. Como equipe: tratar o chamado e registrar a entrada do visitante.
10. Como proprietário: conferir que vê só o que é dele.
11. Conferir tudo nos Registros.

---

## 5. O que depende de configuração

| Recurso | Precisa |
|---|---|
| E-mails do Ethos (convite, avisos, segunda via) | `RESEND_API_KEY`, `EMAIL_FROM` e domínio verificado |
| E-mails de recuperação e troca de e-mail | SMTP e URLs de redirecionamento no Supabase |
| 2FA e guarda de chaves de integrações | `INTEGRATIONS_SECRET` |
| Push | Chaves VAPID |
| WhatsApp | API oficial da Meta e modelo aprovado |
| Login Google ou Microsoft | Supabase + `OAUTH_PROVIDERS` |
| Verificação de e-mail no cadastro | `REQUIRE_EMAIL_VERIFICATION=1` |
| Lembretes automáticos | `CRON_SECRET` e agendador |
| Leitura de documentos | Chave de um provedor de IA |
| Boleto bancário | Conta Asaas |

## 6. O que **não** existe (não reportar como falha)
Pix; baixa automática pelo Asaas; leitura de CNAB; assinatura ICP-Brasil; consulta a bureau de crédito; permissões granulares além dos 4 papéis; 2FA obrigatório por organização; reserva de áreas comuns; leitura de consumo; integração com catraca ou fechadura; planos e cobrança do próprio SaaS; páginas de preços e contato.

## 7. Situação dos testes automatizados
- API: 286 testes passando na última execução completa. Usam banco em memória e autenticação simulada.
- Interface: há testes no navegador (Playwright) sobre o modo demonstração. Nas execuções completas em paralelo já houve falhas intermitentes em um teste diferente a cada vez, que passava isolado. A última alteração (convites) rodou apenas os grupos relacionados.
- **Nunca testados contra o serviço real:** envio pelo Resend, WhatsApp, push, login Google e Microsoft, consulta de senha vazada, índices do Banco Central, link de troca de e-mail do Supabase, Asaas e o script de backup. São os candidatos mais fortes para teste manual.
