// app/api/invoices/search/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'
import { query } from '@/lib/db' // << ADICIONADO

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
  owner_name: string | null
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

// Busca owner_id / cte_id / serie / number (+ tenta owner_name) para um ID no DAC
async function fetchDacSlice(id: number | string): Promise<DacSlice> {
  const cookie = await getDacSessionCookie()
  const url = new URL(`${DAC_BASE_URL}/invoice`)
  url.searchParams.set('id', String(id))
  url.searchParams.set('loadEdit', 'true')
  url.searchParams.set('page', '1')
  url.searchParams.set('start', '0')
  url.searchParams.set('limit', '40')

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
    return { owner_id: null, owner_name: null, cte_id: null, serie: null, number: null }
  }

  const rec = payload.data[0] || {}
  const docs: any[] = Array.isArray(rec.documents) ? rec.documents : []
  const doc = docs[0] || {}

  const ownerIdCandidate = [
    rec.owner_id,
    rec?.owner_id,
    rec?.owner?.owner_id,
    rec?.owner?.id,
  ].find(v => v !== undefined && v !== null && v !== '')

  const ownerNameCandidate = rec?.owner?.name ?? rec?.owner_name ?? null

  return {
    owner_id: ownerIdCandidate ?? null,
    owner_name: ownerNameCandidate ?? null,
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

// Helpers para /person
function encodeFilter(obj: unknown) {
  return encodeURIComponent(JSON.stringify(obj))
}

// Busca nomes por uma lista de owner_ids no DAC /person
async function fetchOwnerNames(ids: number[]): Promise<Record<number, string>> {
  if (!ids.length) return {}
  const cookie = await getDacSessionCookie()
  const url = new URL(`${DAC_BASE_URL}/person`)
  url.searchParams.set('page', '1')
  url.searchParams.set('start', '0')
  url.searchParams.set('limit', String(Math.max(40, ids.length)))
  url.searchParams.set('filter', encodeFilter([{ property: 'ids', value: ids.join(',') }]))

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Cookie: cookie,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${DAC_BASE_URL}/`,
      Accept: 'application/json, */*',
    },
  })

  const payload = await robustJson(res)
  const out: Record<number, string> = {}
  if (res.ok && payload?.success && Array.isArray(payload?.data)) {
    for (const p of payload.data) {
      const k = Number(p?.id ?? p?.owner_id)
      const name = p?.name ?? p?.fancy_name ?? null
      if (k && name) out[k] = String(name)
    }
  }
  return out
}

// --------------------- persistência no Neon ---------------------

type DbRow = {
  id: number
  owner_id: number | null
  owner_name: string | null
  invoice_number: string | null
  invoice_status: number | null
  total: string | number | null
  maturity: string | null
  payment_form: number | null
  created_at: string | null
  invoice_obs: string | null
  cte_id: number | null
  serie: string | number | null
  number: number | string | null
}

function shapeDbRow(r: any): DbRow {
  const num = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v))
  const str = (v: any) => (v === undefined ? null : v === null ? null : String(v))

  return {
    id: Number(r.id ?? r.invoice_id ?? r.ID),
    owner_id: r.owner_id != null ? Number(r.owner_id) : (r.owner?.owner_id ?? r.owner?.id ?? null),
    owner_name: r.owner_name ?? r.owner?.name ?? null,
    invoice_number: str(r.invoice_number ?? r.number),
    invoice_status: r.invoice_status != null ? Number(r.invoice_status) : null,
    total: r.total ?? null, // string "0.01" já funciona no NUMERIC
    maturity: str(r.maturity ?? r.expiration ?? r.competency_date ?? null),
    payment_form: r.payment_form != null ? Number(r.payment_form) : null,
    created_at: str(r.created_at ?? null),
    invoice_obs: str(r.invoice_obs ?? null),
    cte_id: r.cte_id != null ? Number(r.cte_id) : null,
    serie: str(r.serie ?? null),
    number: r.number != null ? Number(r.number) : null,
  }
}

async function upsertInvoices(rows: any[]): Promise<number> {
  if (!rows.length) return 0
  let wrote = 0
  await query('BEGIN')
  try {
    for (const r of rows) {
      const x = shapeDbRow(r)
      // OBS: synced_at = NOW() sempre que salva
      await query(
        `
        INSERT INTO invoices (
          id, owner_id, owner_name, invoice_number, invoice_status, total,
          maturity, payment_form, created_at, invoice_obs,
          cte_id, serie, number, synced_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          owner_id = EXCLUDED.owner_id,
          owner_name = EXCLUDED.owner_name,
          invoice_number = EXCLUDED.invoice_number,
          invoice_status = EXCLUDED.invoice_status,
          total = EXCLUDED.total,
          maturity = EXCLUDED.maturity,
          payment_form = EXCLUDED.payment_form,
          created_at = EXCLUDED.created_at,
          invoice_obs = EXCLUDED.invoice_obs,
          cte_id = EXCLUDED.cte_id,
          serie = EXCLUDED.serie,
          number = EXCLUDED.number,
          synced_at = NOW()
        `,
        [
          x.id, x.owner_id, x.owner_name, x.invoice_number, x.invoice_status, x.total,
          x.maturity, x.payment_form, x.created_at, x.invoice_obs,
          x.cte_id, x.serie, x.number,
        ]
      )
      wrote++
    }
    await query('COMMIT')
    return wrote
  } catch (e) {
    await query('ROLLBACK')
    throw e
  }
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
  if (rows.length === 0) return { data: [], wrote: 0 }

  // 2) enriquece cada linha com dados do DAC (limitando concorrência)
  const enriched = await mapLimit(rows, MAX_CONCURRENCY, async (r: any) => {
    const id = r.id ?? r.invoice_id ?? r.ID
    if (!id) {
      return {
        ...r,
        owner_id:   r.owner_id ?? null,
        owner_name: r.owner_name ?? r?.owner?.name ?? null,
        cte_id:     r.cte_id   ?? null,
        serie:      r.serie    ?? null,
        number:     r.number   ?? null,
      }
    }
    const s = await fetchDacSlice(id).catch(() => ({
      owner_id: null, owner_name: null, cte_id: null, serie: null, number: null
    }))
    return {
      ...r,
      owner_id:   r.owner_id   ?? s.owner_id,
      owner_name: r.owner_name ?? r?.owner?.name ?? s.owner_name ?? null,
      cte_id:     r.cte_id     ?? s.cte_id,
      serie:      r.serie      ?? s.serie,
      number:     r.number     ?? s.number,
    }
  })

  // 2b) completa owner_name faltante consultando /person em lote
  const missingNameIds = Array.from(
    new Set(
      enriched
        .filter((r: any) => r.owner_id && !r.owner_name)
        .map((r: any) => Number(r.owner_id))
    )
  )
  if (missingNameIds.length) {
    const nameMap = await fetchOwnerNames(missingNameIds)
    for (const r of enriched) {
      if (r.owner_id && !r.owner_name) {
        const nm = nameMap[Number(r.owner_id)]
        if (nm) r.owner_name = nm
      }
    }
  }

  // 3) garante que as chaves existam mesmo se algum enrich falhar
  const withKeys = enriched.map((r: any) => ({
    ...r,
    owner_id:   r.owner_id   ?? null,
    owner_name: r.owner_name ?? null,
    cte_id:     r.cte_id     ?? null,
    serie:      r.serie      ?? null,
    number:     r.number     ?? null,
  }))

  // 4) SALVA NO BANCO (UPSERT)
  const wrote = await upsertInvoices(withKeys)

  return { data: withKeys, wrote }
}

// --------------------- handlers ---------------------
export async function GET(req: NextRequest) {
  try {
    const { data, wrote } = await runSearch(req)
    return NextResponse.json({ ok: true, wrote, data }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'Erro no search' }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { data, wrote } = await runSearch(req)
    return NextResponse.json({ ok: true, wrote, data }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'Erro no search' }, { status: 400 })
  }
}
