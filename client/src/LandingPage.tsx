import { useEffect, type ReactNode } from 'react'

import { go, type PublicRoute } from './routes'

const YEAR = new Date().getFullYear()

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

type IconName = 'building' | 'file' | 'wallet' | 'camera' | 'wrench' | 'users' | 'shield' | 'code' | 'check'

const ICONS: Record<IconName, ReactNode> = {
  building: <><path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16" /><path d="M14 9h5a1 1 0 0 1 1 1v11" /><path d="M8 8h2M8 12h2M8 16h2M3 21h18" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
  wallet: <><path d="M3 7a2 2 0 0 1 2-2h13v4" /><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z" /><circle cx="16" cy="14" r="1" /></>,
  camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  wrench: <><path d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-2.6-.6-.6-2.6z" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.5" /><path d="M17 14a5 5 0 0 1 4 5" /></>,
  shield: <><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  code: <><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" /></>,
  check: <path d="M5 12l4 4 10-10" />,
}

function Icon({ name }: { name: IconName }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

/** Cabeçalho e rodapé das páginas públicas (home e documentação da API). */
export function PublicLayout({ children, route }: { children: ReactNode; route: PublicRoute }) {
  useEffect(() => {
    document.title = route === 'api' ? 'API — Ethos' : 'Ethos — Administração de imóveis'
  }, [route])

  const toSection = (id: string) => () => {
    if (route !== 'home') {
      go('home')
      setTimeout(() => scrollTo(id), 80)
    } else scrollTo(id)
  }

  return (
    <div className="pub">
      <header className="pub-header">
        <button className="pub-brand" onClick={() => go('home')} aria-label="Ethos — página inicial">Ethos</button>
        <nav className="pub-nav" aria-label="Principal">
          <button onClick={toSection('funcionalidades')}>Funcionalidades</button>
          <button onClick={toSection('para-quem')}>Para quem é</button>
          <button onClick={toSection('seguranca')}>Segurança</button>
          <button className={route === 'api' ? 'active' : ''} onClick={() => go('api')}>API</button>
        </nav>
        <div className="pub-actions">
          <button onClick={() => go('login')}>Entrar</button>
          <button className="primary" onClick={() => go('register')}>Começar agora</button>
        </div>
      </header>
      <main className="pub-main">{children}</main>
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
        <p className="muted small pub-copy">© {YEAR} Ethos Administradora de Imóveis</p>
      </footer>
    </div>
  )
}

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'building', title: 'Imóveis e unidades', text: 'Cadastre imóveis, unidades locáveis, proprietários e inquilinos. Um imóvel pode ter várias unidades e mais de um proprietário.' },
  { icon: 'file', title: 'Contratos', text: 'Modelos com variáveis e versões, documentos emitidos que não mudam depois e controle de vigência — sem dois contratos vigentes na mesma unidade.' },
  { icon: 'wallet', title: 'Financeiro', text: 'Aluguéis do mês gerados de uma vez, baixas, recibos numerados, estornos com histórico e repasses ao proprietário já com a taxa de administração.' },
  { icon: 'camera', title: 'Vistorias', text: 'Checklist por ambiente com fotos, laudo e comparação entre entrada e saída. Depois de concluída, a vistoria não é mais alterada.' },
  { icon: 'wrench', title: 'Manutenção', text: 'Do chamado à conclusão: prioridade, responsável, orçamentos com aprovação, fotos e uma linha do tempo de tudo o que aconteceu.' },
  { icon: 'users', title: 'Área do cliente', text: 'O inquilino acompanha cobranças, recibos e contrato e abre chamados. O proprietário vê imóveis, repasses e vistorias.' },
  { icon: 'shield', title: 'Equipe e acessos', text: 'Convide pela internet, defina administradores e colaboradores e mantenha os dados de cada organização separados.' },
  { icon: 'code', title: 'API aberta', text: 'Documentação OpenAPI e chaves de API somente leitura para integrar a Ethos com os seus sistemas.' },
]

const AUDIENCES = [
  { title: 'Administradoras', points: ['Carteira inteira em um painel', 'Cobranças, recibos e repasses sem planilha', 'Equipe com papéis e histórico', 'Vistorias e chamados organizados por unidade'] },
  { title: 'Proprietários', points: ['Imóveis, ocupação e aluguel contratado', 'Repasses com valor bruto, taxa e líquido', 'Acompanhamento de chamados e custos', 'Laudos de vistoria dos seus imóveis'] },
  { title: 'Inquilinos', points: ['Cobranças, vencimentos e recibos', 'Contrato e documentos sempre à mão', 'Pedido de manutenção com fotos e acompanhamento', 'Confirmação de ciência dos laudos'] },
]

const SECURITY = [
  'Cada organização enxerga somente os próprios dados, sempre validado no servidor.',
  'Documentos, recibos e fotos são privados: só saem para quem está autenticado e tem vínculo.',
  'Clientes veem apenas o que pertence ao seu cadastro; o proprietário não recebe documentos pessoais do inquilino.',
  'Recibos, contratos emitidos e vistorias concluídas não podem ser editados; estornos preservam o histórico.',
  'Chaves de API são somente leitura, guardadas apenas como hash e revogáveis a qualquer momento.',
  'Acessos de convite expiram e funcionam uma única vez; tentativas de login são limitadas.',
]

const FAQ = [
  { q: 'A Ethos emite boleto ou Pix?', a: 'Ainda não. Hoje você registra o recebimento e a Ethos cuida da baixa, do recibo e do repasse. Boleto e Pix estão no roteiro.' },
  { q: 'Os contratos têm validade jurídica?', a: 'Você usa o modelo aprovado pela sua administração ou pelo seu jurídico. A Ethos preenche os dados e guarda o documento emitido, mas não presume a validade de cláusulas.' },
  { q: 'Como meus clientes acessam?', a: 'Pelo convite que você gera na página Equipe, já vinculado ao cadastro da pessoa. Cada um enxerga só o que é seu.' },
  { q: 'Dá para integrar com outros sistemas?', a: 'Sim, para consulta: a API tem documentação aberta e as chaves de API são somente leitura. Operações de escrita ficam no painel, por enquanto.' },
]

export default function LandingPage() {
  return (
    <PublicLayout route="home">
      <section className="hero">
        <div className="hero-text">
          <span className="eyebrow">Gestão imobiliária</span>
          <h1>Administração de imóveis sem planilhas e sem retrabalho.</h1>
          <p className="lead">
            A Ethos reúne cadastros, contratos, cobranças, vistorias e manutenção em um só lugar — e dá a inquilinos e proprietários uma área própria para
            acompanhar tudo.
          </p>
          <div className="cta-row">
            <button className="primary big" onClick={() => go('register')}>Começar agora</button>
            <button className="big" onClick={() => go('login')}>Já tenho conta</button>
            <button className="link" onClick={() => scrollTo('funcionalidades')}>Ver funcionalidades ↓</button>
          </div>
          <p className="muted small">Crie sua conta, cadastre a primeira organização e convide a sua equipe.</p>
        </div>

        <div className="mock" role="img" aria-label="Exemplo ilustrativo do painel financeiro, com dados fictícios">
          <div className="mock-bar"><span /><span /><span /></div>
          <div className="mock-cards">
            <div><small>Previsto</small><strong>R$ 85.000</strong></div>
            <div><small>Recebido</small><strong>R$ 72.250</strong><em>85%</em></div>
            <div className="bad"><small>Em atraso</small><strong>R$ 12.750</strong></div>
          </div>
          <div className="mock-list">
            <div><span>Apto 101 · Carlos A.</span><b className="ok">Paga</b></div>
            <div><span>Apto 102 · Beatriz L.</span><b className="ok">Paga</b></div>
            <div><span>Casa 1 · Rafael C.</span><b className="late">Em atraso</b></div>
            <div><span>Casa 2 · Juliana M.</span><b className="open">Em aberto</b></div>
          </div>
          <div className="mock-foot">Exemplo ilustrativo · dados fictícios</div>
        </div>
      </section>

      <section id="funcionalidades" className="pub-section">
        <h2>Tudo o que a administração precisa, no mesmo lugar</h2>
        <p className="section-lead">Cada módulo conversa com os outros: o contrato gera a cobrança, o pagamento gera o recibo, o recibo alimenta o repasse.</p>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article key={f.title} className="feature">
              <span className="feature-icon"><Icon name={f.icon} /></span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="pub-section alt">
        <h2>Como funciona</h2>
        <ol className="steps">
          <li><span>1</span><h3>Cadastre a operação</h3><p>Proprietários, imóveis, unidades e inquilinos. Convide a equipe por link.</p></li>
          <li><span>2</span><h3>Formalize e cobre</h3><p>Gere o contrato a partir do seu modelo e crie as cobranças do mês de uma vez.</p></li>
          <li><span>3</span><h3>Acompanhe com os clientes</h3><p>Registre recebimentos, faça vistorias, resolva chamados e repasse aos proprietários.</p></li>
        </ol>
      </section>

      <section id="para-quem" className="pub-section">
        <h2>Para quem é</h2>
        <div className="audience-grid">
          {AUDIENCES.map((a) => (
            <article key={a.title} className="audience">
              <h3>{a.title}</h3>
              <ul>
                {a.points.map((p) => (
                  <li key={p}><span className="tick"><Icon name="check" /></span>{p}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section id="seguranca" className="pub-section alt">
        <h2>Seus dados, separados e protegidos</h2>
        <p className="section-lead">Segurança desde o desenho, não como acessório.</p>
        <ul className="security-list">
          {SECURITY.map((s) => (
            <li key={s}><span className="tick"><Icon name="shield" /></span>{s}</li>
          ))}
        </ul>
      </section>

      <section className="pub-section">
        <h2>Integre com a sua operação</h2>
        <div className="api-teaser">
          <div>
            <p className="section-lead" style={{ textAlign: 'left', margin: 0 }}>
              Consulte cadastros, contratos, cobranças, vistorias e chamados com chaves de API somente leitura. A documentação é aberta e segue o padrão OpenAPI.
            </p>
            <div className="cta-row"><button onClick={() => go('api')}>Ver documentação da API</button></div>
          </div>
          <pre className="code">{`curl -H "Authorization: Bearer SUA_CHAVE" \\\n  "https://seu-dominio/api/charges?status=vencida"`}</pre>
        </div>
      </section>

      <section className="pub-section alt">
        <h2>Perguntas frequentes</h2>
        <div className="faq">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
        <p className="muted small" style={{ textAlign: 'center' }}>No roteiro: boleto e Pix, comunicados e aplicativo instalável (PWA).</p>
      </section>

      <section className="cta-banner">
        <h2>Pronto para organizar a sua administração?</h2>
        <p>Crie a conta da sua organização e comece a cadastrar hoje.</p>
        <div className="cta-row center">
          <button className="primary big" onClick={() => go('register')}>Criar conta</button>
          <button className="big" onClick={() => go('login')}>Entrar</button>
        </div>
      </section>
    </PublicLayout>
  )
}
