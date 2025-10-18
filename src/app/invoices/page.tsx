'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type Invoice = {
  id: number
  owner_id?: number | string | null
  invoice_number: string
  invoice_status: 0 | 1 | 2 | 3
  total: string
  maturity: string
  payment_form: number
  created_at: string
  invoice_obs?: string | null
  cte_id?: number | string | null
  serie?: string | number | null
  number?: number | string | null
}

const STATUS_MAP: Record<number, string> = {
  0: 'Cadastrada',
  1: 'Liquidada',
  2: 'Cancelada',
  3: 'Emitida',
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}
function toArray<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[]
  if (isObj(x)) return [x as T]
  return []
}

export default function InvoicesPage() {
  const [rows, setRows] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<{wrote?:number; fetched_total?:number; strategy?:string} | null>(null)

  // filtros
  const [status, setStatus] = useState<string>('0')
  const [numFrom, setNumFrom] = useState<string>('1')
  const [numTo, setNumTo] = useState<string>('1000')

  async function fetchData() {
    setLoading(true)
    setError(null)
    setMeta(null)
    try {
      const qs = new URLSearchParams()
      if (status !== '') qs.set('status', status)
      if (numFrom) qs.set('number_from', numFrom)
      if (numTo) qs.set('number_to', numTo)

      // >>> chama o SEARCH (e não mais /list)
      const res = await fetch(`/api/invoices/search?${qs.toString()}`, { cache: 'no-store' })
      const json: unknown = await res.json().catch(() => ({}))

      if (!res.ok || (isObj(json) && (json as any).ok === false)) {
        const msg = isObj(json) && typeof (json as any).error === 'string' ? (json as any).error : 'Falha na busca'
        throw new Error(msg)
      }

      const j = json as any
      const list = toArray<Invoice>(j.data)
      setRows(list)
      setMeta({ wrote: j.wrote, fetched_total: j.fetched_total, strategy: j.strategy })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void fetchData() }, []) // carrega na entrada

  const totalByStatus = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const r of rows) {
      const k = STATUS_MAP[r.invoice_status] ?? String(r.invoice_status)
      acc[k] = (acc[k] ?? 0) + 1
    }
    return acc
  }, [rows])

  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(v))

  return (
    <main className="p-6 space-y-6">
      <nav className="mb-4 flex gap-2">
        <Link
          href="/invoices/batch"
          className="inline-block px-3 py-2 rounded bg-purple-600 text-white hover:opacity-90"
        >
          Processar em lote (Excel/CSV)
        </Link>
      </nav>

      <header className="flex items-end gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">Faturas</h1>

        <label className="text-sm">
          Status:&nbsp;
          <select
            className="border px-2 py-1 rounded"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">(todos)</option>
            <option value="0">Cadastrada</option>
            <option value="1">Liquidada</option>
            <option value="2">Cancelada</option>
            <option value="3">Emitida</option>
          </select>
        </label>

        <label className="text-sm">
          Nº de:&nbsp;
          <input
            className="border px-2 py-1 rounded w-24"
            value={numFrom}
            onChange={(e) => setNumFrom(e.target.value)}
            placeholder="from"
          />
        </label>

        <label className="text-sm">
          até:&nbsp;
          <input
            className="border px-2 py-1 rounded w-24"
            value={numTo}
            onChange={(e) => setNumTo(e.target.value)}
            placeholder="to"
          />
        </label>

        <button
          onClick={() => void fetchData()}
          className="px-3 py-2 rounded bg-blue-600 text-white disabled:opacity-60"
          disabled={loading}
        >
          {loading ? 'Sincronizando…' : 'Buscar'}
        </button>
      </header>

      {meta && (
        <div className="text-sm text-gray-700">
          <strong>Sincronizado:</strong> {meta.fetched_total ?? rows.length} itens
          {typeof meta.wrote === 'number' && <> • <strong>Gravados</strong>: {meta.wrote}</>}
          {meta.strategy && <> • <strong>Estratégia</strong>: {meta.strategy}</>}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded">
          {error}
        </div>
      )}

      <div className="text-sm text-gray-700">
        <strong>Total exibido:</strong> {rows.length}{' '}
        {Object.keys(totalByStatus).length > 0 && (
          <span className="ml-2">
            • {Object.entries(totalByStatus).map(([k, v]) => `${k}: ${v}`).join(' • ')}
          </span>
        )}
      </div>

      <div className="overflow-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100">
            <tr className="[&>th]:px-3 [&>th]:py-2 text-left">
              <th>ID</th>
              <th>OwnerID</th>
              <th>Nº NF</th>
              <th>Status</th>
              <th>Total</th>
              <th>Vencimento</th>
              <th>Forma</th>
              <th>Criada em</th>
              <th>CT-e ID</th>
              <th>Série Doc</th>
              <th>Nº Doc</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="even:bg-gray-50 [&>td]:px-3 [&>td]:py-2">
                <td className="font-mono">{r.id}</td>
                <td className="font-mono">{show(r.owner_id)}</td>
                <td>{r.invoice_number}</td>
                <td>{STATUS_MAP[r.invoice_status] ?? r.invoice_status}</td>
                <td>R$ {r.total}</td>
                <td>{r.maturity}</td>
                <td>{r.payment_form}</td>
                <td>{r.created_at}</td>
                <td className="font-mono">{show(r.cte_id)}</td>
                <td>{show(r.serie)}</td>
                <td className="font-mono">{show(r.number)}</td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="text-center py-8 text-gray-500">
                  Sem resultados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  )
}
