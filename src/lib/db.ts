// src/lib/db.ts
import { Pool } from 'pg'

// use DATABASE_URL no Vercel (Neon)
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL ausente nas variáveis de ambiente')
}

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Neon
})

export async function query<T = any>(text: string, params?: any[]) {
  const res = await pool.query<T>(text, params)
  return res
}
