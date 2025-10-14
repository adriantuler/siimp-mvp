// app/api/invoices/search/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'

export const runtime = 'nodejs'

const DAC_BASE_URL = process.env.DAC_BASE_URL ?? 'https://dac.s1mp.net'
const DAC_USERNAME = process.env.DAC_USERNAME
const DAC_PASSWORD = process.env.DAC_PASSWORD
const DAC_COOKIE   = process.env.DAC_COOKIE // ex.: "PHPSESSID=abc123"
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.DAC_ENRICH_CONCURRENCY ?? '4', 10))

// --------------------- utils ---------------------
function extractPhpSessId(setCookie: string | null): string | null {
  if (!setCookie) return null
  const m = /PHPSESSID=([^;]+)/i.exec(setCookie)
  return m?.[1] ? `PHPSESSID=${m[1]}` : null
}

async function getDacSessionCookie(): Promise<string> {
  if (DAC_COOKIE && DAC_COOKIE.trim()) return DAC_COOKIE.trim()

  if (DAC_USERNAME && DAC_PASSWORD) {
    const loginUrl = `${DAC_BASE_URL}/auth/login`
    const body = new URLSearchParams({ username: DAC_USERNAME, password: DAC_PASSWORD })
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: loginUrl,
      },
      body,
      redirect: 'manual',
    })
    const cookie = extractPhpSessId(res.headers.get('set-cookie'))
    if (cookie) return cookie
  }

  throw new Error('Sessão do DAC indisponível (configure DAC_COOKIE ou DAC_USERNAME/DAC_PASSWORD).')
}

type DacSlice = {
  owner_id: number | string | null
  cte_id: number | string | null
  serie: string | number | null
  number: number | string | null
}

// Lê sempre como texto e tenta JSON.parse (content-type do DAC pode vir errado)
async function robustJson(res: Response): Promise<any | null> {
  const txt = await res.text().catch(() => '')
  if (!txt) return null
  try { return JSON.parse(txt) } catch { return null }
}

// Busca owner_id / cte_id / serie / number para um ID no DAC
async function fetchDacSlice(id: number | string): Promise<DacSlice> {
  const cookie = await getDacSessionCookie()
  const url = new URL(`${DAC_BASE_URL}/invoice`)
  url.searchParams.set('id', String(id))
  url.searchParams.set('loadEdit', 'true')
  url.searchParams.set('page', '1')
  url.searchParams.set('start', '0')
  url.searchParams.set('limit', '40')
  // url.searchParams.set('_dc', Date.now().toString()) // opcional

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Cookie: cookie, // "PHPSESSID=..."
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${DAC_BASE_URL}/`,
      Accept: 'application/json, */*',
    },
  })

  const payload = await robustJson(res)

  if (!res.ok || !payload?.success || !Array.isArray(payload?.data) || payload.data.length === 0) {
    return { owner_id: null, cte_id: null, serie: null, number: null }
  }

  const rec = payload.data[0] || {}
  const docs: any[] = Array.isArray(rec.documents) ? rec.documents : []
  const doc = docs[0] || {}

  return {
    owner_id: rec.owner_id ?? rec?.owner?.id ?? null,
    cte_id:   doc?.cte_id ?? null,
    serie:    doc?.serie ?? null,
    number:   doc?.number ?? null,
  }
}

function normalizeToArray(base: any): any[] {
  if (Array.isArray(base)) return base
  if (Array.isArray(base?.data)) return base.data
  if (base && typeof base === 'object') return [base]
  return []
}

// map com limite de concorrência para não sobrecarregar o DAC
async function mapLimit<T, U>(
  arr: readonly T[],
  limit: number,
  iter: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  const ret = new Array<U>(arr.length)
  let i = 0
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++
      if (idx >= arr.length) break
      ret[idx] = await iter(arr[idx], idx)
    }
  })
  await Promise.all(workers)
  return ret
}

// --------------------- core ---------------------
async function runSearch(req: NextRequest) {
  // 1) busca no Siimp (GET com querystring ou POST com body)
  let base: any
  if (req.method === 'GET') {
    const qs = req.nextUrl.searchParams
    const path = '/invoices/search' + (qs.toString() ? `?${qs.toString()}` : '')
    base = await siimp<any>(path, { method: 'GET' })
  } else {
    const body = await req.json().catch(() => ({}))
    base = await siimp<any>('/invoices/search', { method: 'POST', body })
  }

  const rows = normalizeToArray(base)
  if (rows.length === 0) return []

  // 2) enriquece cada linha com dados do DAC (limitando concorrência)
  const enriched = await mapLimit(rows, MAX_CONCURRENCY, async (r: any) => {
    const id = r.id ?? r.invoice_id ?? r.ID
    if (!id) {
      return {
        ...r,
        owner_id: r.owner_id ?? null,
        cte_id:   r.cte_id   ?? null,
        serie:    r.serie    ?? null,
        number:   r.number   ?? null,
      }
    }
    const s = await fetchDacSlice(id).catch(() => ({ owner_id: null, cte_id: null, serie: null, number: null }))
    return {
      ...r,
      owner_id: r.owner_id ?? s.owner_id,
      cte_id:   r.cte_id   ?? s.cte_id,
      serie:    r.serie    ?? s.serie,
      number:   r.number   ?? s.number,
    }
  })

  // 3) garante que as chaves existam mesmo se algum enrich falhar
  const withKeys = enriched.map((r: any) => ({
    ...r,
    owner_id: r.owner_id ?? null,
    cte_id:   r.cte_id   ?? null,
    serie:    r.serie    ?? null,
    number:   r.number   ?? null,
  }))

  return withKeys
}

// --------------------- handlers ---------------------
export async function GET(req: NextRequest) {
  try {
    const data = await runSearch(req)
    return NextResponse.json({ ok: true, data }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'Erro no search' }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const data = await runSearch(req)
    return NextResponse.json({ ok: true, data }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'Erro no search' }, { status: 400 })
  }
}
