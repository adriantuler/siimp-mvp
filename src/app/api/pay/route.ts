import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body?.id) return NextResponse.json({ ok:false, error:'id obrigatório' }, { status:400 })
  try {
    const out = await siimp<any>('/invoices/pay', { method:'POST', body })
    return NextResponse.json({ ok:true, ...out })
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e.message }, { status:400 })
  }
}
