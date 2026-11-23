import type { Condition, InspStatus, InspType, MaintStatus, Priority } from './workApi'

export const MAINT_STATUS: Record<MaintStatus, string> = {
  aberta: 'Aberta',
  em_analise: 'Em análise',
  aguardando_aprovacao: 'Aguardando aprovação',
  aprovada: 'Aprovada',
  em_execucao: 'Em execução',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
}

export const PRIORITY: Record<Priority, string> = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' }

export const CATEGORY: Record<string, string> = {
  hidraulica: 'Hidráulica',
  eletrica: 'Elétrica',
  estrutural: 'Estrutural',
  pintura: 'Pintura',
  fechaduras: 'Fechaduras',
  eletrodomesticos: 'Eletrodomésticos',
  pragas: 'Pragas',
  outro: 'Outro',
}

export const INSP_TYPE: Record<InspType, string> = { entrada: 'Entrada', saida: 'Saída', periodica: 'Periódica' }
export const INSP_STATUS: Record<InspStatus, string> = {
  agendada: 'Agendada',
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
}
export const CONDITION: Record<Condition, string> = { novo: 'Novo', bom: 'Bom', regular: 'Regular', ruim: 'Ruim', danificado: 'Danificado' }
export const CONDITIONS = Object.keys(CONDITION) as Condition[]

export const ROLE_NAME = { vistoriador: 'Vistoriador', locatario: 'Locatário', proprietario: 'Proprietário' } as const

export const SIGN_NOTE = 'O registro de ciência guarda o nome informado e a data; não é uma assinatura eletrônica qualificada.'

/** Itens agrupados por ambiente, na ordem original. */
export function groupByRoom<T extends { room: string }>(items: T[]): [string, T[]][] {
  const groups: [string, T[]][] = []
  for (const it of items) {
    const last = groups.at(-1)
    if (last && last[0] === it.room) last[1].push(it)
    else groups.push([it.room, [it]])
  }
  return groups
}
