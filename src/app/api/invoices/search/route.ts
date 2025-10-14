import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'

type InvoiceOut = {
  id?: number
  owner_id?: number
  invoice_number?: string
  invoice_status?: number
  total?: string | number
  maturity?: string
  payment_form?: number
  created_at?: string
  invoice_obs?: string | null
}

// transforma qualquer forma em array
function toArray(x: unknown): unknown[] {
  if (Array.isArray(x)) return x
  if (x && typeof x === 'object' && Array.isArray((x as any).data)) return (x as any).data
  if (x && typeof x === 'object') return [x]
  return []
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const query: Record<string, string> = {}
    searchParams.forEach((v, k) => (query[k] = v))

    // Chama a API da Siimp
    const out = await siimp<any>('/invoices/search', { method: 'GET', query })
    // A Siimp costuma vir como { data: [...], success, total }
    const raw = (out as any)?.data ?? out
    const rows = toArray(raw) as InvoiceOut[]

    // Normaliza os campos para a UI
    const normalized = rows.map((r) => ({
      id: Number(r.id ?? 0),
      owner_id: Number(r.owner_id ?? 0),
      invoice_number: String((r as any).invoice_number ?? (r as any).number ?? ''),
      invoice_status: Number((r as any).invoice_status ?? (r as any).status ?? 0),
      total: String(r.total ?? ''),
      maturity: String(r.maturity ?? ''),
      payment_form: Number(r.payment_form ?? 0),
      created_at: String(r.created_at ?? ''),
      invoice_obs: r.invoice_obs ?? null,
    }))

    return NextResponse.json({
      ok: true,
      data: normalized,
      total: (out as any)?.total ?? normalized.length,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Erro inesperado'
    return NextResponse.json({ ok: false, error: msg }, { status: 400 })
  }
}
