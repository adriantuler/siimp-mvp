import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'

export async function POST(req: NextRequest) {
  const { id, ...rest } = await req.json()
  if (!id) return NextResponse.json({ ok:false, error:'id obrigatório' }, { status:400 })
  try {
    const out = await siimp<any>('/invoices/pay', { method:'POST', body: { id, ...rest } })
    return NextResponse.json({ ok:true, data: out })
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e.message }, { status:400 })
  }
}
