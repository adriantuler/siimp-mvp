// src/app/api/jobs/sync-invoices/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { ensureSchema, upsertMany, InvoiceRow } from '@/lib/invoices-store'

export const runtime = 'nodejs'
const DEFAULT_PAGE_SIZE = 40  // Siimp devolve 40 por página

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
    const sp = new URLSearchParams(req.nextUrl.searchParams)

    // mesmos defaults do front
    if (!sp.has('status')) sp.set('status', '0')
    if (!sp.has('number_from')) sp.set('number_from', '1')
    if (!sp.has('number_to')) sp.set('number_to', '1000')

    // força um limit "alto" (mesmo que o upstream ignore)
    sp.set('limit', '200')

    const origin = req.nextUrl.origin
    let page = Math.max(1, parseInt(sp.get('page') ?? '1', 10))
    let totalFetched = 0
    const all: any[] = []

    while (true) {
      sp.set('page', String(page))
      const url = `${origin}/api/invoices/search?${sp.toString()}`

      const res = await fetch(url, { cache: 'no-store', headers: { 'x-sync-job': '1' } })
      const json: any = await res.json().catch(() => ({}))

      const ok = res.ok && json?.ok !== false
      const items = ok && Array.isArray(json?.data) ? (json.data as any[]) : []

      all.push(...items)
      totalFetched += items.length

      // critério de parada robusto:
      // - 0 itens → acabou
      // - < 40 itens → última página parcial → acabou
      if (items.length === 0 || items.length < DEFAULT_PAGE_SIZE) break

      page += 1
      if (page > 5000) break // proteção
    }

    await ensureSchema()
    if (all.length) {
      await upsertMany(normalizeRows(all))
    }

    return NextResponse.json({
      ok: true,
      route: 'jobs/sync-invoices',
      fetched_pages: page,
      page_size_assumed: DEFAULT_PAGE_SIZE,
      fetched_total: totalFetched,
      wrote: all.length,
      sample_ids: all.slice(0, 5).map(r => r.id),
    })
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      route: 'jobs/sync-invoices',
      error: e?.message ?? 'erro no sync',
    }, { status: 500 })
  }
}
