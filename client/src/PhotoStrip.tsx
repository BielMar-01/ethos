import { useRef, useState } from 'react'
import { prepareImage } from './photos'

/** Miniaturas de fotos (privadas, via /api/photos/:id) com envio e remoção opcionais. */
export default function PhotoStrip({
  ids,
  onUpload,
  onDelete,
  label = 'Adicionar foto',
}: {
  ids: number[]
  onUpload?: (blob: Blob) => Promise<void>
  onDelete?: (id: number) => Promise<void>
  label?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function pick(files: FileList | null) {
    if (!files || !onUpload) return
    setBusy(true)
    setError('')
    try {
      for (const f of Array.from(files)) await onUpload(await prepareImage(f))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao enviar a foto')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="photo-strip">
      {ids.map((id) => (
        <span key={id} className="photo">
          <a href={`/api/photos/${id}`} target="_blank" rel="noreferrer" title="Abrir em tamanho real">
            <img src={`/api/photos/${id}`} alt={`Foto ${id}`} loading="lazy" />
          </a>
          {onDelete && (
            <button type="button" className="photo-x" aria-label={`Remover foto ${id}`} onClick={() => onDelete(id)}>
              ×
            </button>
          )}
        </span>
      ))}
      {onUpload && (
        <>
          <button type="button" className="photo-add" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Enviando…' : `+ ${label}`}
          </button>
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => pick(e.target.files)} />
        </>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  )
}
