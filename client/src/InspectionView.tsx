import type { InspItem, InspSignature } from './workApi'
import { CONDITION, ROLE_NAME, groupByRoom } from './labels'
import { date } from './format'
import PhotoStrip from './PhotoStrip'

/** Checklist somente leitura (vistoria concluída). */
export function ReadOnlyChecklist({ items }: { items: InspItem[] }) {
  return (
    <>
      {groupByRoom(items).map(([room, list]) => (
        <div key={room}>
          <h4 className="room">{room}</h4>
          {list.map((it) => (
            <div key={it.id} className="check-row">
              <span>{it.item}</span>
              <span className={it.condition ? `cond-${it.condition}` : 'muted'}>{it.condition ? CONDITION[it.condition] : 'não avaliado'}</span>
              <span className="muted">{it.notes ?? ''}</span>
              {it.photos.length > 0 && <PhotoStrip ids={it.photos} />}
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

export function Signatures({ list }: { list: InspSignature[] }) {
  if (list.length === 0) return <p className="muted">Nenhuma ciência registrada ainda.</p>
  return (
    <ul className="timeline">
      {list.map((s) => (
        <li key={s.role}>
          <strong>{ROLE_NAME[s.role]}:</strong> {s.signer_name}
          <div className="meta">{date(new Date(s.signed_at).toLocaleDateString('sv-SE'))}</div>
        </li>
      ))}
    </ul>
  )
}

/** Laudo em texto, com impressão/PDF pelo navegador. */
export function ReportPaper({ report, onClose }: { report: string; onClose: () => void }) {
  return (
    <div className="panel print-area">
      <div className="paper-head no-print">
        <strong>Laudo de vistoria</strong>
        <div className="actions">
          <button onClick={onClose}>Fechar</button>
          <button className="primary" onClick={() => window.print()}>Imprimir / salvar PDF</button>
        </div>
      </div>
      <article className="paper">{report}</article>
    </div>
  )
}

