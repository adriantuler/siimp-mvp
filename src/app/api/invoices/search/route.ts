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

// --------------------- utils DAC ---------------------
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

async function robustJson(res: Response): Promise<any | null> {
  const txt = await res.text().catch(() => '')
  if (!txt) return null
  try { return JSON.parse(txt) } catch { return null }
}

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

// --------------------- /person (nomes) ---------------------
function encodeFilter(obj: unknown) {
  return encodeURIComponent(JSON.stringify(obj))
}

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
  const str = (v: any) => (v === undefined ? null : v === null ? null : String(v))
  return {
    id: Number(r.id ?? r.invoice_id ?? r.ID),
    owner_id: r.owner_id != null ? Number(r.owner_id) : (r.owner?.owner_id ?? r.owner?.id ?? null),
    owner_name: r.owner_name ?? r.owner?.name ?? null,
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

async function upsertInvoices(rows: any[]): Promise<number> {
  if (!rows.length) return 0
  let wrote = 0
  await query('BEGIN')
  try {
    for (const r of rows) {
      const x = shapeDbRow(r)
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

// --------------------- BUSCA no Siimp com divisão por intervalo ---------------------
let RANGE_CALLS = 0

function nInt(v: string | null, def: number): number {
  if (!v) return def
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : def
}

/**
 * Faz 1 chamada ao Siimp para um intervalo [from..to].
 * Se voltar exatamente 40 (cap), divide o intervalo ao meio e tenta de novo (recursivo).
 */
async function fetchRangeRecursive(
  baseQs: URLSearchParams,
  from: number,
  to: number,
  depth = 0
): Promise<any[]> {
  const qs = new URLSearchParams(baseQs.toString())
  qs.set('number_from', String(from))
  qs.set('number_to', String(to))
  // OBS: Siimp ignora limit/page/start, então não insistimos aqui
  const path = '/invoices/search' + (qs.toString() ? `?${qs.toString()}` : '')
  const res = await siimp<any>(path, { method: 'GET' })
  RANGE_CALLS++
  const rows = normalizeToArray(res)

  // Se o retorno for <40, está “quebrado” o bastante.
  if (rows.length < 40) return rows

  // Se foi 40 e o range tem mais de 1 número, divide e busca as metades.
  if (from < to && rows.length === 40) {
    // evita recursão infinita
    if (depth > 20) return rows
    const mid = Math.floor((from + to) / 2)
    const left = await fetchRangeRecursive(baseQs, from, mid, depth + 1)
    const right = await fetchRangeRecursive(baseQs, mid + 1, to, depth + 1)
    return [...left, ...right]
  }

  return rows
}

/**
 * Decide estratégia de busca:
 * - Se vierem number_from/number_to -> usa divisão por intervalo (garante >40).
 * - Caso contrário, faz apenas 1 fetch “simples”.
 */
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

  // fallback: uma chamada simples (vai trazer até 40)
  const path = '/invoices/search' + (baseQs.toString() ? `?${baseQs.toString()}` : '')
  const res = await siimp<any>(path, { method: 'GET' })
  return { rows: normalizeToArray(res), strategy: 'single' }
}

// --------------------- CORE ---------------------
export async function GET(req: NextRequest) {
  try {
    RANGE_CALLS = 0

    // 1) BUSCA (com divisão por intervalo quando houver number_from/number_to)
    const { rows, strategy } = await fetchAllFromSiimp(req)

    // 2) ENRICH + completar owner_name via /person
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

    const withKeys = enriched.map((r: any) => ({
      ...r,
      owner_id:   r.owner_id   ?? null,
      owner_name: r.owner_name ?? null,
      cte_id:     r.cte_id     ?? null,
      serie:      r.serie      ?? null,
      number:     r.number     ?? null,
    }))

    // 3) UPSERT no Neon
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
  // mesmo comportamento do GET (mantém compat)
  return GET(req as unknown as NextRequest)
}
