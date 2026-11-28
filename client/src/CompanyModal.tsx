import { useEffect, useState, type FormEvent } from 'react'
import { api, type Company } from './api'
import { Alert, Loading, errorText, toast } from './feedback'
import Modal from './Modal'

const FIELDS: [keyof Company, string, string?][] = [
  ['legal_name', 'Razão social', 'Ethos Administradora de Imóveis Ltda'],
  ['cnpj', 'CNPJ', '00.000.000/0000-00'],
  ['creci', 'CRECI'],
  ['company_address', 'Endereço completo'],
  ['company_city', 'Cidade/UF', 'São Paulo, SP'],
  ['company_phone', 'Telefone'],
  ['company_whatsapp', 'WhatsApp'],
  ['company_email', 'E-mail'],
]
const LOGO_MAX = 90_000

/** Reduz a imagem no navegador até caber no limite, mantendo a transparência. */
async function toLogo(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Envie o logo em PNG, JPEG ou WebP.')
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    for (let width = Math.min(img.width, 640); width >= 160; width = Math.floor(width * 0.75)) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = Math.max(1, Math.round((img.height * width) / img.width))
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      const data = canvas.toDataURL('image/png')
      if (data.length <= LOGO_MAX) return data
    }
    throw new Error('Não foi possível reduzir o logo o suficiente. Use uma imagem mais simples.')
  } finally {
    URL.revokeObjectURL(url)
  }
}

export default function CompanyModal({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const [company, setCompany] = useState<Company | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.company().then((r) => setCompany(r.company)).catch((e) => setError(errorText(e)))
  }, [])

  const set = (key: keyof Company, value: string | null) => setCompany((c) => (c ? { ...c, [key]: value } : c))

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!company) return
    setBusy(true)
    setError('')
    try {
      const body = Object.fromEntries([...FIELDS.map(([k]) => k), 'logo_data' as const].map((k) => [k, company[k] || null]))
      await api.saveCompany(body)
      toast.success('Dados da empresa salvos. Valem para os próximos documentos.')
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Dados da empresa" subtitle="Aparecem no cabeçalho, no rodapé e nas variáveis dos contratos" size="md" onClose={onClose} locked={busy}>
      {!company ? (
        error ? <Alert>{error}</Alert> : <Loading label="Carregando…" />
      ) : (
        <form className="form-grid" onSubmit={save}>
          {FIELDS.map(([key, label, placeholder]) => (
            <label key={key}>
              {label}
              <input value={(company[key] as string | null) ?? ''} placeholder={placeholder} maxLength={300} disabled={!canEdit} type={key === 'company_email' ? 'email' : 'text'} onChange={(e) => set(key, e.target.value)} />
            </label>
          ))}
          <div className="span-all stack">
            <strong>Logo</strong>
            {company.logo_data ? (
              <img src={company.logo_data} alt="Logo atual" style={{ maxWidth: 260, maxHeight: 80, objectFit: 'contain', background: '#fff', padding: 8, borderRadius: 6 }} />
            ) : (
              <p className="muted small">Sem logo enviado: os documentos usam o símbolo provisório da casa com o nome. Envie o arquivo oficial (de preferência PNG com fundo transparente).</p>
            )}
            {canEdit && (
              <div className="inline">
                <label>
                  Enviar logo
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      setError('')
                      try {
                        set('logo_data', await toLogo(file))
                      } catch (err) {
                        setError(errorText(err))
                      }
                    }}
                  />
                </label>
                {company.logo_data && <button type="button" onClick={() => set('logo_data', null)}>Remover logo</button>}
              </div>
            )}
          </div>
          {error && <Alert className="span-all">{error}</Alert>}
          {!canEdit && <p className="muted small span-all">Só o administrador altera estes dados.</p>}
          <div className="actions">
            <button type="button" onClick={onClose}>Fechar</button>
            {canEdit && <button className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>}
          </div>
        </form>
      )}
    </Modal>
  )
}
