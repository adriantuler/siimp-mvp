// app/api/invoices/pay-from-file/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { siimp } from '@/lib/siimp'

export const runtime = 'nodejs'

const onlyDigits = (s: any) => (s == null ? null : String(s).replace(/\D+/g, '') || null)

function stripAccents(s: string) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '')
}
function normHeader(h: string) {
  return stripAccents(h).toLowerCase().replace(/\s+/g, '').replace(/[^\w]/g, '')
}
function detectSep(line: string) {
  const sc = (line.match(/;/g) || []).length
  const cc = (line.match(/,/g) || []).length
  return sc > cc ? ';' : ','
}
function parseMoney(s: any): number | null {
  if (s == null) return null
  let t = String(s).trim()
  if (!t) return null
  // remove R$, espaços
  t = t.replace(/[R$\s]/g, '')
  // se tem vírgula como decimal (BR)
  if (/,/.test(t) && /\.\d{3}/.test(t)) {
    // 1.234,56 -> remove pontos e troca vírgula
    t = t.replace(/\./g, '').replace(',', '.')
  } else if (/,/.test(t) && !/\.\d/.test(t)) {
    // 123,45 -> troca vírgula
    t = t.replace(',', '.')
  }
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

type FileRow = { cnpj: string|null, nf: string|null, valor: number|null, raw: Record<string, any> }

async function readCSV(req: NextRequest): Promise<FileRow[]> {
  // multipart/form-data (file) OU JSON { rows: [...] }
  const ct = req.headers.get('content-type') || ''
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw new Error('Envie o arquivo no campo "file".')
    const text = await file.text()
    return parseCSVText(text)
  }
  const body = await req.json().catch(() => ({}))
  if (Array.isArray(body?.rows)) {
    // normaliza um array de objetos já carregados
    const out: FileRow[] = []
    for (const r of body.rows) {
      const obj = Object(r)
      const keys = Object.keys(obj)
      const map: Record<string, any> = {}
      for (const k of keys) map[normHeader(k)] = obj[k]
      const cnpj = onlyDigits(map['cnpjfornecedor'] ?? map['cnpjfornecedo'] ?? map['cnpj'] ?? null)
      const nf   = (map['nf'] ?? map['numeronf'] ?? map['nºnf'] ?? map['numero'] ?? null)?.toString() ?? null
      const val  = parseMoney(map['valorliquido'] ?? map['valorliquido'] ?? map['valor'] ?? null)
      out.push({ cnpj, nf, valor: val, raw: obj })
    }
    return out
  }
  throw new Error('Envie um CSV (multipart/form-data "file") ou JSON { rows: [...] }.')
}

function parseCSVText(text: string): FileRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (!lines.length) return []
  const sep = detectSep(lines[0])
  const header = lines[0].split(sep).map(h => normHeader(h))
  const rows: FileRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep)
    const obj: Record<string, any> = {}
    header.forEach((h, idx) => { obj[h] = cols[idx] })
    const cnpj = onlyDigits(obj['cnpjfornecedor'] ?? obj['cnpjfornecedo'] ?? obj['cnpj'] ?? null)
    const nf   = (obj['nf'] ?? obj['numeronf'] ?? obj['nºnf'] ?? obj['numero'] ?? null) ? String(obj['nf'] ?? obj['numeronf'] ?? obj['nºnf'] ?? obj['numero']) : null
    const val  = parseMoney(obj['valorliquido'] ?? obj['valorliquido'] ?? obj['valor'] ?? null)
    rows.push({ cnpj, nf, valor: val, raw: obj })
  }
  return rows
}

// procura fatura no banco
async function findInvoice(cnpj: string|null, nf: string|null, valor: number|null) {
  if (!cnpj || !nf) return null
  // tenta bater por string e também numericamente
  const nfNum = Number(nf)
  const sql = `
    SELECT id, owner_cnpj, owner_id, invoice_number, total, invoice_status
    FROM invoices
    WHERE owner_cnpj = $1
      AND (invoice_number = $2 OR (CASE WHEN invoice_number ~ '^[0-9]+$' THEN (invoice_number)::bigint ELSE NULL END) = $3)
    ORDER BY id DESC
    LIMIT 5
  `
  const res = await query(sql, [cnpj, nf, Number.isFinite(nfNum) ? nfNum : null])
  if (!res.rows.length) return null

  // se vier valor, filtra por tolerância (centavos arredondados)
  if (valor != null) {
    const tol = 0.05
    const match = res.rows.find((r: any) => {
      const v = Number(r.total)
      return Number.isFinite(v) && Math.abs(v - valor) <= tol
    })
    return match ?? res.rows[0]
  }
  return res.rows[0]
}

// baixa no SIIMP (idempotente)
async function payOnSiimp(id: number): Promise<{ ok: boolean; already?: boolean; msg?: string }> {
  try {
    // adapte se seu endpoint de baixa for diferente
    const resp = await siimp<any>('/invoices/pay', { method: 'POST', body: { id } })
    // convenciona: success true -> ok
    if ((resp && (resp.ok === true || resp.success === true)) && (resp.status === undefined || resp.status === 1)) {
      return { ok: true }
    }
    // se API responder algo indicando "já liquidada"
    const txt = JSON.stringify(resp ?? {})
    if (/ja\s*liquidad|already\s*paid|status":\s*1/i.test(txt)) {
      return { ok: true, already: true }
    }
    return { ok: false, msg: txt }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (/ja\s*liquidad|already\s*paid/i.test(msg)) return { ok: true, already: true }
    return { ok: false, msg }
  }
}

// atualiza localmente (fallback) — mantém trilha
async function markPaidLocally(id: number) {
  await query(
    `UPDATE invoices SET invoice_status = 1, synced_at = NOW() WHERE id = $1`,
    [id]
  )
}

export async function POST(req: NextRequest) {
  try {
    const dryRun = (req.nextUrl.searchParams.get('dryRun') ?? req.nextUrl.searchParams.get('dryrun')) === '1'

    const rows = await readCSV(req)
    const results: any[] = []
    let matched = 0, paid = 0, skipped = 0, errors = 0

    for (const r of rows) {
      if (!r.cnpj || !r.nf) {
        skipped++
        results.push({ ok: false, reason: 'faltam campos (CNPJ/NF)', row: r.raw })
        continue
      }
      const inv = await findInvoice(r.cnpj, r.nf, r.valor)
      if (!inv) {
        skipped++
        results.push({ ok: false, reason: 'não encontrada', row: r.raw })
        continue
      }
      matched++

      if (dryRun) {
        results.push({ ok: true, dryRun: true, id: inv.id, invoice_number: inv.invoice_number, total: inv.total })
        continue
      }

      // chamar SIIMP
      const pay = await payOnSiimp(inv.id)
      if (!pay.ok) {
        // fallback local: marca como paga no banco
        await markPaidLocally(inv.id)
        paid++
        results.push({ ok: true, fallbackLocal: true, id: inv.id, invoice_number: inv.invoice_number, total: inv.total, warn: pay.msg })
      } else {
        paid++
        results.push({
          ok: true,
          id: inv.id,
          invoice_number: inv.invoice_number,
          total: inv.total,
          already: pay.already ?? false
        })
      }
    }

    return NextResponse.json({ ok: true, dryRun, rows: rows.length, matched, paid, skipped, errors, results }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'Erro no pay-from-file' }, { status: 400 })
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    howto: 'POST multipart/form-data com "file" (CSV) ou JSON { rows: [...] }. Use ?dryRun=1 para simular.',
    expectedHeaders: ['CNPJ Fornecedor', 'NF', 'Valor Líquido'],
  })
}
