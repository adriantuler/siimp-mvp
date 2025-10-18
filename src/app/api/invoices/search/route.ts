// app/api/invoices/search/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'
import { query } from '@/lib/db'

export const runtime = 'nodejs'

const DAC_BASE_URL = process.env.DAC_BASE_URL ?? 'https://dac.s1mp.net'
const DAC_USERNAME = process.env.DAC_USERNAME
const DAC_PASSWORD = process.env.DAC_PASSWORD
const DAC_COOKIE   = process.env.DAC_COOKIE
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.DAC_ENRICH_CONCURRENCY ?? '4', 10))

// ---------- helpers ----------
const onlyDigits = (s: any) => (s == null ? null : String(s).replace(/\D+/g, '') || null)

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
  owner_cnpj: string | null
  cte_id: number | string | null
  serie: string | number | null
  number: number | string | null
}

async function robustJson(res: Response): Promise<any | null> {
  const txt = await res.text().catch(() => '')
  if (!txt) return null
  try { return JSON.parse(txt) } catch { return null }
}

// Busca no DAC /invoice
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
      Cookie: cookie,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${DAC_BASE_URL}/`,
      Accept: 'application/json, */*',
    },
  })
  const payload = await robustJson(res)
  if (!res.ok || !payload?.success || !Array.isArray(payload?.data) || payload.data.length === 0) {
    return { owner_id: null, owner_name: null, owner_cnpj: null, cte_id: null, serie: null, number: null }
  }

  const rec = payload.data[0] || {}
  const docs: any[] = Array.isArray(rec.documents) ? rec.documents : []
  const doc = docs[0] || {}

  const ownerIdCandidate = [
    rec.owner_id, rec?.owner_id, rec?.owner?.owner_id, rec?.owner?.id,
  ].find(v => v !== undefined && v !== null && v !== '')

  const ownerNameCandidate = rec?.owner?.name ?? rec?.owner_name ?? null
  const ownerCnpjDigits    = onlyDigits(rec?.owner?.cnpj ?? rec?.owner_cnpj ?? null)

  return {
    owner_id: ownerIdCandidate ?? null,
    owner_name: ownerNameCandidate ?? null,
    owner_cnpj: ownerCnpjDigits ?? null,
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

async function mapLimit<T, U>(arr: readonly T[], limit: number, iter: (item: T, index: number) => Promise<U>): Promise<U[]> {
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

// ---------- /person (nome + cnpj) ----------
function encodeFilter(obj: unknown) {
  return encodeURIComponent(JSON.stringify(obj))
}

async function fetchOwnerInfos(ids: number[]): Promise<Record<number, {name: string|null, cnpj: string|null}>> {
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
  const out: Record<number, {name: string|null, cnpj: string|null}> = {}
  if (res.ok && payload?.success && Array.isArray(payload?.data)) {
    for (const p of payload.data) {
      const k = Number(p?.id ?? p?.owner_id)
      const name = p?.name ?? p?.fancy_name ?? null
      const cnpj = onlyDigits(p?.cnpj ?? null)
      if (k) out[k] = { name: name ?? null, cnpj: cnpj ?? null }
    }
  }
  return out
}

// ---------- persistência ----------
type DbRow = {
  id: number
  owner_id: number | null
  owner_name: string | null
  owner_cnpj: string | null
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
  const str = (v: any) => (v === undefined ? null : v === null ? null : String(v))
  return {
    id: Number(r.id ?? r.invoice_id ?? r.ID),
    owner_id: r.owner_id != null ? Number(r.owner_id) : (r.owner?.owner_id ?? r.owner?.id ?? null),
    owner_name: r.owner_name ?? r.owner?.name ?? null,
    owner_cnpj: onlyDigits(r.owner_cnpj ?? r.owner?.cnpj ?? null),
    invoice_number: str(r.invoice_number ?? r.number),
    invoice_status: r.invoice_status != null ? Number(r.invoice_status) : null,
    total: r.total ?? null,
    maturity: str(r.maturity ?? r.expiration ?? r.competency_date ?? null),
    payment_form: r.payment_form != null ? Number(r.payment_form) : null,
    created_at: str(r.created_at ?? null),
    invoice_obs: str(r.invoice_obs ?? null),
    cte_id: r.cte_id != null ? Number(r.cte_id) : null,
    serie: str(r.serie ?? null),
    number: r.number != null ? Number(r.number) : null,
  }
}

let SCHEMA_OK = false
async function ensureSchema() {
  if (SCHEMA_OK) return
  await query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS owner_cnpj TEXT;`)
  await query(`CREATE INDEX IF NOT EXISTS idx_invoices_owner_cnpj ON invoices(owner_cnpj);`)
  SCHEMA_OK = true
}

async function upsertInvoices(rows: any[]): Promise<number> {
  if (!rows.length) return 0
  await ensureSchema()

  let wrote = 0
  await query('BEGIN')
  try {
    for (const r of rows) {
      const x = shapeDbRow(r)
      await query(
        `
        INSERT INTO invoices (
          id, owner_id, owner_name, owner_cnpj,
          invoice_number, invoice_status, total,
          maturity, payment_form, created_at, invoice_obs,
          cte_id, serie, number, synced_at
        ) VALUES (
          $1,$2,$3,$4,
          $5,$6,$7,
          $8,$9,$10,$11,
          $12,$13,$14, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          owner_id = EXCLUDED.owner_id,
          owner_name = EXCLUDED.owner_name,
          owner_cnpj = EXCLUDED.owner_cnpj,
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
          x.id, x.owner_id, x.owner_name, x.owner_cnpj,
          x.invoice_number, x.invoice_status, x.total,
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

// ---------- busca Siimp com divisão (>40) ----------
let RANGE_CALLS = 0
const nInt = (v: string | null, def: number) => (v && Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def)

async function fetchRangeRecursive(baseQs: URLSearchParams, from: number, to: number, depth = 0): Promise<any[]> {
  const qs = new URLSearchParams(baseQs.toString())
  qs.set('number_from', String(from))
  qs.set('number_to', String(to))
  const path = '/invoices/search' + (qs.toString() ? `?${qs.toString()}` : '')
  const res = await siimp<any>(path, { method: 'GET' })
  RANGE_CALLS++
  const rows = normalizeToArray(res)

  if (rows.length < 40) return rows
  if (from < to && rows.length === 40) {
    if (depth > 20) return rows
    const mid = Math.floor((from + to) / 2)
    const left = await fetchRangeRecursive(baseQs, from, mid, depth + 1)
    const right = await fetchRangeRecursive(baseQs, mid + 1, to, depth + 1)
    return [...left, ...right]
  }
  return rows
}

async function fetchAllFromSiimp(req: NextRequest): Promise<{ rows: any[], strategy: string }> {
  const baseQs = req.method === 'GET'
    ? new URLSearchParams(req.nextUrl.searchParams)
    : new URLSearchParams()

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    for (const [k, v] of Object.entries(body)) {
      if (v != null) baseQs.set(k, String(v))
    }
  }

  const hasRange = baseQs.has('number_from') || baseQs.has('number_to')
  if (hasRange) {
    const nFrom = nInt(baseQs.get('number_from'), 1)
    const nTo   = nInt(baseQs.get('number_to'), 999999)
    const rows = await fetchRangeRecursive(baseQs, Math.min(nFrom, nTo), Math.max(nFrom, nTo))
    return { rows, strategy: 'range' }
  }

  const path = '/invoices/search' + (baseQs.toString() ? `?${baseQs.toString()}` : '')
  const res = await siimp<any>(path, { method: 'GET' })
  return { rows: normalizeToArray(res), strategy: 'single' }
}

// ---------- CORE ----------
export async function GET(req: NextRequest) {
  try {
    RANGE_CALLS = 0

    // 1) BUSCA
    const { rows, strategy } = await fetchAllFromSiimp(req)

    // 2) ENRICH
    const enriched = await mapLimit(rows, MAX_CONCURRENCY, async (r: any) => {
      const id = r.id ?? r.invoice_id ?? r.ID
      if (!id) {
        return {
          ...r,
          owner_id:   r.owner_id ?? null,
          owner_name: r.owner_name ?? r?.owner?.name ?? null,
          owner_cnpj: onlyDigits(r.owner_cnpj ?? r?.owner?.cnpj ?? null),
          cte_id:     r.cte_id   ?? null,
          serie:      r.serie    ?? null,
          number:     r.number   ?? null,
        }
      }
      const s = await fetchDacSlice(id).catch(() => ({
        owner_id: null, owner_name: null, owner_cnpj: null, cte_id: null, serie: null, number: null
      }))
      return {
        ...r,
        owner_id:   r.owner_id   ?? s.owner_id,
        owner_name: r.owner_name ?? r?.owner?.name ?? s.owner_name ?? null,
        owner_cnpj: onlyDigits(r.owner_cnpj ?? r?.owner?.cnpj) ?? s.owner_cnpj ?? null,
        cte_id:     r.cte_id     ?? s.cte_id,
        serie:      r.serie      ?? s.serie,
        number:     r.number     ?? s.number,
      }
    })

    // 2b) completar owner_name/owner_cnpj via /person
    const missingInfoIds = Array.from(new Set(
      enriched.filter((r: any) => r.owner_id && (!r.owner_name || !r.owner_cnpj)).map((r: any) => Number(r.owner_id))
    ))
    if (missingInfoIds.length) {
      const infoMap = await fetchOwnerInfos(missingInfoIds)
      for (const r of enriched) {
        const info = r.owner_id ? infoMap[Number(r.owner_id)] : null
        if (info) {
          if (!r.owner_name && info.name) r.owner_name = info.name
          if (!r.owner_cnpj && info.cnpj) r.owner_cnpj = info.cnpj
        }
      }
    }

    const withKeys = enriched.map((r: any) => ({
      ...r,
      owner_id:   r.owner_id   ?? null,
      owner_name: r.owner_name ?? null,
      owner_cnpj: r.owner_cnpj ?? null,
      cte_id:     r.cte_id     ?? null,
      serie:      r.serie      ?? null,
      number:     r.number     ?? null,
    }))

    // 3) UPSERT
    const wrote = await upsertInvoices(withKeys)

    return NextResponse.json({
      ok: true,
      strategy,
      range_calls: RANGE_CALLS,
      fetched_total: withKeys.length,
      wrote,
      data: withKeys,
    }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'Erro no search' }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  return GET(req as unknown as NextRequest)
}
