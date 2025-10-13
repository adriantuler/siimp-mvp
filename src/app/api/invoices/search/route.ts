import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const query: Record<string, any> = {}
  for (const [k,v] of searchParams.entries()) query[k] = v

  try {
    const out = await siimp<any>('/invoices/search', { method:'GET', query })
    return NextResponse.json({ ok:true, ...out }) // preserva data/success/total
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e.message }, { status:400 })
  }
}
