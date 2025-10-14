import { NextRequest, NextResponse } from 'next/server'
import { siimp } from '@/lib/siimp'

export const runtime = 'nodejs'

const DAC_BASE_URL = process.env.DAC_BASE_URL ?? 'https://dac.s1mp.net'
const DAC_USERNAME = process.env.DAC_USERNAME
const DAC_PASSWORD = process.env.DAC_PASSWORD
const DAC_COOKIE   = process.env.DAC_COOKIE
const DEFAULT_CANCEL_REASON = process.env.DEFAULT_CANCEL_REASON ?? 'Cancelado via portal'

async function dacLoginAndGetCookie(): Promise<string> {
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
    const anyHeaders = res.headers as any
    const setCookies: string[] =
      typeof anyHeaders.getSetCookie === 'function'
        ? anyHeaders.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean) as string[]
    for (const sc of setCookies) {
      const m = /PHPSESSID=([^;]+)/i.exec(sc)
      if (m?.[1]) return `PHPSESSID=${m[1]}`
    }
  }
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
      Cookie: cookie,
    },
    body: new URLSearchParams({ id: String(id) }),
  })
  const ct = res.headers.get('content-type') || ''
  const data = ct.includes('application/json') ? await res.json() : await res.text()

  // 🔎 Detecta "já está cancelada" no DAC para tratar como idempotente
  const raw = typeof data === 'string' ? data : JSON.stringify(data)
  const already = /já está cancelad/i.test(raw) || /ja esta cancelad/i.test(raw)

  // sucesso real ou já-cancelada = OK
  const ok = (res.ok && (data?.success === true || data?.success === undefined)) || already

  return { ok, status: res.status, data, alreadyCanceled: already }
}

export async function POST(req: NextRequest) {
  const { id, reason, send_mail } = await req.json()
  if (!id) return NextResponse.json({ ok: false, error: 'id obrigatório' }, { status: 400 })

  const motivo = (typeof reason === 'string' && reason.trim()) ? reason.trim() : DEFAULT_CANCEL_REASON
  const sendMail = typeof send_mail === 'boolean' ? send_mail : false

  const [siimpRes, dacRes] = await Promise.allSettled([
    (async () => {
      try {
        const out = await siimp<any>('/invoices/cancel', {
          method: 'POST',
          body: { id, reason: motivo, send_mail: sendMail },
        })
        return { ok: true, data: out, alreadyCanceled: false }
      } catch (e: any) {
        // Tenta extrair detalhes do erro do Siimp
        const msg =
          e?.response?.data?.message ||
          (Array.isArray(e?.response?.data?.errors) ? e.response.data.errors.join(', ') : null) ||
          e?.message ||
          'erro Siimp'

        // Heurística: se o DAC disser que já está cancelada, vamos considerar OK geral adiante.
        return { ok: false, error: msg, alreadyCanceled: /cancelad/i.test(String(msg)) }
      }
    })(),
    cancelInDac(id),
  ])

  const result: any = {
    siimp: siimpRes.status === 'fulfilled' ? siimpRes.value : { ok: false, error: siimpRes.reason?.message ?? 'falha inesperada (Siimp)' },
    dac:   dacRes.status   === 'fulfilled' ? dacRes.value   : { ok: false, error: dacRes.reason?.message   ?? 'falha inesperada (DAC)' },
  }

  // ✅ Idempotência: se qualquer lado disser "já estava cancelada", trata como sucesso lógico
  const already =
    (result.dac?.alreadyCanceled === true) ||
    (result.siimp?.alreadyCanceled === true)

  const overallOk = already || (result.siimp?.ok === true && result.dac?.ok === true)

  return NextResponse.json(
    { ok: overallOk, alreadyCanceled: already, ...result },
    { status: overallOk ? 200 : 207 }
  )
}
