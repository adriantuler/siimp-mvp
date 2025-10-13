import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'

export async function POST(req: NextRequest) {
  const { id, reason, send_mail } = await req.json()
  if (!id) return NextResponse.json({ ok:false, error:'id obrigatório' }, { status:400 })
  try {
    const out = await siimp<any>('/invoices/cancel', { method:'POST', body: { id, reason, send_mail } })
    return NextResponse.json({ ok:true, ...out })
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e.message }, { status:400 })
  }
}
