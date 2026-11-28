/**
 * Modelos de partida. O de locação residencial reproduz o "Modelo padrão Ethos" fornecido pela Ethos, cuja REVISÃO JURÍDICA
 * AINDA ESTÁ PENDENTE (a tela avisa). Os demais são só esqueletos, sem cláusulas.
 * Marcação: "# " título, "## " seção, "> " quadro de aviso, **negrito**, [[assinaturas]] quadro de assinaturas.
 */
import type { TemplateType } from "./contractTemplate.js";

const RESIDENCIAL_CAUCAO = `# INSTRUMENTO PARTICULAR DE CONTRATO DE LOCAÇÃO RESIDENCIAL

## 1 — DAS PARTES

{{#locadores}}
**LOCADOR(A):** {{locador.qualificacao}}, doravante denominado(a) simplesmente **LOCADOR(A)**.
{{/locadores}}

{{#locatarios}}
**LOCATÁRIO(A):** {{locatario.qualificacao}}, doravante denominado(a) simplesmente **LOCATÁRIO(A)**.
{{/locatarios}}

**ADMINISTRADORA:** {{administradora.razao_social}}, inscrita no CNPJ/MF sob o n.º {{administradora.cnpj}}, com sede em {{administradora.endereco}}, que intervém neste instrumento na qualidade de administradora do imóvel, doravante denominada simplesmente **ADMINISTRADORA**.

## 2 — DO OBJETO

**2.1 —** O(A) LOCADOR(A) loca ao(à) LOCATÁRIO(A) o imóvel situado em {{imovel.endereco}}, doravante denominado simplesmente **IMÓVEL**.

## 3 — DO PRAZO CONTRATUAL

**3.1 —** O prazo da presente locação é de {{contrato.prazo_meses}} meses, com início em {{contrato.data_inicio}} e término em {{contrato.data_fim}}.

**3.2 —** Desejando as partes prorrogar o contrato por igual período, deverão manifestar a intenção por escrito, com antecedência mínima de **30 (trinta) dias** do vencimento, para elaboração de novo instrumento ou aditivo, mediante apresentação da documentação necessária.

## 4 — DO ALUGUEL E DOS ENCARGOS

**4.1 —** O valor do aluguel do IMÓVEL é de {{contrato.valor_aluguel}} ({{contrato.valor_aluguel_extenso}}) por mês.

**4.2 —** Os aluguéis serão reajustados anualmente com base na variação do IPCA (Índice de Preços ao Consumidor Amplo).

**4.2.1 —** Se, em virtude de lei subsequente, vier a ser admitida a correção do aluguel em periodicidade inferior à prevista na legislação vigente, as partes concordam, desde já e em caráter irrevogável, que a correção passará a ser feita no menor prazo permitido por lei.

**4.3 —** Na extinção do índice adotado para o reajuste ou se a sua aplicação se tornar impraticável, os aluguéis passarão imediatamente a ser corrigidos pelo índice que melhor refletir a variação da correção monetária do valor locativo.

**4.4 —** O aluguel vence todo dia {{contrato.dia_vencimento}} de cada mês e deve ser pago na data do vencimento, juntamente com os encargos a vencer incidentes sobre a locação. Se a efetiva entrega das chaves ocorrer em data diversa da prevista na cláusula 3.1, por acordo entre as partes, reforma ou qualquer outra situação negociada, o vencimento passará a ser o dia da efetiva entrega das chaves, conforme o Termo de Entrega de Chaves.

**4.5 —** A ADMINISTRADORA enviará o boleto bancário para pagamento dos aluguéis e encargos ao e-mail informado pelo(a) LOCATÁRIO(A), que arcará com as despesas decorrentes do envio mensal. O(A) LOCATÁRIO(A) poderá, a qualquer tempo, deixar de pagar essa despesa, desde que compareça mensalmente à sede da ADMINISTRADORA para pagar o aluguel e os encargos.

**4.5.1 —** O não recebimento do boleto bancário não justifica o não pagamento no vencimento.

**4.5.2 —** Em caso de greve das instituições bancárias, o(a) LOCATÁRIO(A) poderá, excepcionalmente, pagar o aluguel no caixa da ADMINISTRADORA. Os pagamentos feitos diretamente à ADMINISTRADORA por cheque deverão ser realizados com 2 (dois) dias de antecedência do vencimento original.

**4.6 —** Em caso de mora no pagamento do aluguel e dos encargos convencionados, a importância devida será acrescida de multa de 10% (dez por cento), correção monetária e juros moratórios de 1% (um por cento) ao mês.

**4.6.1 —** Decorridos 20 (vinte) dias do vencimento, o débito será encaminhado ao departamento jurídico da ADMINISTRADORA e acrescido de 10% (dez por cento) a título de honorários advocatícios na cobrança extrajudicial e de 20% (vinte por cento) nas cobranças judiciais, além dos encargos previstos na cláusula anterior e das custas processuais.

**4.7 —** Correrão por conta do(a) LOCATÁRIO(A), a partir do início da locação, todas as despesas de consumo de energia elétrica, água e esgoto, telefone e gás, que serão pagas diretamente às respectivas concessionárias. Correrão também por sua conta o Imposto Predial e Territorial Urbano (IPTU), as taxas e as despesas ordinárias de condomínio incidentes sobre o IMÓVEL, que serão pagos por meio do boleto emitido pela ADMINISTRADORA, juntamente com o aluguel, na data do respectivo vencimento.

**4.8 —** O(A) LOCATÁRIO(A) declara ter conhecimento da obrigatoriedade de transferir a titularidade da conta de energia elétrica junto à ENEL (instalação n.º {{energia.instalacao}}), no prazo máximo de 5 (cinco) dias contados da posse do IMÓVEL, e de enviar o comprovante da solicitação por WhatsApp ao n.º {{administradora.whatsapp}}. A concessionária disponibiliza os seguintes canais: www.enel.com.br e telefone 0800 727 2120. A partir da transferência, o(a) LOCATÁRIO(A) arcará com as despesas decorrentes da utilização do serviço.

**4.9 —** O(A) LOCATÁRIO(A) declara ter conhecimento da obrigatoriedade de transferir a titularidade da conta de água e esgoto junto à SABESP (fornecimento n.º {{agua.fornecimento}}), no prazo máximo de 5 (cinco) dias contados da posse do IMÓVEL, e de enviar o comprovante da solicitação por WhatsApp ao n.º {{administradora.whatsapp}}. A concessionária disponibiliza os seguintes canais: www.sabesp-chat.sabesp.com.br/chat-externo e telefone 195. A partir da transferência, o(a) LOCATÁRIO(A) arcará com as despesas decorrentes da utilização do serviço.

**4.10 —** Havendo débitos de consumo anteriores à presente locação, competirá ao(à) LOCADOR(A) providenciar o imediato pagamento, possibilitando a transferência de titularidade e requerendo, se necessário, a religação da energia elétrica e da água e esgoto relativas ao IMÓVEL.

**4.11 —** Se o débito de responsabilidade do(a) LOCADOR(A) for quitado pelo(a) LOCATÁRIO(A), o(a) LOCADOR(A) deverá ressarci-lo(a) até o vencimento do próximo aluguel.

## 5 — DA UTILIZAÇÃO DO IMÓVEL

**5.1 —** A presente locação destina-se exclusivamente a fins residenciais de {{locatario.nome}}.

**5.2 —** É vedado ao(à) LOCATÁRIO(A) o uso do IMÓVEL para fins diversos do estabelecido na cláusula anterior, obrigando-se a:

**a)** observar e fazer com que as demais pessoas da família, visitantes e empregados observem, com o mais absoluto rigor, o regulamento interno do condomínio, quando houver, o qual deverá ser solicitado à administração do condomínio;

**b)** não ceder, sublocar ou emprestar, sob qualquer pretexto, no todo ou em parte, o IMÓVEL.

## 6 — DO ESTADO DE CONSERVAÇÃO E DA VISTORIA

**6.1 —** O(A) LOCATÁRIO(A) declara receber o IMÓVEL no estado de conservação apurado no Laudo de Vistoria Inicial, pactuado entre as partes, que descreve suas características, estado de conservação e qualificações e passa a integrar este instrumento.

**6.2 —** O(A) LOCATÁRIO(A) deverá comunicar por escrito, no prazo de 30 (trinta) dias contados do início da locação, eventuais irregularidades encontradas no IMÓVEL em desacordo com o Laudo de Vistoria Inicial, a fim de assegurar seus direitos por ocasião da devolução das chaves. O(A) LOCADOR(A) não será obrigado(a) a providenciar reparos, salvo se a irregularidade impedir o uso a que o IMÓVEL se destina, hipótese em que empreenderá os reparos necessários.

**6.3 —** O(A) LOCATÁRIO(A) obriga-se a manter o IMÓVEL no mais perfeito estado de conservação, no que concerne à limpeza, ao estado geral da pintura, às instalações elétricas e hidráulicas e a quaisquer acessórios, e a reparar os danos decorrentes de má utilização, para restituí-lo ao(à) LOCADOR(A), ao término ou na rescisão da locação, no estado em que o recebeu, ressalvadas as deteriorações decorrentes do uso normal, sem direito a reembolso ou retenção.

**6.3.1 —** Se o(a) LOCATÁRIO(A) não cumprir o disposto na cláusula 6.3 no prazo de 5 (cinco) dias após a devolução das chaves, o(a) LOCADOR(A) poderá enviar pessoa de sua confiança para executar os reparos necessários à reposição do IMÓVEL na situação do Laudo de Vistoria Inicial, obrigando-se o(a) LOCATÁRIO(A) a pagar os custos de material e mão de obra, além do aluguel e dos encargos, contados da devolução das chaves até a efetiva reparação.

**6.4 —** Por ocasião do distrato será realizada a vistoria final, que deverá apresentar o mesmo estado de conservação e as mesmas qualificações da vistoria inicial, ressalvadas as deteriorações decorrentes do uso normal.

**6.5 —** Se a vistoria final for reprovada, será elaborado relatório apontando os itens a reparar, e o(a) LOCATÁRIO(A) deverá repará-los antes da entrega das chaves ou indenizar o(a) LOCADOR(A), conforme a cláusula 6.3.

## 7 — DAS BENFEITORIAS

**7.1 —** Não é permitida qualquer instalação, adaptação, obra ou benfeitoria no IMÓVEL sem prévio consentimento por escrito da ADMINISTRADORA. Se autorizadas, o(a) LOCATÁRIO(A) responderá pela segurança do IMÓVEL e por eventuais intimações dos poderes públicos, arcando com multas e emolumentos por transgressões que venha a cometer, e obrigando-se, às suas expensas, a regularizar a obra junto aos órgãos competentes. Em hipótese alguma poderá exigir do(a) LOCADOR(A) indenização ou retenção, a qualquer título, por ocasião da entrega do IMÓVEL.

**7.2 —** As benfeitorias necessárias, isto é, aquelas imprescindíveis à manutenção e conservação do IMÓVEL e que visem impedir sua deterioração, deverão ser comunicadas à ADMINISTRADORA, para que profissional por ela designado realize vistoria na presença do(a) LOCATÁRIO(A) e, confirmada a necessidade, execute os devidos reparos às expensas do(a) LOCADOR(A). Se constatado que a avaria decorreu de mau uso do IMÓVEL pelo(a) LOCATÁRIO(A), o reparo será por sua conta e risco, sem direito a retenção ou indenização de qualquer espécie.

**7.3 —** As benfeitorias úteis, isto é, as que aumentam ou facilitam o uso do IMÓVEL, só poderão ser realizadas com autorização expressa da ADMINISTRADORA e não resultarão em direito de retenção ou indenização de qualquer espécie. Na falta de autorização expressa, o(a) LOCATÁRIO(A) será inteiramente responsável pela obra e igualmente não terá direito de retenção ou indenização.

**7.4 —** As benfeitorias voluntárias, isto é, as que visem apenas ao embelezamento do IMÓVEL, não serão indenizadas em hipótese alguma e poderão ser retiradas ao final da locação, desde que não afetem a estrutura e a substância do IMÓVEL; caso contrário, serão incorporadas a ele, sem conversão em indenização.

## 8 — DA DEVOLUÇÃO DAS CHAVES

**8.1 —** O(A) LOCATÁRIO(A) compromete-se, por ocasião da desocupação do IMÓVEL, por qualquer motivo, a comunicar expressamente a ADMINISTRADORA com 30 (trinta) dias de antecedência.

**8.2 —** O(A) LOCATÁRIO(A) deverá formalizar, por e-mail, o motivo da desocupação e a data prevista, respeitando a cláusula contratual vigente, e exibir os comprovantes de quitação das contas de consumo de energia elétrica, água, gás, telefone e demais encargos de sua responsabilidade. Deverá ainda informar os itens que serão devolvidos e que constem do Termo de Entrega de Chaves assinado no início da locação. Em data oportuna, será emitido boleto para pagamento, antes da vistoria final, de eventuais custos de itens não devolvidos.

**8.3 —** A vistoria final ocorrerá necessariamente com o IMÓVEL totalmente desocupado de pessoas e objetos pessoais.

**8.4 —** O recebimento das chaves pela ADMINISTRADORA não eximirá o(a) LOCATÁRIO(A) de indenizar os prejuízos eventualmente causados ao IMÓVEL.

**8.5 —** A cobrança das contas de consumo referentes ao período da locação, até a efetiva entrega das chaves, poderá ser realizada após o distrato, quando as contas forem disponibilizadas pelas concessionárias, junto ao(à) LOCATÁRIO(A), pelo valor total das contas, por meio de boleto emitido pela ADMINISTRADORA, com vencimento 2 (dois) dias antes do primeiro vencimento da conta de consumo, de modo a assegurar prazo hábil para o pagamento.

**8.5.1 —** Se as contas de consumo ainda não estiverem disponíveis, o consumo será cobrado com base na média dos últimos 3 (três) meses, e a diferença será cobrada posteriormente.

**8.5.2 —** Em caso de mora no pagamento do boleto das contas de consumo, aplicam-se as penalidades previstas nas cláusulas 4.6 e 4.6.1.

**8.6 —** A locação encerra-se, de ordinário, com a devolução das chaves à ADMINISTRADORA.

## 9 — DAS PENALIDADES

**9.1 —** A parte que infringir o presente contrato, em qualquer de suas cláusulas, pagará à outra multa equivalente a 3 (três) aluguéis vigentes à época, exigível por via de ação executiva, por constituir este instrumento, subscrito por duas testemunhas, título executivo extrajudicial (art. 784, III, do Código de Processo Civil), sem prejuízo do direito da parte inocente de exigir o cumprimento do contrato ou de considerá-lo rescindido.

**9.2 —** O pagamento da multa não exime o(a) LOCATÁRIO(A), no caso de rescisão, da obrigação de pagar os aluguéis e encargos vencidos, nem de ressarcir os danos eventualmente causados ao IMÓVEL.

**9.3 —** Em caso de infração contratual motivada pela desocupação do IMÓVEL antes de vencido o prazo contratual, a multa prevista na cláusula 9.1 será devida proporcionalmente ao período do contrato que ainda faltava cumprir, na forma do art. 4.º da Lei n.º 8.245/1991.

**9.4 —** O(A) LOCATÁRIO(A) será responsável pelas multas e juros decorrentes de sua desídia em entregar à ADMINISTRADORA qualquer intimação dos poderes públicos ou quaisquer comunicações relativas ao IMÓVEL.

**9.5 —** A infração a qualquer cláusula deste contrato constituirá automaticamente em mora a parte infratora, sem necessidade de interpelação, notificação ou protesto judicial, rescindindo-se o contrato de pleno direito, salvo se a parte inocente preferir exigir o cumprimento até o final, sem que isso signifique novação contratual e sem prejuízo da cobrança da multa a que tem direito.

**9.6 —** Decorridos 30 (trinta) dias sem o devido pagamento dos aluguéis correspondentes, o(a) LOCADOR(A) ou a ADMINISTRADORA poderá considerar rescindido o presente instrumento e, caso o(a) LOCATÁRIO(A) permaneça no IMÓVEL, será proposta ação de despejo, nos termos do art. 9.º, incisos II e III, e do art. 62 da Lei n.º 8.245/1991.

## 10 — DA GARANTIA

**10.1 —** A garantia do presente contrato é a **caução em dinheiro**, não se admitindo cumulação com outra modalidade de garantia.

**10.2 —** O(A) LOCATÁRIO(A) concorda, desde já, em depositar a título de garantia o valor de {{garantia.valor}} ({{garantia.valor_extenso}}), equivalente a {{garantia.meses}} meses de aluguel, em caderneta de poupança, nos termos do art. 38, § 2.º, da Lei n.º 8.245/1991, revertendo ao(à) LOCATÁRIO(A) os rendimentos apurados por ocasião do levantamento.

**10.3 —** O valor da caução poderá ser utilizado em todas as hipóteses em que forem necessários recursos provenientes do(a) LOCATÁRIO(A). Sendo utilizado, o numerário será imediatamente reposto. Finda a locação, com a entrega das chaves, aprovada a vistoria final e quitados os débitos, a caução será restituída ao(à) LOCATÁRIO(A) com os rendimentos apurados, descontados os valores devidos, sem prejuízo de ação judicial adequada.

**10.4 —** Eventuais débitos decorrentes do presente contrato, não pagos pelo(a) LOCATÁRIO(A) após regularmente instado(a) a tanto, serão comunicados às entidades mantenedoras de bancos de dados de proteção ao crédito (SERASA, SPC, etc.), pelo(a) LOCADOR(A) ou pela ADMINISTRADORA. Tais débitos incluem todas as despesas com as medidas judiciais cabíveis.

## 11 — DA VENDA DO IMÓVEL

**11.1 —** Caso o IMÓVEL seja colocado à venda, o(a) LOCATÁRIO(A) não poderá impedir a visitação por interessados indicados pelo(a) LOCADOR(A) ou pela ADMINISTRADORA e por seus prepostos, sendo-lhe lícito determinar períodos e horários em cada dia para esse fim, mediante data e horário acordados previamente, com antecedência mínima de 48 (quarenta e oito) horas.

**11.2 —** Na hipótese da cláusula anterior, o(a) LOCATÁRIO(A) terá preferência para adquirir o IMÓVEL, obrigando-se o(a) LOCADOR(A) a dar-lhe ciência do negócio por notificação judicial ou extrajudicial, ou por outro meio de ciência inequívoca, comprovadamente efetuada.

## 12 — DAS DISPOSIÇÕES GERAIS

**12.1 —** Todos os assuntos relacionados à locação deverão ser tratados com a ADMINISTRADORA, pelos contatos {{administradora.telefone}} ou {{administradora.email}}.

**12.2 —** O(A) LOCATÁRIO(A) faculta, desde já, ao(à) LOCADOR(A) vistoriar o IMÓVEL quando julgar necessário, desde que a data e o horário sejam acordados previamente, com antecedência mínima de 48 (quarenta e oito) horas, de modo a atender satisfatoriamente o interesse de ambas as partes.

**12.3 —** Em caso de desapropriação ou de determinação judicial ou do poder público que comprove estar o IMÓVEL ameaçado de ruína ou em perigo iminente, as partes ficarão desobrigadas das cláusulas deste contrato, sendo devidos normalmente os aluguéis e encargos até a efetiva desocupação ou desapropriação.

**12.4 —** A decretação de falência ou a declaração de insolvência civil do(a) LOCATÁRIO(A) autoriza o(a) LOCADOR(A) a considerar rescindido o contrato, permanecendo as obrigações assumidas pelo(a) LOCATÁRIO(A) nas condições ora pactuadas.

**12.5 —** Qualquer tolerância do(a) LOCADOR(A) no cumprimento deste contrato, qualquer que seja sua natureza, não gerará direito ao(à) LOCATÁRIO(A) nem alterará qualquer cláusula deste contrato.

**12.6 —** O presente contrato obriga as partes contratantes, seus herdeiros e sucessores, a qualquer título.

**12.7 —** Havendo mais de um(a) LOCATÁRIO(A), declaram-se solidários entre si no cumprimento das obrigações deste contrato e constituem-se reciprocamente procuradores, conferindo-se mutuamente poderes especiais para receber citações, notificações e intimações, confessar, desistir, transigir em juízo ou fora dele, fazer acordos, firmar compromissos judiciais ou extrajudiciais, receber e dar quitação, e assinar tudo quanto se tornar necessário.

**12.8 —** Fica eleito o foro da situação do IMÓVEL, com renúncia de qualquer outro, por mais privilegiado que seja, para dirimir dúvidas oriundas do presente contrato.

## 13 — DA PROTEÇÃO DE DADOS PESSOAIS

**13.1 —** As partes tratarão os dados pessoais obtidos em razão deste contrato exclusivamente para sua execução, para a cobrança dos valores devidos, para o exercício regular de direitos e para o cumprimento de obrigações legais, observada a Lei n.º 13.709/2018 (LGPD).

**13.2 —** O(A) LOCATÁRIO(A) autoriza a ADMINISTRADORA a enviar comunicações relativas à locação, inclusive cobranças, por e-mail e WhatsApp, nos contatos informados neste instrumento.

E, por estarem de pleno e irrevogável acordo, as partes declaram que leram e analisaram cuidadosamente as cláusulas deste contrato e concordam com seus termos, não havendo dúvida quanto à sua interpretação, tendo o(a) LOCADOR(A) pleno conhecimento da abrangência e da qualidade da garantia apresentada pelo(a) LOCATÁRIO(A). As partes assinam o presente instrumento pelo sistema de assinatura eletrônica, que aceitam como plenamente válido (MP n.º 2.200-2/2001 e Lei n.º 14.063/2020).

{{contrato.cidade}}, {{contrato.data_assinatura}}.

[[assinaturas]]
`;

const skeleton = (title: string, object: string) => `# ${title}

## 1 — DAS PARTES

{{#locadores}}
**LOCADOR(A):** {{locador.qualificacao}}.
{{/locadores}}

{{#locatarios}}
**LOCATÁRIO(A):** {{locatario.qualificacao}}.
{{/locatarios}}

{{#fiadores}}
**FIADOR(A):** {{fiador.nome}}, documento {{fiador.documento}}.
{{/fiadores}}

## 2 — DO OBJETO

**2.1 —** ${object} {{imovel.endereco}}, unidade {{unidade.identificacao}}.

## 3 — DAS CONDIÇÕES

**3.1 —** Prazo de {{contrato.prazo_extenso}}, de {{contrato.data_inicio}} a {{contrato.data_fim}}.

**3.2 —** Valor mensal de {{contrato.valor_aluguel}} ({{contrato.valor_aluguel_extenso}}), com vencimento todo dia {{contrato.dia_vencimento}}.

> Inclua aqui as cláusulas aprovadas pela administração e revisadas pelo jurídico.

{{contrato.cidade}}, {{contrato.data_assinatura}}.

[[assinaturas]]
`;

export const STARTERS: { id: string; type: TemplateType; name: string; description: string; body: string }[] = [
  { id: "residencial-caucao", type: "locacao_residencial", name: "Padrão Ethos: locação residencial (caução)", description: "Modelo da Ethos com todas as cláusulas. Revisão jurídica pendente: não use sem aprovação.", body: RESIDENCIAL_CAUCAO },
  { id: "comercial", type: "locacao_comercial", name: "Esqueleto: locação comercial", description: "Só a estrutura, sem cláusulas.", body: skeleton("CONTRATO DE LOCAÇÃO COMERCIAL", "Locação, para fins comerciais, do imóvel situado em") },
  { id: "temporada", type: "temporada", name: "Esqueleto: locação por temporada", description: "Só a estrutura, sem cláusulas.", body: skeleton("CONTRATO DE LOCAÇÃO POR TEMPORADA", "Locação por temporada do imóvel situado em") },
  { id: "garagem", type: "garagem", name: "Esqueleto: vaga de garagem", description: "Só a estrutura, sem cláusulas.", body: skeleton("CONTRATO DE LOCAÇÃO DE VAGA DE GARAGEM", "Locação de vaga de garagem no imóvel situado em") },
];
