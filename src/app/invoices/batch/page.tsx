'use client'

import { useState, useMemo } from 'react'
import * as XLSX from 'xlsx'

type Row = {
  id: number
  action?: 'send' | 'pay' | 'cancel'
  reason?: string
  send_mail?: number | string
  // pay fields
  paid_at?: string
  value?: number | string
  wallet_id?: number | string
  payment_form?: number | string
  discount?: number | string
}

type Result = {
  id: number
  action: 'send'|'pay'|'cancel'
  ok: boolean
  message: string
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export default function InvoicesBatchPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [results, setResults] = useState<Result[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function normalizeHeader(s: string) {
    return s?.toString().trim().toLowerCase().replace(/\s+/g, '_')
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setResults([])
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = new Uint8Array(reader.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        // lê linhas como objetos
        const raw = XLSX.utils.sheet_to_json(ws, { raw: false })
        // normaliza headers -> lower + underscore
        const norm: Row[] = (raw as any[]).map((r) => {
          const obj: any = {}
          Object.keys(r).forEach((k) => (obj[normalizeHeader(k)] = r[k]))
          // coersões básicas
          if (obj.id != null) obj.id = Number(obj.id)
          if (obj.value != null) obj.value = Number(obj.value)
          if (obj.wallet_id != null) obj.wallet_id = Number(obj.wallet_id)
          if (obj.payment_form != null) obj.payment_form = Number(obj.payment_form)
          if (obj.discount != null) obj.discount = Number(obj.discount)
          if (obj.send_mail != null) obj.send_mail = Number(obj.send_mail)
          if (obj.action) {
            const a = String(obj.action).toLowerCase()
            if (a === 'emitir' || a === 'send') obj.action = 'send'
            else if (a === 'liquidar' || a === 'pay') obj.action = 'pay'
            else if (a === 'cancelar' || a === 'cancel') obj.action = 'cancel'
          }
          return obj as Row
        })
        setRows(norm.filter(r => !!r.id))
      } catch (err: any) {
        setError(`Falha ao ler planilha: ${err.message || err}`)
      }
    }
    reader.readAsArrayBuffer(file)
  }

  async function callAPI(action: 'send'|'pay'|'cancel', payload: any) {
    const path = action === 'send' ? '/api/invoices/send'
               : action === 'pay'  ? '/api/invoices/pay'
               :                     '/api/invoices/cancel'
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data?.error || data?.message || `HTTP ${res.status}`)
    }
    return data
  }

  function validateRowFor(action: 'send'|'pay'|'cancel', r: Row) {
    if (!r.id) return 'id ausente'
    if (action === 'pay') {
      if (!r.paid_at) return 'paid_at ausente (YYYY-MM-DD)'
      if (r.value == null) return 'value ausente'
      if (r.wallet_id == null) return 'wallet_id ausente'
      if (r.payment_form == null) return 'payment_form ausente'
      // discount é opcional
    }
    if (action === 'cancel') {
      if (!r.reason) return 'reason ausente'
      // send_mail opcional
    }
    return null
  }

  async function runBatch(action?: 'send'|'pay'|'cancel') {
    if (rows.length === 0) {
      setError('Nenhuma linha carregada.')
      return
    }
    setBusy(true); setError(null); setResults([])
    const out: Result[] = []

    // determina quais linhas rodar
    const batch = action
      ? rows.map(r => ({ ...r, action })) // aplica a mesma ação a todas
      : rows.filter(r => r.action)        // usa a coluna 'action' da planilha

    if (batch.length === 0) {
      setBusy(false)
      setError(action
        ? 'Nenhuma linha válida.'
        : 'Nenhuma linha com coluna "action" (send/pay/cancel).')
      return
    }

    for (let i = 0; i < batch.length; i++) {
      const r = batch[i]
      const act = (r.action || action) as 'send'|'pay'|'cancel'
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
      } catch (e:any) {
        out.push({ id: r.id, action: act, ok: false, message: e.message })
      }
      setResults([...out])

      // respeita ~60 req/min da API Siimp
      await sleep(1100)
    }

    setBusy(false)
  }

  const preview = useMemo(() => rows.slice(0, 10), [rows])

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Lotes por Excel</h1>

      <div className="space-y-2">
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={handleFile}
          className="block"
        />
        <p className="text-sm text-gray-600">
          Colunas suportadas: <code>id</code> (obrigatória),
          <code> action</code> (send/pay/cancel, opcional),
          <code> reason</code>, <code> send_mail</code>,
          <code> paid_at</code>, <code> value</code>, <code> wallet_id</code>,
          <code> payment_form</code>, <code> discount</code>.
        </p>
      </div>

      <div className="flex gap-2 flex-wrap">
        <button
          disabled={busy || rows.length===0}
          onClick={() => runBatch('send')}
          className="px-3 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
        >Emitir (todas as linhas)</button>

        <button
          disabled={busy || rows.length===0}
          onClick={() => runBatch('pay')}
          className="px-3 py-2 rounded bg-green-600 text-white disabled:opacity-50"
        >Liquidar (todas as linhas)</button>

        <button
          disabled={busy || rows.length===0}
          onClick={() => runBatch('cancel')}
          className="px-3 py-2 rounded bg-red-600 text-white disabled:opacity-50"
        >Cancelar (todas as linhas)</button>

        <button
          disabled={busy || rows.length===0}
          onClick={() => runBatch(undefined)}
          className="px-3 py-2 rounded bg-gray-700 text-white disabled:opacity-50"
        >Usar coluna "action" da planilha</button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded">{error}</div>
      )}

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
