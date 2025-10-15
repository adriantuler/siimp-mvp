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

// lê texto e tenta JSON (content-type pode vir errado)
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

// map com limite de concorrência
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

// --------------------- paginação no Siimp ---------------------
type SiimpPage = { data: any[]; total?: number }

async function fetchSiimpPage(
  baseQs: URLSearchParams,
  mode: 'page' | 'start',
  pageOrStart: number,
  limit: number
): Promise<SiimpPage> {
  const qs = new URLSearchParams(baseQs.toString())
  if (!qs.has('limit')) qs.set('limit', String(limit))
  if (mode === 'page') {
    qs.set('page', String(pageOrStart))
    qs.delete('start')
  } else {
    qs.set('start', String(pageOrStart))
    qs.delete('page')
  }

  const path = '/invoices/search' + (qs.toString() ? `?${qs.toString()}` : '')
  const res = await siimp<any>(path, { method: 'GET' })
  const rows = normalizeToArray(res)
  const total = typeof res?.total === 'number' ? res.total : undefined
  return { data: rows, total }
}

// --------------------- core ---------------------
async function runSearch(req: NextRequest) {
  const baseQs = req.method === 'GET'
    ? new URLSearchParams(req.nextUrl.searchParams)
    : new URLSearchParams()

  // se vier POST com body, mantemos a compatibilidade (mas a paginação é por GET)
  let bodyFromPost: any = {}
  if (req.method === 'POST') {
    bodyFromPost = await req.json().catch(() => ({}))
    for (const [k, v] of Object.entries(bodyFromPost)) {
      if (v != null) baseQs.set(k, String(v))
    }
  }

  const limit = Math.min(500, Math.max(1, parseInt(baseQs.get('limit') ?? '200', 10)))

  let fetched_pages = 0
  let fetched_total = 0
  let wrote_total = 0
  const allForResponse: any[] = []

  // 1ª tentativa: paginação por 'page'
  let mode: 'page' | 'start' = 'page'
  let page = 1

  while (true) {
    const { data, total } = await fetchSiimpPage(baseQs, mode, page, limit)
    if (!data.length) {
      // se na 1ª página de 'page' não veio nada, tente 'start'
      if (fetched_pages === 0 && page === 1 && mode === 'page') {
        mode = 'start'
        break
      }
      break
    }

    fetched_pages++
    fetched_total += data.length

    // enrich
    const enriched = await mapLimit(data, MAX_CONCURRENCY, async (r: any) => {
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

    // completa owner_name via /person
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

    // garante chaves
    const withKeys = enriched.map((r: any) => ({
      ...r,
      owner_id:   r.owner_id   ?? null,
      owner_name: r.owner_name ?? null,
      cte_id:     r.cte_id     ?? null,
      serie:      r.serie      ?? null,
      number:     r.number     ?? null,
    }))

    // upsert por página
    wrote_total += await upsertInvoices(withKeys)

    // acumula para resposta (cuidado com payloads enormes)
    allForResponse.push(...withKeys)

    // critério de parada
    if (typeof total === 'number') {
      const expectedPages = Math.ceil(total / limit)
      if (page >= expectedPages) break
    } else if (data.length < limit) {
      break
    }

    page++
  }

  // se não paginou por 'page', tente 'start'
  if (mode === 'start') {
    let start = 0
    while (true) {
      const { data, total } = await fetchSiimpPage(baseQs, 'start', start, limit)
      if (!data.length) break

      fetched_pages++
      fetched_total += data.length

      // enrich
      const enriched = await mapLimit(data, MAX_CONCURRENCY, async (r: any) => {
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

      // completa nomes
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

      wrote_total += await upsertInvoices(withKeys)
      allForResponse.push(...withKeys)

      if (typeof total === 'number' && start + data.length >= total) break
      if (data.length < limit) break

      start += limit
    }
  }

  return {
    data: allForResponse,
    fetched_pages,
    fetched_total,
    wrote: wrote_total,
  }
}

// --------------------- handlers ---------------------
export async function GET(req: NextRequest) {
  try {
    const { data, wrote, fetched_pages, fetched_total } = await runSearch(req)
    return NextResponse.json({ ok: true, wrote, fetched_pages, fetched_total, data }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'Erro no search' }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { data, wrote, fetched_pages, fetched_total } = await runSearch(req)
    return NextResponse.json({ ok: true, wrote, fetched_pages, fetched_total, data }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'Erro no search' }, { status: 400 })
  }
}
