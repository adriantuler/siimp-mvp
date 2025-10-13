// src/lib/siimp.ts
export async function siimp<T>(
  path: string,
  opts?: { method?: 'GET'|'POST'; query?: Record<string,any>; body?: any }
): Promise<T> {
  const base = process.env.SIIMP_BASE_URL!;
  const url = new URL(path.replace(/^\//,''), base);
  if (opts?.query) for (const [k,v] of Object.entries(opts.query)) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    method: opts?.method ?? 'GET',
    headers: {
      'X-Api-Key': process.env.SIIMP_API_KEY!,
      ...(opts?.body ? { 'Content-Type':'application/json' } : {}),
      'Accept': 'application/json'
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store'
  });

  let data:any = {};
  try { data = await res.clone().json(); } catch {}
  if (res.status !== 200) throw new Error(data?.message || `HTTP ${res.status}`);
  if (data?.success === false) throw new Error(data?.message || 'BusinessError');
  return data as T;
}
