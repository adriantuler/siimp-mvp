// src/app/api/jobs/sync-invoices/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { ensureSchema, upsertMany, InvoiceRow } from '@/lib/invoices-store'

export const runtime = 'nodejs'

// Normaliza o payload do /api/invoices/search em InvoiceRow
function normalizeRows(list: any[]): InvoiceRow[] {
  return list.map((r) => ({
    id: Number(r.id),
    owner_id: r.owner_id != null ? Number(r.owner_id) : null,
    invoice_number: String(r.invoice_number),
    invoice_status: Number(r.invoice_status),
    total: String(r.total),
    maturity: String(r.maturity),
    payment_form: Number(r.payment_form),
    created_at: String(r.created_at),
    invoice_obs: r.invoice_obs ?? null,
    cte_id: r.cte_id != null ? Number(r.cte_id) : null,
    serie: r.serie != null ? String(r.serie) : null,
    number: r.number != null ? Number(r.number) : null,
    raw: r,
  }))
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    // defaults do front, se não vierem
    if (!sp.has('status')) sp.set('status', '0')
    if (!sp.has('number_from')) sp.set('number_from', '1')
    if (!sp.has('number_to')) sp.set('number_to', '1000')

    const origin = req.nextUrl.origin
    const url = `${origin}/api/invoices/search?${sp.toString()}`

    // 1) Busca ENRIQUECIDA (reusa sua rota /api/invoices/search)
    const res = await fetch(url, { cache: 'no-store', headers: { 'x-sync-job': '1' } })
    const json: any = await res.json().catch(() => ({}))

    const ok = res.ok && json?.ok !== false
    const rows = ok && Array.isArray(json?.data) ? (json.data as any[]) : []

    // 2) Garante schema e persiste
    await ensureSchema()
    if (rows.length > 0) {
      await upsertMany(normalizeRows(rows))
    }

    // 3) Resposta com debug explícito (fica fácil saber se é a rota certa)
    return NextResponse.json({
      ok: true,
      route: 'jobs/sync-invoices',
      fetched_from: url,
      fetched: rows.length,
      wrote: rows.length,
      sample_ids: rows.slice(0, 5).map(r => r.id),
    })
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      route: 'jobs/sync-invoices',
      error: e?.message ?? 'erro no sync',
    }, { status: 500 })
  }
}
