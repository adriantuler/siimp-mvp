'use client'

import { useMemo, useState } from 'react'

type Action = 'send' | 'pay' | 'cancel'
type Row = {
  id: number
  action?: Action
  reason?: string
  send_mail?: number
  paid_at?: string
  value?: number
  wallet_id?: number
  payment_form?: number
  discount?: number
}

type Result = { id: number; action: Action; ok: boolean; message: string }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- helpers ----------------------------------------------------

function normalizeHeader(s: string) {
  return s?.toString().trim().toLowerCase().replace(/\s+/g, '_')
}

function parseCSV(text: string): Row[] {
  // parser simples (bom p/ planilhas exportadas)
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length === 0) return []
  const headers = lines[0].split(',').map(normalizeHeader)
  const rows: Row[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    const obj: any = {}
    headers.forEach((h, idx) => (obj[h] = parts[idx]))
    // coersões
    if (obj.id != null) obj.id = Number(obj.id)
    ;['value','wallet_id','payment_form','discount','send_mail'].forEach(k => {
      if (obj[k] != null && obj[k] !== '') obj[k] = Number(obj[k])
    })
    if (obj.action) {
      const a = String(obj.action).toLowerCase()
      obj.action = a === 'emitir' || a === 'send' ? 'send'
        : a === 'liquidar' || a === 'pay' ? 'pay'
        : 'cancel'
    }
    rows.push(obj as Row)
  }
  return rows.filter(r => !!r.id)
}

async function parseFile(file: File): Promise<Row[]> {
  const ext = file.name.toLowerCase().split('.').pop()
  if (ext === 'csv') {
    const text = await file.text()
    return parseCSV(text)
  }
  // XLSX dinamicamente (só no cliente)
  const { read, utils } = await import('xlsx')
  const data = new Uint8Array(await file.arrayBuffer())
  const wb = read(data, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw = utils.sheet_to_json<Record<string, unknown>>(ws, { raw: false })
  const out: Row[] = raw.map((r) => {
    const obj: any = {}
    Object.keys(r).forEach((k) => (obj[normalizeHeader(k)] = (r as any)[k]))
    if (obj.id != null) obj.id = Number(obj.id)
    ;['value','wallet_id','payment_form','discount','send_mail'].forEach(k => {
      if (obj[k] != null && obj[k] !== '') obj[k] = Number(obj[k])
    })
    if (obj.action) {
      const a = String(obj.action).toLowerCase()
      obj.action = a === 'emitir' || a === 'send' ? 'send'
        : a === 'liquidar' || a === 'pay' ? 'pay'
        : 'cancel'
    }
    return obj as Row
  })
  return out.filter(r => !!r.id)
}

async function callAPI(action: Action, payload: unknown) {
  const path =
    action === 'send' ? '/api/invoices/send'
    : action === 'pay' ? '/api/invoices/pay'
    : '/api/invoices/cancel'
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status}`)
  }
  return data
}

function validateRowFor(action: Action, r: Row) {
  if (!r.id) return 'id ausente'
  if (action === 'pay') {
    if (!r.paid_at) return 'paid_at ausente (YYYY-MM-DD)'
    if (r.value == null) return 'value ausente'
    if (r.wallet_id == null) return 'wallet_id ausente'
    if (r.payment_form == null) return 'payment_form ausente'
  }
  if (action === 'cancel') {
    if (!r.reason) return 'reason ausente'
  }
  return null
}

// ---- page component --------------------------------------------

export default function InvoicesBatchPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [results, setResults] = useState<Result[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null); setResults([])
    try {
      const parsed = await parseFile(f)
      setRows(parsed)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Falha ao ler arquivo: ${msg}`)
    }
  }

  async function runBatch(action?: Action) {
    if (rows.length === 0) { setError('Nenhuma linha carregada.'); return }
    setBusy(true); setError(null); setResults([])
    const out: Result[] = []

    const batch = action ? rows.map(r => ({ ...r, action })) : rows.filter(r => r.action)
    if (batch.length === 0) {
      setBusy(false)
      setError(action ? 'Nenhuma linha válida.' : 'Adicione coluna "action" (send/pay/cancel) ou use os botões de ação.')
      return
    }

    for (const r of batch) {
      const act = (r.action || action) as Action
      const inval = validateRowFor(act, r)
      if (inval) {
        out.push({ id: r.id, action: act, ok: false, message: inval })
        setResults([...out]); continue
      }
      try {
        const payload =
          act === 'send' ? { id: r.id } :
          act === 'cancel' ? { id: r.id, reason: r.reason, send_mail: r.send_mail ?? 0 } :
          { id: r.id, paid_at: r.paid_at, value: r.value, wallet_id: r.wallet_id,
            payment_form: r.payment_form, discount: r.discount ?? 0 }
        await callAPI(act, payload)
        out.push({ id: r.id, action: act, ok: true, message: 'OK' })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        out.push({ id: r.id, action: act, ok: false, message: msg })
      }
      setResults([...out])
      await sleep(1100) // ~60 req/min
    }
    setBusy(false)
  }

  const preview = useMemo(() => rows.slice(0, 10), [rows])

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Lotes por Excel / CSV</h1>

      <div className="space-y-2">
        <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} className="block" />
        <p className="text-sm text-gray-600">
          Colunas: <code>id</code> (obrigatório). Para <b>cancel</b>: <code>reason</code>, <code>send_mail</code>.
          Para <b>pay</b>: <code>paid_at</code>, <code>value</code>, <code>wallet_id</code>, <code>payment_form</code>, <code>discount</code>.
          Opcional: <code>action</code> (<code>send</code>/<code>pay</code>/<code>cancel</code>).
        </p>
      </div>

      <div className="flex gap-2 flex-wrap">
        <button disabled={busy || rows.length===0} onClick={() => runBatch('send')}
          className="px-3 py-2 rounded bg-blue-600 text-white disabled:opacity-50">Emitir (todas)</button>
        <button disabled={busy || rows.length===0} onClick={() => runBatch('pay')}
          className="px-3 py-2 rounded bg-green-600 text-white disabled:opacity-50">Liquidar (todas)</button>
        <button disabled={busy || rows.length===0} onClick={() => runBatch('cancel')}
          className="px-3 py-2 rounded bg-red-600 text-white disabled:opacity-50">Cancelar (todas)</button>
        <button disabled={busy || rows.length===0} onClick={() => runBatch(undefined)}
          className="px-3 py-2 rounded bg-gray-700 text-white disabled:opacity-50">{'Usar coluna "action"'}</button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded">{error}</div>}

      <section className="space-y-2">
        <h2 className="font-semibold">Prévia (até 10 linhas)</h2>
        <div className="overflow-auto border rounded">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100">
              <tr className="[&>th]:px-2 [&>th]:py-1 text-left">
                <th>id</th><th>action</th><th>reason</th><th>send_mail</th>
                <th>paid_at</th><th>value</th><th>wallet_id</th><th>payment_form</th><th>discount</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r,i)=>(
                <tr key={i} className="even:bg-gray-50 [&>td]:px-2 [&>td]:py-1">
                  <td className="font-mono">{r.id}</td>
                  <td>{r.action ?? ''}</td>
                  <td>{r.reason ?? ''}</td>
                  <td>{r.send_mail ?? ''}</td>
                  <td>{r.paid_at ?? ''}</td>
                  <td>{r.value ?? ''}</td>
                  <td>{r.wallet_id ?? ''}</td>
                  <td>{r.payment_form ?? ''}</td>
                  <td>{r.discount ?? ''}</td>
                </tr>
              ))}
              {rows.length===0 && (
                <tr><td colSpan={9} className="py-6 text-center text-gray-500">Nenhum arquivo carregado</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="text-sm text-gray-600">Linhas carregadas: {rows.length}</div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Resultados</h2>
        <div className="overflow-auto border rounded">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100">
              <tr className="[&>th]:px-2 [&>th]:py-1 text-left">
                <th>id</th><th>ação</th><th>status</th><th>mensagem</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r,i)=>(
                <tr key={i} className="even:bg-gray-50 [&>td]:px-2 [&>td]:py-1">
                  <td className="font-mono">{r.id}</td>
                  <td>{r.action}</td>
                  <td className={r.ok ? 'text-green-700' : 'text-red-700'}>{r.ok ? 'OK' : 'Erro'}</td>
                  <td className="break-all">{r.message}</td>
                </tr>
              ))}
              {results.length===0 && (
                <tr><td colSpan={4} className="py-6 text-center text-gray-500">Nada processado ainda</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {busy && <div className="text-sm text-gray-700">Processando… (respeitando ~60 req/min)</div>}
      </section>
    </main>
  )
}
