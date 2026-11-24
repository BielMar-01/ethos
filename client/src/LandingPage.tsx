import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'

import Icon, { type IconName } from './Icon'
import ThemeToggle from './ThemeToggle'
import { Counter, Reveal, useScrolled } from './reveal'
import { go, type PublicRoute } from './routes'

const YEAR = new Date().getFullYear()

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** Cabeçalho e rodapé das páginas públicas (home e documentação da API). */
export function PublicLayout({ children, route }: { children: ReactNode; route: PublicRoute }) {
  const scrolled = useScrolled()
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    document.title = route === 'api' ? 'API — Ethos' : 'Ethos — Administração de imóveis'
    window.scrollTo({ top: 0 })
    setMenu(false)
  }, [route])

  // Gaveta aberta: Esc fecha.
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menu])

  const toSection = (id: string) => () => {
    setMenu(false)
    if (route !== 'home') {
      go('home')
      setTimeout(() => scrollTo(id), 80)
    } else scrollTo(id)
  }

  return (
    <div className="pub">
      <div className="scroll-progress" aria-hidden="true" />
      <header className={`pub-header${scrolled ? ' scrolled' : ''}`}>
        <button className="pub-brand" onClick={() => go('home')} aria-label="Ethos — página inicial">Ethos</button>
        <nav className="pub-nav" aria-label="Principal">
          <button onClick={toSection('funcionalidades')}>Funcionalidades</button>
          <button onClick={toSection('para-quem')}>Para quem é</button>
          <button onClick={toSection('seguranca')}>Segurança</button>
          <button className={route === 'api' ? 'active' : ''} onClick={() => go('api')}>API</button>
        </nav>
        <div className="pub-actions">
          <ThemeToggle />
          <button onClick={() => go('login')}>Entrar</button>
          <button className="primary" onClick={() => go('register')}>Começar agora</button>
          <button className="icon-btn pub-menu-btn" aria-label={menu ? 'Fechar menu' : 'Abrir menu'} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Icon name={menu ? 'x' : 'menu'} />
          </button>
        </div>
        <nav className={menu ? 'pub-drawer open' : 'pub-drawer'} aria-label="Menu" aria-hidden={!menu}>
          <button tabIndex={menu ? 0 : -1} onClick={toSection('funcionalidades')}>Funcionalidades</button>
          <button tabIndex={menu ? 0 : -1} onClick={toSection('para-quem')}>Para quem é</button>
          <button tabIndex={menu ? 0 : -1} onClick={toSection('seguranca')}>Segurança</button>
          <button tabIndex={menu ? 0 : -1} onClick={() => go('api')}>API</button>
          <button tabIndex={menu ? 0 : -1} onClick={() => go('login')}>Entrar</button>
        </nav>
      </header>
      <main className="pub-main route-enter" key={route}>{children}</main>
      <footer className="pub-footer">
        <div>
          <strong className="brand">Ethos</strong>
          <p className="muted small">Administração de imóveis com transparência, organização e rastreabilidade.</p>
        </div>
        <div className="pub-footer-links">
          <button onClick={toSection('funcionalidades')}>Funcionalidades</button>
          <button onClick={() => go('api')}>Documentação da API</button>
          <button onClick={() => go('login')}>Entrar</button>
          <button onClick={() => go('register')}>Criar conta</button>
        </div>
        <p className="muted small pub-copy">
          © {YEAR} Ethos Administradora de Imóveis
          <button className="link" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>Voltar ao topo ↑</button>
        </p>
      </footer>
    </div>
  )
}

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'building', title: 'Imóveis e unidades', text: 'Cadastre imóveis, unidades locáveis, proprietários e inquilinos — um a um ou importando planilhas. Um imóvel pode ter várias unidades e mais de um proprietário.' },
  { icon: 'file', title: 'Contratos', text: 'Modelos com variáveis e versões, documentos emitidos que não mudam depois e controle de vigência — sem dois contratos vigentes na mesma unidade.' },
  { icon: 'wallet', title: 'Financeiro', text: 'Aluguéis do mês gerados de uma vez, baixas, recibos numerados, estornos com histórico e repasses ao proprietário já com a taxa de administração.' },
  { icon: 'camera', title: 'Vistorias', text: 'Checklist por ambiente com fotos, laudo e comparação entre entrada e saída. Depois de concluída, a vistoria não é mais alterada.' },
  { icon: 'wrench', title: 'Manutenção', text: 'Do chamado à conclusão: prioridade, responsável, orçamentos com aprovação, fotos e uma linha do tempo de tudo o que aconteceu.' },
  { icon: 'users', title: 'Área do cliente', text: 'O inquilino acompanha cobranças, recibos e contrato e abre chamados. O proprietário vê imóveis, repasses e vistorias.' },
  { icon: 'door', title: 'Moradores e acessos', text: 'Registre quem mora na unidade (cônjuge, filhos, parentes, funcionários) e autorize visitantes e prestadores. A portaria confere pelo nome ou código e registra entradas e saídas.' },
  { icon: 'file', title: 'Aditivos, rescisão e assinaturas', text: 'Renovação e reajuste com minuta pronta (IGP-M/IPCA do Banco Central), rescisão com multa proporcional calculada, garantias e coleta de assinaturas eletrônicas simples por link.' },
  { icon: 'wallet', title: 'Relatórios e conciliação', text: 'Inadimplência, DRE por imóvel e fluxo de caixa com exportação em CSV, conciliação do extrato bancário (OFX/CSV), multa e juros por atraso e rateio de despesas entre as unidades.' },
  { icon: 'search', title: 'Captação e operação', text: 'Vitrine pública de unidades disponíveis, funil de interessados e agenda de visitas; prestadores com avaliação, manutenção preventiva recorrente, enquetes e ocorrências com multa.' },
  { icon: 'history', title: 'Registro de atividades', text: 'O administrador vê quem fez o quê, quando e de onde — logins, alterações, exclusões e acessos negados. O histórico não pode ser editado.' },
  { icon: 'code', title: 'API aberta', text: 'Documentação OpenAPI e chaves de API somente leitura para integrar a Ethos com os seus sistemas.' },
]

const AUDIENCES = [
  { title: 'Administradoras', points: ['Carteira inteira em um painel', 'Cobranças, recibos e repasses sem planilha', 'Equipe com papéis e histórico de atividades', 'Vistorias e chamados organizados por unidade'] },
  { title: 'Proprietários', points: ['Imóveis, ocupação e aluguel contratado', 'Repasses com valor bruto, taxa e líquido', 'Acompanhamento de chamados e custos', 'Laudos de vistoria dos seus imóveis'] },
  { title: 'Inquilinos', points: ['Cobranças, vencimentos e recibos', 'Contrato e documentos sempre à mão', 'Pedido de manutenção com fotos e acompanhamento', 'Confirmação de ciência dos laudos'] },
]

const SECURITY = [
  'Cada organização enxerga somente os próprios dados, sempre validado no servidor.',
  'Documentos, recibos e fotos são privados: só saem para quem está autenticado e tem vínculo.',
  'Clientes veem apenas o que pertence ao seu cadastro; o proprietário não recebe documentos pessoais do inquilino.',
  'Recibos, contratos emitidos e vistorias concluídas não podem ser editados; estornos preservam o histórico.',
  'Cada ação relevante fica registrada para o administrador, inclusive tentativas de acesso negadas.',
  'Chaves de API são somente leitura, guardadas apenas como hash e revogáveis a qualquer momento.',
  'Acessos de convite expiram e funcionam uma única vez; tentativas de login são limitadas em todas as instâncias.',
  'Verificação em duas etapas, passkeys, alerta de aparelho novo, e-mail trocado só depois de confirmado e exportação/encerramento da própria conta.',
]

const FAQ = [
  { q: 'A Ethos emite boleto?', a: 'Sim, de dois jeitos: pelo Asaas (que você conecta com a sua conta) ou de forma manual, sem integração, registrando um boleto que você emitiu no seu banco ou gerando uma guia de cobrança (que não é um boleto bancário). Vale um a um ou em lote, a partir das cobranças. O pagamento é registrado na Ethos, que cuida da baixa, do recibo e do repasse. Pix e baixa automática estão no roteiro.' },
  { q: 'Os contratos têm validade jurídica?', a: 'Você usa o modelo aprovado pela sua administração ou pelo seu jurídico. A Ethos preenche os dados e guarda o documento emitido, mas não presume a validade de cláusulas.' },
  { q: 'Já tenho minha base em planilhas. Dá para trazer?', a: 'Dá. Você envia arquivos CSV de proprietários, inquilinos, imóveis e unidades — vários de uma vez —, confere o que será criado e só então importa. Quem já existe não é duplicado.' },
  { q: 'Como meus clientes acessam?', a: 'Pelo convite que você gera na página Equipe, já vinculado ao cadastro da pessoa. Cada um enxerga só o que é seu.' },
  { q: 'Dá para integrar com outros sistemas?', a: 'Sim, para consulta: a API tem documentação aberta e as chaves de API são somente leitura. Operações de escrita ficam no painel, por enquanto.' },
]

const MODULES = ['Imóveis', 'Unidades', 'Contratos', 'Financeiro', 'Recibos', 'Repasses', 'Manutenção', 'Vistorias', 'Comunicados', 'Área do cliente', 'Importação em massa', 'API', 'Registro de atividades']

/** Efeito de "holofote" nos cartões: a luz acompanha o mouse. */
function spotlight(e: MouseEvent<HTMLElement>) {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.feature, .audience')
  if (!card) return
  const r = card.getBoundingClientRect()
  card.style.setProperty('--mx', `${e.clientX - r.left}px`)
  card.style.setProperty('--my', `${e.clientY - r.top}px`)
}

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` })
const idx = (i: number) => ({ '--i': i }) as CSSProperties

export default function LandingPage() {
  return (
    <PublicLayout route="home">
      <section className="hero">
        <div className="hero-bg" aria-hidden="true">
          <span className="blob b1" />
          <span className="blob b2" />
          <span className="blob b3" />
          <span className="grid-lines" />
        </div>
        <div className="hero-text">
          <span className="eyebrow pop-in"><span className="live-dot" />Gestão imobiliária</span>
          <h1 className="pop-in" style={delay(80)}>
            Administração de imóveis <span className="grad-text">sem planilhas</span> e sem retrabalho.
          </h1>
          <p className="lead pop-in" style={delay(180)}>
            A Ethos reúne cadastros, contratos, cobranças, vistorias e manutenção em um só lugar — e dá a inquilinos e proprietários uma área própria para
            acompanhar tudo.
          </p>
          <div className="cta-row pop-in" style={delay(280)}>
            <button className="primary big shine" onClick={() => go('register')}>Começar agora <span className="arrow" aria-hidden="true">→</span></button>
            <button className="big" onClick={() => go('login')}>Já tenho conta</button>
            <button className="link" onClick={() => scrollTo('funcionalidades')}>Ver funcionalidades ↓</button>
          </div>
          <p className="muted small pop-in" style={delay(360)}>Crie sua conta, cadastre a primeira organização e convide a sua equipe.</p>
        </div>

        <div className="mock float" role="img" aria-label="Exemplo ilustrativo do painel financeiro, com dados fictícios">
          <div className="mock-bar"><span /><span /><span /></div>
          <div className="mock-cards">
            <div><small>Previsto</small><strong>R$ <Counter to={85000} /></strong></div>
            <div><small>Recebido</small><strong>R$ <Counter to={72250} /></strong><em>85%</em></div>
            <div className="bad"><small>Em atraso</small><strong>R$ <Counter to={12750} /></strong></div>
          </div>
          <div className="mock-progress" aria-hidden="true"><span /></div>
          <div className="mock-list">
            <div style={idx(0)}><span>Apto 101 · Carlos A.</span><b className="ok">Paga</b></div>
            <div style={idx(1)}><span>Apto 102 · Beatriz L.</span><b className="ok">Paga</b></div>
            <div style={idx(2)}><span>Casa 1 · Rafael C.</span><b className="late">Em atraso</b></div>
            <div style={idx(3)}><span>Casa 2 · Juliana M.</span><b className="open">Em aberto</b></div>
          </div>
          <div className="mock-foot">Exemplo ilustrativo · dados fictícios</div>
          <span className="chip chip-a" aria-hidden="true">✓ Recibo emitido</span>
          <span className="chip chip-b" aria-hidden="true">● Lembrete enviado</span>
        </div>
      </section>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[...MODULES, ...MODULES].map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      </div>

      <section className="stats-strip">
        {[
          { n: 8, suffix: '', label: 'módulos integrados' },
          { n: 4, suffix: '', label: 'perfis de acesso' },
          { n: 100, suffix: '%', label: 'das alterações com registro' },
          { n: 0, suffix: '', label: 'planilhas para manter' },
        ].map((x, i) => (
          <Reveal key={x.label} delay={i * 90} className="stat-pub">
            <strong><Counter to={x.n} suffix={x.suffix} /></strong>
            <span>{x.label}</span>
          </Reveal>
        ))}
      </section>

      <section id="funcionalidades" className="pub-section">
        <Reveal as="h2">Tudo o que a administração precisa, no mesmo lugar</Reveal>
        <Reveal as="p" className="section-lead" delay={80}>Cada módulo conversa com os outros: o contrato gera a cobrança, o pagamento gera o recibo, o recibo alimenta o repasse.</Reveal>
        <div className="feature-grid" onMouseMove={spotlight}>
          {FEATURES.map((f, i) => (
            <Reveal as="article" key={f.title} className="feature" delay={(i % 4) * 80}>
              <span className="feature-icon"><Icon name={f.icon} /></span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="pub-section alt">
        <Reveal as="h2">Como funciona</Reveal>
        <ol className="steps">
          {[
            ['1', 'Cadastre a operação', 'Proprietários, imóveis, unidades e inquilinos — um por um ou importando planilhas. Convide a equipe por link.'],
            ['2', 'Formalize e cobre', 'Gere o contrato a partir do seu modelo e crie as cobranças do mês de uma vez.'],
            ['3', 'Acompanhe com os clientes', 'Registre recebimentos, faça vistorias, resolva chamados e repasse aos proprietários.'],
          ].map(([n, t, p], i) => (
            <Reveal as="li" key={n} delay={i * 120}>
              <span>{n}</span>
              <h3>{t}</h3>
              <p>{p}</p>
            </Reveal>
          ))}
        </ol>
      </section>

      <section id="para-quem" className="pub-section">
        <Reveal as="h2">Para quem é</Reveal>
        <div className="audience-grid" onMouseMove={spotlight}>
          {AUDIENCES.map((a, i) => (
            <Reveal as="article" key={a.title} className="audience" delay={i * 110}>
              <h3>{a.title}</h3>
              <ul>
                {a.points.map((p) => (
                  <li key={p}><span className="tick"><Icon name="check" /></span>{p}</li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="seguranca" className="pub-section alt">
        <Reveal as="h2">Seus dados, separados e protegidos</Reveal>
        <Reveal as="p" className="section-lead" delay={80}>Segurança desde o desenho, não como acessório.</Reveal>
        <ul className="security-list">
          {SECURITY.map((s, i) => (
            <Reveal as="li" key={s} delay={i * 70}><span className="tick"><Icon name="shield" /></span>{s}</Reveal>
          ))}
        </ul>
      </section>

      <section className="pub-section">
        <Reveal as="h2">Integre com a sua operação</Reveal>
        <Reveal className="api-teaser" delay={80}>
          <div>
            <p className="section-lead" style={{ textAlign: 'left', margin: 0 }}>
              Consulte cadastros, contratos, cobranças, vistorias e chamados com chaves de API somente leitura. A documentação é aberta e segue o padrão OpenAPI.
            </p>
            <div className="cta-row"><button onClick={() => go('api')}>Ver documentação da API</button></div>
          </div>
          <pre className="code">{'curl -H "Authorization: Bearer SUA_CHAVE" \\\n  "https://seu-dominio/api/charges?status=vencida"'}</pre>
        </Reveal>
      </section>

      <section className="pub-section alt">
        <Reveal as="h2">Perguntas frequentes</Reveal>
        <div className="faq">
          {FAQ.map((f, i) => (
            <Reveal key={f.q} delay={i * 70}>
              <details>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            </Reveal>
          ))}
        </div>
        <p className="muted small" style={{ textAlign: 'center' }}>No roteiro: Pix, baixa automática de boletos, e notificações por e-mail e WhatsApp.</p>
      </section>

      <section className="cta-banner">
        <Reveal as="h2">Pronto para organizar a sua administração?</Reveal>
        <Reveal as="p" delay={80}>Crie a conta da sua organização e comece a cadastrar hoje.</Reveal>
        <Reveal className="cta-row center" delay={160}>
          <button className="primary big shine" onClick={() => go('register')}>Criar conta <span className="arrow" aria-hidden="true">→</span></button>
          <button className="big" onClick={() => go('login')}>Entrar</button>
        </Reveal>
      </section>
    </PublicLayout>
  )
}
