import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'

export async function POST(req: NextRequest) {
  const { id, send_mail } = await req.json()
  if (!id) return NextResponse.json({ ok:false, error:'id obrigatório' }, { status:400 })
  try {
    const body:any = { id }
    if (send_mail != null) body.send_mail = send_mail
    const out = await siimp<any>('/invoices/send', { method:'POST', body })
    return NextResponse.json({ ok:true, ...out })
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e.message }, { status:400 })
  }
}
