import type { HttpResult } from './types.js';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** درخواست JSON با retry روی 429/5xx */
export async function httpJson(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const { method = 'GET', headers = {}, body, timeout = 30_000, retries = 2 } = opts;

  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'User-Agent': 'modelprobe',
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      const latencyMs = Date.now() - started;

      if (res.ok) {
        return { status: res.status, ok: true, body: text, latencyMs, url };
      }
      // 429 دو حالت دارد: محدودیت نرخ موقت (ارزش تلاش مجدد دارد)
      // یا نبود اعتبار/سهمیه (تلاش مجدد بی‌فایده است)
      let retryable = [500, 502, 503, 504].includes(res.status);
      if (res.status === 429) {
        const low = text.toLowerCase();
        const rateLimited =
          low.includes('rate limit') ||
          low.includes('too many requests') ||
          low.includes('rpm') ||
          low.includes('tpm');
        const hardQuota =
          low.includes('insufficient') ||
          low.includes('quota') ||
          low.includes('balance') ||
          low.includes('credit') ||
          low.includes('billing');
        retryable = rateLimited && !hardQuota;
      }
      if (retryable && attempt < retries) {
        await sleep(Math.min(1_000 * 2 ** attempt + Math.random() * 400, 15_000));
        continue;
      }
      return { status: res.status, ok: false, body: text, latencyMs, url, error: `HTTP ${res.status}` };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const name = (err as { name?: string })?.name ?? '';
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;

      if (name === 'TimeoutError' || /timeout|aborted|ETIMEDOUT/i.test(msg)) {
        return { status: 0, ok: false, body: '', latencyMs, url, error: 'timeout' };
      }
      if (attempt < retries) {
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      return { status: 0, ok: false, body: '', latencyMs, url, error: msg };
    }
  }
  return { status: 0, ok: false, body: '', latencyMs: 0, url, error: lastError || 'unknown error' };
}

/** استخراج پیام خطای خوانا از پاسخ API */
export function extractError(res: HttpResult): string {
  if (res.error && !res.body) return res.error;
  const body = (res.body ?? '').trim();
  if (!body) return res.error ?? `HTTP ${res.status}`;
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const err = data.error;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      const msg = e.message ?? e.type ?? e.code;
      if (typeof msg === 'string' && msg) return msg.slice(0, 240);
    }
    if (typeof err === 'string' && err) return err.slice(0, 240);
    for (const key of ['message', 'msg', 'detail', 'error_message']) {
      const v = data[key];
      if (typeof v === 'string' && v) return v.slice(0, 240);
    }
    return body.slice(0, 240).replace(/\n/g, ' ');
  } catch {
    return body.slice(0, 240).replace(/\n/g, ' ');
  }
}

/** پنهان کردن کلید از متن‌های نمایشی */
export function redact(text: string, key?: string): string {
  if (!key) return text;
  return text.split(key).join('***');
}
