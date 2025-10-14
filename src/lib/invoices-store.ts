// src/lib/invoices-store.ts
import { query } from './db'

export type InvoiceRow = {
  id: number
  owner_id: number | null
  invoice_number: string
  invoice_status: number
  total: string
  maturity: string
  payment_form: number
  created_at: string
  invoice_obs?: string | null
  cte_id: number | null
  serie: string | null
  number: number | null
  // extra fields do backend original podem existir, guardamos em raw
  raw?: any
}

export async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id                BIGINT PRIMARY KEY,
      owner_id          BIGINT,
      invoice_number    TEXT NOT NULL,
      invoice_status    INT  NOT NULL,
      total             NUMERIC NOT NULL,
      maturity          DATE NOT NULL,
      payment_form      INT  NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL,
      invoice_obs       TEXT,
      cte_id            BIGINT,
      serie             TEXT,
      number            BIGINT,
      raw               JSONB,
      synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices (invoice_status);
    CREATE INDEX IF NOT EXISTS idx_invoices_number  ON invoices (invoice_number);
  `)
}

export async function upsertMany(rows: InvoiceRow[]) {
  if (!rows.length) return

  // upsert em lote
  const cols = [
    'id','owner_id','invoice_number','invoice_status','total','maturity',
    'payment_form','created_at','invoice_obs','cte_id','serie','number','raw'
  ]
  const values: any[] = []
  const chunks: string[] = []

  rows.forEach((r, i) => {
    const base = [
      r.id,
      r.owner_id ?? null,
      String(r.invoice_number),
      Number(r.invoice_status),
      r.total,
      r.maturity,
      Number(r.payment_form),
      r.created_at,
      r.invoice_obs ?? null,
      r.cte_id ?? null,
      r.serie ?? null,
      r.number ?? null,
      JSON.stringify(r.raw ?? null),
    ]
    values.push(...base)
    const offset = i * cols.length
    const placeholders = base.map((_, j) => `$${offset + j + 1}`)
    chunks.push(`(${placeholders.join(',')})`)
  })

  await query(
    `
    INSERT INTO invoices (${cols.join(',')})
    VALUES ${chunks.join(',')}
    ON CONFLICT (id) DO UPDATE SET
      owner_id       = EXCLUDED.owner_id,
      invoice_number = EXCLUDED.invoice_number,
      invoice_status = EXCLUDED.invoice_status,
      total          = EXCLUDED.total,
      maturity       = EXCLUDED.maturity,
      payment_form   = EXCLUDED.payment_form,
      created_at     = EXCLUDED.created_at,
      invoice_obs    = EXCLUDED.invoice_obs,
      cte_id         = EXCLUDED.cte_id,
      serie          = EXCLUDED.serie,
      number         = EXCLUDED.number,
      raw            = EXCLUDED.raw,
      synced_at      = NOW();
    `,
    values
  )
}
