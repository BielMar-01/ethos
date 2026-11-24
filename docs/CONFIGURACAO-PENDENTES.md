# Configuração dos itens pendentes — passo a passo

Este guia leva você, clique a clique, do "código pronto" ao "funcionando de verdade" para tudo que depende de **contas e serviços externos**.
Foi escrito para poder ser **entregue a um assistente (ChatGPT com controle de tela, Claude etc.) ou seguido por uma pessoa**. Cada seção diz:
**Para que serve → O que você precisa → Onde clicar → O que copiar/colar → Como saber que deu certo → Erros comuns.**

> **Regra de ouro:** nenhum segredo (chave, senha, token) vai para o chat, para o Git, para prints ou para o código. Cole-os **somente** nos campos de *Environment Variables* da Vercel (ou nos painéis dos próprios serviços). Se um segredo vazar, **gere outro** e apague o antigo.

## Prompt para entregar a um assistente com controle de tela

> Você vai me ajudar a configurar serviços do meu sistema "Ethos" seguindo o arquivo `docs/CONFIGURACAO-PENDENTES.md`, **uma seção por vez**. Regras: (1) antes de cada ação, diga o que vai clicar e por quê; (2) **nunca** me peça para colar segredos no chat: diga em qual campo eu mesmo devo colar; (3) quando um passo precisar de decisão minha (domínio, e-mail remetente, plano pago), **pare e pergunte**; (4) depois de cada seção, faça o "Como saber que deu certo" e me diga o resultado; (5) se algo não bater com o que está na tela, pare e descreva a diferença em vez de improvisar; (6) não clique em nada que gere cobrança sem eu confirmar.

---

## 0. Antes de tudo: como mexer nas variáveis da Vercel
1. Acesse https://vercel.com → o projeto do Ethos → **Settings** → **Environment Variables**.
2. Para cada variável: **Key** (nome), **Value** (valor), marque **Production** (e *Preview* só se for usar), clique **Save**.
3. **Variável nova só vale depois de um novo deploy**: vá em **Deployments** → no último → **⋯** → **Redeploy** (desmarque "Use existing Build Cache" se pedir).
4. Para gerar valores aleatórios no Windows (PowerShell):
   ```powershell
   [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
   ```
5. As **migrações do banco (014 a 020)** rodam sozinhas no build de **Production** (`scripts/vercel-build.mjs`). Depois do deploy, confira na Vercel → **Deployments → o deploy → Build Logs** a linha de migrações aplicadas.

### Variáveis que o sistema usa (resumo)
| Variável | Para quê | Obrigatória? |
|---|---|---|
| `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `APP_URL`, `CRON_SECRET` | base do sistema (já configuradas) | sim |
| `INTEGRATIONS_SECRET` | cifra chaves de integrações e o segredo do 2FA | **sim** para 2FA/Asaas/IA |
| `RESEND_API_KEY`, `EMAIL_FROM` | e-mails do Ethos (avisos, segurança, 2ª via, assinatura) | para e-mail |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | notificação push | para push |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TEMPLATE`, `WHATSAPP_LANG` | WhatsApp oficial | para WhatsApp |
| `OAUTH_PROVIDERS` (`google`, `azure` ou `google,azure`) | mostra os botões de login social | para login social |
| `REQUIRE_EMAIL_VERIFICATION` (`1`) | exige confirmar e-mail no cadastro público | opcional |
| `ERROR_ALERT_EMAILS` | e-mail de quem opera, avisado numa enxurrada de erros | opcional |
| `AUDIT_ANON_AFTER_DAYS` | dias até anonimizar auditoria de contas encerradas (padrão 1825) | opcional |

---

## 1. `INTEGRATIONS_SECRET` (faça primeiro)
**Para que serve:** cifra o segredo do 2FA e as chaves de Asaas/IA/webhooks no banco. Sem ela o 2FA fica "indisponível".
1. Gere um valor aleatório de 32+ caracteres (comando da seção 0, item 4).
2. Vercel → Environment Variables → `INTEGRATIONS_SECRET` = o valor → Save → Redeploy.
3. **Guarde uma cópia em um gerenciador de senhas.** Se for perdida/trocada, o que foi salvo cifrado fica ilegível (2FA precisaria ser refeito, chaves recadastradas).
**Deu certo se:** no app → *Meu perfil* → cartão "Verificação em duas etapas" mostra o botão **Ativar** (e não o aviso "Indisponível neste servidor").

## 2. E-mail do Ethos com Resend (avisos, segurança, 2ª via, assinaturas)
**Para que serve:** o sistema passa a enviar e-mail por conta própria (aviso de aparelho novo, troca de senha/e-mail, 2ª via de boleto, links de assinatura, avisos por categoria).
**Você precisa de:** um **domínio seu** (ex.: `suaadministradora.com.br`) e acesso ao painel de DNS dele (Registro.br, Cloudflare, GoDaddy…).
1. Crie conta em https://resend.com (grátis até ~3.000 e-mails/mês).
2. **Domains → Add Domain** → digite o domínio (ou subdomínio `avisos.suaadministradora.com.br`, recomendado) → região mais próxima.
3. O Resend mostra **registros DNS** (SPF/MX de envio, DKIM, às vezes DMARC). No painel de DNS do seu domínio, **crie cada registro exatamente como mostrado** (tipo, nome, valor, prioridade). Volte ao Resend e clique **Verify DNS Records**; pode levar de minutos a algumas horas até ficar **Verified**.
4. **API Keys → Create API Key** → nome `ethos-producao`, permissão **Sending access**, domínio = o verificado → **Add** → **copie a chave agora** (começa com `re_`; só aparece uma vez).
5. Na Vercel: `RESEND_API_KEY` = a chave; `EMAIL_FROM` = `Ethos <avisos@avisos.suaadministradora.com.br>` (o endereço **tem de ser do domínio verificado**). Salve e faça Redeploy.
**Deu certo se:** em *Meu perfil* troque a senha → chega um e-mail "Sua senha foi alterada". No Resend → **Emails** aparece o envio como *Delivered*.
**Erros comuns:** domínio não verificado (envios retornam 403); `EMAIL_FROM` de outro domínio; chave com permissão só de leitura; e-mail caindo no spam (conclua DKIM+SPF+DMARC).

## 3. Supabase: SMTP próprio, URLs e troca de e-mail (corrige "não consegui validar o e-mail")
**Para que serve:** a troca de e-mail e a confirmação de cadastro são enviadas pelo **Supabase Auth** (não pelo Resend do passo 2). O SMTP padrão do Supabase quase não envia e-mails — por isso o link de confirmação podia nunca chegar.
1. https://supabase.com/dashboard → seu projeto → **Authentication** → **URL Configuration**:
   - **Site URL** = o valor de `APP_URL` (ex.: `https://app.suaadministradora.com.br`, sem barra no fim).
   - **Redirect URLs** → **Add URL** → a mesma `APP_URL` e também `APP_URL/**`. Salve.
2. **Authentication** → **Emails** (em dashboards antigos: *Project Settings → Authentication → SMTP Settings*) → **SMTP Settings** → ative **Enable Custom SMTP** e preencha usando o Resend:
   - **Sender email**: `avisos@avisos.suaadministradora.com.br` (do domínio verificado) · **Sender name**: `Ethos`
   - **Host**: `smtp.resend.com` · **Port**: `465` · **Username**: `resend` · **Password**: a **API Key** do Resend (pode ser a mesma do passo 2 ou outra criada só para o Supabase).
   - Salve. Ainda em *Emails → Rate Limits*, aumente o limite de e-mails por hora se aparecer.
3. **Authentication → Sign In / Providers → Email** (ou *Providers → Email*): confira que **Confirm email** está ligado e decida **Secure email change**:
   - *Ligado* (padrão, mais seguro): ao trocar o e-mail, o link é enviado ao **e-mail antigo E ao novo**; a troca só vale depois dos **dois** cliques.
   - *Desligado*: basta clicar no link do e-mail novo.
4. (Opcional) **Authentication → Emails → Templates**: traduza os modelos *Change Email Address*, *Confirm signup* e *Reset Password* para português.
**Teste da troca de e-mail (faça com uma conta de teste):**
1. Entre no app → *Meu perfil* → "E-mail de acesso": digite um e-mail **seu** novo + senha atual → *Enviar link de confirmação*. O cartão mostra "Aguardando confirmação".
2. Abra o e-mail novo (e o antigo, se "Secure email change" estiver ligado) e clique nos links.
3. O navegador volta ao app mostrando "E-mail confirmado" → entre com o **e-mail novo**.
4. Teste também *Cancelar este pedido* antes de clicar: o link antigo não deve trocar nada.
**Deu certo se:** o e-mail de login passou a ser o novo e o antigo deixou de funcionar. **Erros comuns:** Redirect URL sem `APP_URL` (o link abre uma página do Supabase com erro); SMTP com senha errada (Supabase mostra "Error sending confirmation email"); remetente de domínio não verificado.

## 4. Exigir confirmação de e-mail no cadastro (opcional)
Só faça **depois** da seção 3 funcionando. Vercel: `REQUIRE_EMAIL_VERIFICATION` = `1` → Redeploy.
**Deu certo se:** um novo cadastro mostra "Enviamos um link de confirmação…" e só consegue entrar depois de clicar no link; "Reenviar o link" funciona. Para desligar, apague a variável.

## 5. Notificação push (aviso no celular/computador)
**Para que serve:** o aviso aparece como notificação do navegador, mesmo com o Ethos fechado (PWA instalado).
1. No computador do projeto (PowerShell, pasta `C:\Projetos\ethos`): `npx web-push generate-vapid-keys`. Aparecem **Public Key** e **Private Key**.
2. Vercel: `VAPID_PUBLIC_KEY` = Public Key; `VAPID_PRIVATE_KEY` = Private Key (**secreta**); `VAPID_SUBJECT` = `mailto:contato@suaadministradora.com.br`. Redeploy.
**Deu certo se:** no app → *Notificações → Preferências* aparece a caixa "Receber avisos neste aparelho". Marque, **permita** no pedido do navegador, e peça a alguém para registrar uma encomenda para a sua unidade: a notificação chega.
**Erros comuns:** iPhone só recebe push com o app **instalado na tela inicial** (iOS 16.4+); permissão negada no navegador (libere em Configurações do site); trocar as chaves VAPID invalida as inscrições antigas (as pessoas ativam de novo).

## 6. WhatsApp oficial (API da Meta)
**Para que serve:** avisos por WhatsApp, **só para quem aceitou** (caixa de consentimento em *Notificações → Preferências*, exige telefone no perfil).
**Você precisa de:** conta no Facebook Business (Meta Business Manager), um **número de telefone dedicado** (que não esteja em uso no WhatsApp comum/Business app) e um **meio de pagamento** na Meta (mensagens iniciadas pela empresa são cobradas por conversa).
1. https://developers.facebook.com → **My Apps → Create App** → tipo **Business** → vincule o Business Manager.
2. No app: **Add Product → WhatsApp → Set up**. Em **API Setup**: anote o **Phone number ID** (é o `WHATSAPP_PHONE_ID`). Para testes use o número de teste que a Meta oferece; para produção **adicione o seu número** e verifique por SMS/ligação.
3. **Token permanente** (o temporário expira em 24 h): https://business.facebook.com → **Configurações do negócio → Usuários → Usuários do sistema → Adicionar** (função Admin) → **Gerar token** → app do Ethos → permissões **`whatsapp_business_messaging`** e **`whatsapp_business_management`** → expiração **Nunca** → **copie** (é o `WHATSAPP_TOKEN`). Em **Contas → Contas do WhatsApp**, atribua a conta ao usuário do sistema (controle total).
4. **Modelo (template) de mensagem**: WhatsApp Manager → **Ferramentas de conta → Modelos de mensagem → Criar modelo**:
   - Categoria **Utilidade** · Nome **`aviso_ethos`** (só minúsculas e `_`) · Idioma **Português (BR)**.
   - Corpo (precisa de **uma** variável, **não pode começar nem terminar com ela**): `Aviso da sua administradora: {{1}}. Para deixar de receber, ajuste as preferências no app.`
   - Exemplo para a variável: `Boleto vence amanhã — R$ 1.500,00`. Envie e **aguarde a aprovação** (minutos a 1 dia).
5. Vercel: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TEMPLATE` = `aviso_ethos`, `WHATSAPP_LANG` = `pt_BR`. Redeploy.
**Deu certo se:** *Notificações → Preferências* mostra a coluna **WhatsApp** habilitada; ao marcar o consentimento e gerar um aviso financeiro, a mensagem chega no número. **Erros comuns:** modelo ainda "Em análise"/rejeitado; token de 24 h; número já usado no app WhatsApp; telefone sem DDD no perfil.

## 7. Login com Google e Microsoft
**Para que serve:** botões "Entrar com Google/Microsoft" na tela de login (só entra quem **já tem conta**; com 2FA ativo ainda pede o código).
**A) Google** — https://console.cloud.google.com:
1. Crie/selecione um projeto → **APIs e serviços → Tela de permissão OAuth** → tipo **Externo** → nome do app "Ethos", e-mail de suporte → salve (para uso interno de poucas pessoas pode ficar em "Teste" com usuários de teste; para qualquer pessoa, **Publicar app**).
2. **Credenciais → Criar credenciais → ID do cliente OAuth** → tipo **Aplicativo da Web** → em **URIs de redirecionamento autorizados** adicione a **Callback URL do Supabase** (veja no passo B-1: `https://<ref-do-projeto>.supabase.co/auth/v1/callback`) → **Criar** → copie **ID do cliente** e **Chave secreta**.
3. Supabase → **Authentication → Sign In / Providers → Google** → ligue → cole **Client ID** e **Client Secret** → Save.
**B) Microsoft (Azure)** — https://portal.azure.com:
1. **Microsoft Entra ID → Registros de aplicativos → Novo registro** → nome "Ethos" → tipos de conta: *contas em qualquer diretório organizacional e contas pessoais* → **URI de redirecionamento (Web)** = a Callback URL do Supabase (a mesma acima) → Registrar. Copie **ID do aplicativo (cliente)**.
2. **Certificados e segredos → Novo segredo do cliente** → copie o **Valor** (aparece uma vez).
3. Supabase → **Providers → Azure** → ligue → **Application (client) ID**, **Secret**, e **Azure Tenant URL** = `https://login.microsoftonline.com/common` (ou o ID do seu diretório) → Save.
**C) No Ethos:** Vercel → `OAUTH_PROVIDERS` = `google` (ou `azure`, ou `google,azure`) → Redeploy.
**Deu certo se:** a tela de login mostra "Entrar com Google/Microsoft"; entrar com um e-mail que **já é usuário** abre o painel; com e-mail sem convite aparece "Não há conta do Ethos para este e-mail".
**Erros comuns:** `redirect_uri_mismatch` (a Callback URL no Google/Azure diferente da do Supabase); e-mail do Google diferente do e-mail cadastrado no Ethos (não vincula).

## 8. Agendador dos avisos automáticos (cron)
**Para que serve:** multa/juros, vencimento de documentos e garantias, manutenção preventiva, visita que não chegou, permanência de visitante, encomendas paradas, lembretes de visita, enquetes que vencem, anonimização de auditoria.
- **Vercel Hobby:** o `vercel.json` já chama `GET /api/reminders/cron` **1×/dia** (11:00 UTC). Serve para tudo, **exceto** os avisos que precisam de precisão de minutos ("visita não chegou 1 h depois", "permanência acima do limite").
- **Vercel Pro:** edite `vercel.json` → `"schedule": "*/15 * * * *"` e faça deploy.
- **Alternativa grátis (qualquer plano):** https://cron-job.org → conta → **Create cronjob**: URL `https://SEU-DOMINIO/api/reminders/cron`, a cada **15 minutos**, **Advanced → Headers**: `Authorization: Bearer <o valor de CRON_SECRET>`, método GET. Salve e use **Test run**.
**Deu certo se:** a chamada retorna `{"ok":true}` (HTTP 200). Sem o header correto: 401; sem `CRON_SECRET` configurada: 404.

## 9. Aviso de erros do servidor
Vercel: `ERROR_ALERT_EMAILS` = `seu@email.com` (vários separados por vírgula) → Redeploy. Exige a seção 2. Com 10 erros do servidor em 10 minutos você recebe 1 e-mail (no máx. 1 por hora). Veja a lista em *Integrações → Monitoramento de erros*.

## 10. Backup do banco
Siga `docs/BACKUP-RESTAURACAO.md` (camada 1: backups do Supabase/PITR; camada 2: `npm run db:backup` agendado; camada 3: teste de restauração mensal). **O script de backup ainda não foi executado** (a máquina de desenvolvimento não tinha `pg_dump`): rode uma vez e confira o arquivo gerado.

## 11. Asaas (boleto real) — teste no sandbox
(Pendente desde a primeira versão: nunca foi testado contra o Asaas real.)
1. https://sandbox.asaas.com → crie conta de **sandbox** → **Integrações → Chave de API** → gere e copie.
2. No Ethos → **Administração → Integrações → Asaas** → ambiente **Sandbox** → cole a chave → **Testar conexão** (deve mostrar saldo).
3. Em *Financeiro → Cobranças*, abra uma cobrança de inquilino com **CPF/CNPJ válido** → **Emitir boleto → Emitir pelo Asaas**. Confira o boleto no painel do Asaas sandbox.
4. No sandbox, simule o pagamento e, no Ethos, **Boletos → Atualizar situações**: o boleto vira "Pago". Use **Pago + registrar recebimento** ou registre em Pagamentos para dar baixa.
5. Só depois, para produção: chave de **produção**, ambiente **Produção**.
**Atenção:** a baixa automática por webhook do Asaas **ainda não existe** (é item futuro).

## 12. Vitrine pública de imóveis
*Captação → Vitrine pública → Ligar a vitrine* → copie o link (`…/#/imoveis/<código>`) e divulgue. Só aparecem unidades com situação **Disponível** (bairro e cidade, sem endereço completo). *Gerar novo link* invalida o anterior; *Desligar* tira do ar.

---

## Checklist final pós-deploy (10 minutos)
1. `https://SEU-DOMINIO/api/health` → `{"status":"ok"}`.
2. Vercel → Build Logs → migrações até `020_monitoring.sql` aplicadas, sem erro.
3. Login normal funciona; *Meu perfil* abre; 2FA mostra "Ativar".
4. Troca de senha → e-mail de alerta chega (seção 2).
5. Troca de e-mail por link funciona (seção 3).
6. *Financeiro → Configurações*: defina multa/juros/pro rata do seu contrato e use **Simular** antes de **Aplicar**.
7. *Relatórios → Inadimplência* abre e baixa o CSV.
8. Se configurou: push (5), WhatsApp (6), login social (7), cron (8) — cada "Deu certo se".
9. Anote a data e o que ficou pendente.

## O que continua fora do sistema (de propósito)
Pix e baixa automática de boleto; CNAB (precisa de um arquivo de exemplo do seu banco); assinatura **qualificada** (ICP-Brasil: use um provedor como D4Sign/ClickSign e anexe o PDF); consulta de crédito em Serasa/SPC; reserva de áreas comuns, leitura de consumo e catraca/fechadura.
