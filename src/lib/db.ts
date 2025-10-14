// src/lib/db.ts
import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL ausente nas variáveis de ambiente')
}

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Neon
})

// helper simples (sem generics pra evitar TS2347/2709)
export async function query(text: string, params?: any[]) {
  return pool.query(text as any, params as any)
}
