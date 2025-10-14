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
    const origin = req.nextUrl.origin

    // usa os mesmos filtros que você usa no front (se não vier nada, usa defaults)
    const qs = req.nextUrl.searchParams
    if (!qs.has('status')) qs.set('status', '0')
    if (!qs.has('number_from')) qs.set('number_from', '1')
    if (!qs.has('number_to')) qs.set('number_to', '1000')

    const url = `${origin}/api/invoices/search?${qs.toString()}`
    const res = await fetch(url, { headers: { 'x-internal-cron': '1' }, cache: 'no-store' })
    const json: any = await res.json()

    if (!res.ok || !json?.ok) {
      const msg = json?.error ?? `Falha ao buscar ${url} (HTTP ${res.status})`
      return NextResponse.json({ ok: false, error: msg }, { status: 500 })
    }

    const list = Array.isArray(json.data) ? json.data : []
    await ensureSchema()
    await upsertMany(normalizeRows(list))

    return NextResponse.json({ ok: true, synced: list.length }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'erro no sync' }, { status: 500 })
  }
}
