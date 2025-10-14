import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const status = sp.get('status') // "", "0", "1", ...
    const numberFrom = sp.get('number_from') // string
    const numberTo = sp.get('number_to')

    const where: string[] = []
    const args: any[] = []
    let i = 1

    if (status !== null && status !== '') {
      where.push(`invoice_status = $${i++}`)
      args.push(Number(status))
    }
    if (numberFrom) {
      where.push(`(invoice_number)::bigint >= $${i++}`)
      args.push(Number(numberFrom))
    }
    if (numberTo) {
      where.push(`(invoice_number)::bigint <= $${i++}`)
      args.push(Number(numberTo))
    }

    const sql = `
      SELECT id, owner_id, invoice_number, invoice_status, total,
             maturity, payment_form, created_at, invoice_obs,
             cte_id, serie, number
      FROM invoices
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (invoice_number)::bigint ASC
      LIMIT 10000
    `
    const { rows } = await query(sql, args)
    return NextResponse.json({ ok: true, data: rows }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'erro ao listar' }, { status: 500 })
  }
}
