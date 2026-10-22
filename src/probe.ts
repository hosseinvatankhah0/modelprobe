import { extractError, httpJson, redact } from './http.js';
import { detectFree, parsePricing } from './free.js';
import type {
  ApiStyle,
  HttpResult,
  ModelInfo,
  ModelResult,
  ProbeOptions,
  Provider,
  Status,
} from './types.js';

/** مدل‌هایی که برای chat نیستند */
export const NON_CHAT_RE =
  /(embed|tts|whisper|moderation|rerank|re-rank|dall-?e|gpt-image|imagen|stable-diffusion|flux|sdxl|^clip$|clip-|guard-|realtime|audio-|voice-|music-|computer-use|^ft:|bge-|gte-|^e5-|nomic-|inpaint|upscale|background-removal|speech-to-text|text-to-speech)/i;

const join = (base: string, suffix: string) => base.replace(/\/+$/, '') + suffix;

/** آدرس‌های احتمالی برای گرفتن لیست مدل‌ها */
export function listUrlCandidates(provider: Provider): string[] {
  const b = provider.baseUrl.replace(/\/+$/, '');
  if (provider.style === 'anthropic') {
    return /\/v\d+$/.test(b) ? [join(b, '/models')] : [join(b, '/v1/models'), join(b, '/models')];
  }
  if (provider.style === 'gemini') {
    return /\/v\d+(beta\d*)?$/.test(b)
      ? [join(b, '/models')]
      : [join(b, '/v1beta/models'), join(b, '/v1/models')];
  }
  const cands = [join(b, '/models')];
  if (!/\/v\d+$/.test(b)) {
    cands.push(join(b, '/v1/models'), join(b, '/openai/v1/models'), join(b, '/api/v1/models'));
  }
  return cands;
}

/** آدرس‌های احتمالی برای ارسال چت */
export function chatUrlCandidates(provider: Provider, modelId: string): string[] {
  const b = provider.baseUrl.replace(/\/+$/, '');
  if (provider.style === 'anthropic') {
    return /\/v\d+$/.test(b) ? [join(b, '/messages')] : [join(b, '/v1/messages'), join(b, '/messages')];
  }
  if (provider.style === 'gemini') {
    const prefixes = /\/v\d+(beta\d*)?$/.test(b)
      ? [b]
      : [join(b, '/v1beta'), join(b, '/v1')];
    return prefixes.map(
      (p) => `${p}/models/${encodeURIComponent(modelId)}:generateContent`,
    );
  }
  const cands = [join(b, '/chat/completions')];
  if (!/\/v\d+$/.test(b)) {
    cands.push(
      join(b, '/v1/chat/completions'),
      join(b, '/openai/v1/chat/completions'),
      join(b, '/api/v1/chat/completions'),
    );
  }
  return cands;
}

/** هدرهای احراز هویت بر اساس نوع API */
export function authHeaders(provider: Provider, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { ...(provider.headers ?? {}) };
  if (!apiKey) return headers;
  if (provider.style === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] ??= '2023-06-01';
  } else if (provider.style === 'gemini') {
    /* کلید داخل query string قرار می‌گیرد */
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

function withKey(url: string, provider: Provider, apiKey: string): string {
  if (provider.style === 'gemini' && apiKey) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}key=${encodeURIComponent(apiKey)}`;
  }
  return url;
}

/** تبدیل پاسخ /models به لیست مدل‌ها */
export function parseModels(provider: Provider, payload: unknown): ModelInfo[] {
  const out: ModelInfo[] = [];
  if (!payload || typeof payload !== 'object') return out;
  const root = payload as Record<string, unknown>;

  if (provider.style === 'gemini') {
    const items = (root.models ?? root.data ?? []) as unknown[];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const obj = it as Record<string, unknown>;
      const full = String(obj.name ?? obj.id ?? '');
      if (!full) continue;
      const methods = obj.supportedGenerationMethods;
      if (Array.isArray(methods) && methods.length > 0 && !methods.includes('generateContent')) {
        continue;
      }
      const pricing = parsePricing(obj);
      const { free, reason } = detectFree(full, pricing);
      out.push({
        id: full.replace(/^models\//, ''),
        requestId: full,
        pricing,
        free,
        freeReason: reason,
        raw: obj,
      });
    }
    return out;
  }

  let items = root.data;
  if (!Array.isArray(items)) items = root.models;
  if (!Array.isArray(items)) return out;

  for (const it of items as unknown[]) {
    if (typeof it === 'string') {
      const { free, reason } = detectFree(it);
      out.push({ id: it, requestId: it, free, freeReason: reason });
      continue;
    }
    if (!it || typeof it !== 'object') continue;
    const obj = it as Record<string, unknown>;
    const id = obj.id ?? obj.name ?? obj.model;
    if (!id) continue;
    const modelId = String(id);
    const pricing = parsePricing(obj);
    const { free, reason } = detectFree(modelId, pricing);
    out.push({ id: modelId, requestId: modelId, pricing, free, freeReason: reason, raw: obj });
  }
  return out;
}

/** کشف لیست مدل‌ها */
export async function discoverModels(
  provider: Provider,
  apiKey: string,
  opts: ProbeOptions = {},
): Promise<{ models: ModelInfo[]; endpoint?: string; error?: string }> {
  const headers = authHeaders(provider, apiKey);
  let lastError = '';

  for (const base of listUrlCandidates(provider)) {
    const url = withKey(base, provider, apiKey);
    const res = await httpJson(url, {
      method: 'GET',
      headers,
      timeout: opts.timeout ?? 30_000,
      retries: 1,
    });
    if (res.ok) {
      let payload: unknown;
      try {
        payload = JSON.parse(res.body);
      } catch {
        lastError = 'پاسخ JSON نبود';
        continue;
      }
      const models = parseModels(provider, payload);
      const root = payload as Record<string, unknown>;
      if (models.length > 0 || 'data' in root || 'models' in root) {
        return { models, endpoint: redact(url, apiKey) };
      }
    } else {
      lastError = extractError(res);
    }
  }
  return { models: [], error: redact(lastError, apiKey) };
}

/** دسته‌بندی خطا */
export function classify(status: number, body: string, error?: string): Status {
  if (status === 200) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) {
    const low = (body ?? '').toLowerCase();
    if (
      low.includes('rate limit') ||
      low.includes('too many requests') ||
      low.includes('rpm') ||
      low.includes('tpm')
    ) {
      return 'ratelimit';
    }
    return 'quota';
  }
  if (status === 404) return 'not_found';
  if (status === 400) return 'bad_request';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  if (status === 0) return error && /timeout/i.test(error) ? 'timeout' : 'network';
  return 'error';
}

/** بدنه‌های جایگزین برای مدل‌هایی که پارامترهای خاص را نمی‌پذیرند */
function bodyVariants(
  provider: Provider,
  modelId: string,
  prompt: string,
  maxTokens: number,
  stream: boolean,
): unknown[] {
  if (provider.style === 'anthropic') {
    return [
      {
        model: modelId,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      },
    ];
  }
  if (provider.style === 'gemini') {
    return [
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
      },
    ];
  }
  const base = { model: modelId, messages: [{ role: 'user', content: prompt }] };
  return [
    { ...base, max_tokens: maxTokens, temperature: 0, ...(stream ? { stream: true } : {}) },
    { ...base, max_tokens: maxTokens },
    { ...base, max_completion_tokens: maxTokens },
    base,
  ];
}

function looksLikeParamError(body: string): boolean {
  const low = (body ?? '').toLowerCase();
  return [
    'temperature',
    'max_tokens',
    'max_completion_tokens',
    'unsupported',
    'not supported',
    'invalid_request_error',
    'unrecognized',
    'unexpected',
    'too many tokens',
    'reasoning',
  ].some((k) => low.includes(k));
}

/** استخراج متن پاسخ */
export function extractText(provider: Provider, payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const root = payload as Record<string, unknown>;
  try {
    if (provider.style === 'anthropic') {
      const content = (root.content ?? []) as Array<Record<string, unknown>>;
      return content.map((c) => String(c.text ?? '')).join('').trim();
    }
    if (provider.style === 'gemini') {
      const candidates = (root.candidates ?? []) as Array<Record<string, unknown>>;
      if (!candidates.length) return '';
      const content = (candidates[0].content ?? {}) as Record<string, unknown>;
      const parts = (content.parts ?? []) as Array<Record<string, unknown>>;
      return parts.map((p) => String(p.text ?? '')).join('').trim();
    }
    const choices = (root.choices ?? []) as Array<Record<string, unknown>>;
    if (!choices.length) return '';
    const message = (choices[0].message ?? {}) as Record<string, unknown>;
    let content = message.content ?? choices[0].text ?? '';
    if (Array.isArray(content)) {
      content = content.map((p) => String((p as Record<string, unknown>).text ?? '')).join('');
    }
    return String(content ?? '').trim();
  } catch {
    return '';
  }
}

/** تست واقعی یک مدل */
export async function testModel(
  provider: Provider,
  model: ModelInfo,
  apiKey: string,
  opts: ProbeOptions = {},
): Promise<ModelResult> {
  const timeout = opts.timeout ?? 30_000;
  const retries = opts.retries ?? 2;
  const maxTokens = opts.maxTokens ?? 16;
  const prompt = opts.prompt ?? 'Reply with exactly: OK';
  const headers = authHeaders(provider, apiKey);
  const variants = bodyVariants(provider, model.requestId, prompt, maxTokens, opts.stream ?? false);
  const urls = chatUrlCandidates(provider, model.requestId);

  let last: HttpResult = { status: 0, ok: false, body: '', latencyMs: 0, url: '', error: 'no endpoint' };

  for (const rawUrl of urls) {
    const url = withKey(rawUrl, provider, apiKey);
    for (let vi = 0; vi < variants.length; vi++) {
      const res = await httpJson(url, {
        method: 'POST',
        headers,
        body: variants[vi],
        timeout,
        retries,
      });
      last = { ...res, url };

      if (res.ok) {
        let payload: unknown = {};
        try {
          payload = JSON.parse(res.body);
        } catch {
          payload = {};
        }
        const text = extractText(provider, payload);
        if (!text) {
          const errObj = (payload as Record<string, unknown>).error;
          if (errObj && typeof errObj === 'object') {
            const msg = String((errObj as Record<string, unknown>).message ?? '');
            return {
              provider: provider.name,
              model: model.id,
              status: classify(res.status, res.body, res.error),
              httpStatus: res.status,
              latencyMs: res.latencyMs,
              detail: redact(msg.slice(0, 240), apiKey),
              response: '',
              free: model.free,
              bench: model.bench,
              freeReason: model.freeReason,
              pricing: model.pricing,
              endpoint: redact(url, apiKey),
            };
          }
        }
        return {
          provider: provider.name,
          model: model.id,
          status: 'ok',
          httpStatus: res.status,
          latencyMs: res.latencyMs,
          detail: 'ok',
          response: text.slice(0, 300),
          free: model.free,
          bench: model.bench,
          freeReason: model.freeReason,
          pricing: model.pricing,
          endpoint: redact(url, apiKey),
        };
      }

      const isParamError = res.status === 400 && looksLikeParamError(res.body);
      if (isParamError && vi < variants.length - 1) continue;
      if (res.status === 400 && vi < variants.length - 1) continue;
      break;
    }
    if (last.status !== 404 && last.status !== 405) break;
  }

  const status = classify(last.status, last.body, last.error);
  return {
    provider: provider.name,
    model: model.id,
    status,
    httpStatus: last.status,
    latencyMs: last.latencyMs,
    detail: redact(extractError(last), apiKey),
    response: '',
    free: model.free,
    bench: model.bench,
    freeReason: model.freeReason,
    pricing: model.pricing,
    endpoint: redact(last.url, apiKey),
  };
}

/** فیلتر کردن لیست مدل‌ها */
export function filterModels(
  models: ModelInfo[],
  opts: ProbeOptions & { freePattern?: RegExp },
): ModelInfo[] {
  let out = models;
  if (opts.grep) {
    const rx = new RegExp(opts.grep, 'i');
    out = out.filter((m) => rx.test(m.id));
  }
  if (opts.skip) {
    const rx = new RegExp(opts.skip, 'i');
    out = out.filter((m) => !rx.test(m.id));
  }
  if (!opts.includeNonChat) {
    out = out.filter((m) => !NON_CHAT_RE.test(m.id));
  }
  if (opts.freeOnly) {
    out = out.filter((m) => m.free === true);
  }
  if (opts.limit && opts.limit > 0) {
    out = out.slice(0, opts.limit);
  }
  return out;
}

/** اجرای موازی تست روی همه مدل‌ها */
export async function runTests(
  provider: Provider,
  models: ModelInfo[],
  apiKey: string,
  opts: ProbeOptions = {},
): Promise<ModelResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const results: ModelResult[] = new Array(models.length);
  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= models.length) return;
      const model = models[index]!;
      try {
        results[index] = await testModel(provider, model, apiKey, opts);
      } catch (err) {
        results[index] = {
          provider: provider.name,
          model: model.id,
          status: 'error',
          httpStatus: 0,
          latencyMs: 0,
          detail: err instanceof Error ? err.message : String(err),
          response: '',
          free: model.free,
          bench: model.bench,
          freeReason: model.freeReason,
          pricing: model.pricing,
        };
      }
      done++;
      opts.onProgress?.(done, models.length, model.id);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, worker));
  return results;
}

