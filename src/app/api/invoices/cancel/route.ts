import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'

export const runtime = 'nodejs'

const DAC_BASE_URL = process.env.DAC_BASE_URL ?? 'https://dac.s1mp.net'
const DAC_USERNAME = process.env.DAC_USERNAME
const DAC_PASSWORD = process.env.DAC_PASSWORD
const DAC_COOKIE   = process.env.DAC_COOKIE // fallback: "PHPSESSID=abc123"

// Tenta logar e extrair o PHPSESSID. Se não houver credenciais, usa DAC_COOKIE.
async function dacLoginAndGetCookie(): Promise<string> {
  // Se tiver usuário/senha, tenta login
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
      redirect: 'manual', // não seguir para conseguir ler Set-Cookie do login
    })

    // Pega todos os Set-Cookie (Node 18+/undici tem getSetCookie())
    const anyHeaders = res.headers as any
    const setCookies: string[] =
      typeof anyHeaders.getSetCookie === 'function'
        ? anyHeaders.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean) as string[]

    // Extrai o PHPSESSID
    for (const sc of setCookies) {
      const m = /PHPSESSID=([^;]+)/i.exec(sc)
      if (m?.[1]) return `PHPSESSID=${m[1]}`
    }
  }

  // Fallback para variável de ambiente
  if (DAC_COOKIE) return DAC_COOKIE

  throw new Error('Não foi possível obter a sessão do DAC (configure DAC_USERNAME/DAC_PASSWORD ou DAC_COOKIE).')
}

async function cancelInDac(id: string | number) {
  const cookie = await dacLoginAndGetCookie()
  const url = `${DAC_BASE_URL}/transaction/cancel`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: DAC_BASE_URL,
      Referer: `${DAC_BASE_URL}/`,
      Cookie: cookie, // PHPSESSID=...
    },
    body: new URLSearchParams({ id: String(id) }),
  })

  const ct = res.headers.get('content-type') || ''
  const data = ct.includes('application/json') ? await res.json() : await res.text()
  return { ok: res.ok, status: res.status, data }
}

export async function POST(req: NextRequest) {
  const { id, reason, send_mail } = await req.json()
  if (!id) return NextResponse.json({ ok: false, error: 'id obrigatório' }, { status: 400 })

  // Executa Siimp e DAC em paralelo
  const [siimpRes, dacRes] = await Promise.allSettled([
    (async () => {
      try {
        const out = await siimp<any>('/invoices/cancel', {
          method: 'POST',
          body: { id, reason, send_mail },
        })
        return { ok: true, data: out }
      } catch (e: any) {
        return { ok: false, error: e?.message ?? 'erro Siimp' }
      }
    })(),
    cancelInDac(id),
  ])

  let ok = true
  const result: any = {}

  if (siimpRes.status === 'fulfilled') {
    result.siimp = siimpRes.value
    if (!siimpRes.value.ok) ok = false
  } else {
    result.siimp = { ok: false, error: siimpRes.reason?.message ?? 'falha inesperada (Siimp)' }
    ok = false
  }

  if (dacRes.status === 'fulfilled') {
    result.dac = dacRes.value
    if (!dacRes.value.ok) ok = false
  } else {
    result.dac = { ok: false, error: dacRes.reason?.message ?? 'falha inesperada (DAC)' }
    ok = false
  }

  return NextResponse.json({ ok, ...result }, { status: ok ? 200 : 207 })
}
