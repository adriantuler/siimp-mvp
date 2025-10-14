import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const DAC_BASE_URL = process.env.DAC_BASE_URL ?? 'https://dac.s1mp.net'
const DAC_USERNAME = process.env.DAC_USERNAME
const DAC_PASSWORD = process.env.DAC_PASSWORD
const DAC_COOKIE   = process.env.DAC_COOKIE // ex.: "PHPSESSID=abc123"

// util simples: extrai "PHPSESSID=..." de um Set-Cookie
function extractPhpSessId(setCookie: string | null): string | null {
  if (!setCookie) return null
  const m = /PHPSESSID=([^;]+)/i.exec(setCookie)
  return m?.[1] ? `PHPSESSID=${m[1]}` : null
}

// obtém a sessão do DAC (usa DAC_COOKIE ou tenta login)
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

type Enriched = {
  id: number | string
  owner_id: number | string | null
  cte_id: number | string | null
  serie: string | number | null
  number: number | string | null
}

async function fetchOne(id: number | string): Promise<{ ok: true, data: Enriched } | { ok: false, error: string, id: number | string }> {
  try {
    const cookie = await getDacSessionCookie()

    // monta URL da consulta (os demais params são cosméticos; estes bastam)
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

    const ct = res.headers.get('content-type') || ''
    const payload: any = ct.includes('application/json') ? await res.json() : await res.text()

    if (!res.ok) {
      const msg = typeof payload === 'string' ? payload : (payload?.message || 'Erro no DAC')
      return { ok: false, error: String(msg), id }
    }
    if (!payload?.success || !Array.isArray(payload?.data) || payload.data.length === 0) {
      return { ok: false, error: 'Sem dados para este id', id }
    }

    const rec = payload.data[0] || {}
    const docs: any[] = Array.isArray(rec.documents) ? rec.documents : []
    const doc = docs[0] || null

    const enriched: Enriched = {
      id: rec.id ?? id,
      owner_id: rec.owner_id ?? rec?.owner?.id ?? null,
      cte_id: doc?.cte_id ?? null,
      serie: doc?.serie ?? null,
      number: doc?.number ?? null,
    }

    return { ok: true, data: enriched }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Falha inesperada', id }
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any))
  const list: Array<number | string> = Array.isArray(body?.ids)
    ? body.ids
    : (body?.id != null ? [body.id] : [])

  if (list.length === 0) {
    return NextResponse.json({ ok: false, error: 'Informe id (number) ou ids (number[])' }, { status: 400 })
  }

  const results = await Promise.all(list.map(fetchOne))
  const okAll = results.every(r => r.ok)

  return NextResponse.json(
    {
      ok: okAll,
      data: results.filter((r: any) => r.ok).map((r: any) => r.data) as Enriched[],
      errors: results.filter((r: any) => !r.ok),
    },
    { status: 200 }
  )
}
