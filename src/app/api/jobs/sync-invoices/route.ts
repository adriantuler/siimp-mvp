// src/app/api/invoices/list/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { ensureSchema } from '@/lib/invoices-store'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    // garante que a tabela exista (idempotente)
    await ensureSchema()

    const sp = req.nextUrl.searchParams
    const status = sp.get('status')
    const numberFrom = sp.get('number_from')
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
    // se por algum motivo a tabela ainda não existe, cria e retorna vazio
    if (e?.code === '42P01') {
      await ensureSchema()
      return NextResponse.json({ ok: true, data: [] }, { status: 200 })
    }
    return NextResponse.json({ ok: false, error: e?.message ?? 'erro ao listar' }, { status: 500 })
  }
}
