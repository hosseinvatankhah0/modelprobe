export type ApiStyle = 'openai' | 'anthropic' | 'gemini';

export type Status =
  | 'ok'
  | 'ratelimit'
  | 'quota'
  | 'auth'
  | 'not_found'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'error';

export interface Pricing {
  /** قیمت هر ۱ میلیون توکن ورودی (اگر قابل استخراج باشد) */
  promptPerMillion?: number;
  /** قیمت هر ۱ میلیون توکن خروجی */
  completionPerMillion?: number;
  /** واحد پول */
  currency?: string;
  /** قیمت خام هر درخواست (در بعضی سرویس‌ها) */
  perRequest?: number;
}

export interface Bench {
  /** امتیاز توانمندی مدل (سبک Elo)؛ null یعنی نامشخص */
  score: number | null;
  /** منبع امتیاز */
  source: 'dataset' | 'estimate' | 'custom' | 'none';
  /** برچسب اختیاری */
  label?: string;
}

export interface ModelInfo {
  /** نام نمایشی مدل */
  id: string;
  /** نامی که در درخواست استفاده می‌شود (می‌تواند متفاوت باشد، مثل Gemini) */
  requestId: string;
  /** قیمت استخراج‌شده از پاسخ /models */
  pricing?: Pricing;
  /** آیا مدل رایگان است؟ null یعنی نامشخص */
  free: boolean | null;
  /** دلیل تشخیص رایگان بودن */
  freeReason?: string;
  /** امتیاز توانمندی (بنچمارک) */
  bench?: Bench;
  /** داده خام از API */
  raw?: unknown;
}

export interface Provider {
  name: string;
  baseUrl: string;
  style: ApiStyle;
  apiKeyEnv?: string;
  docs?: string;
  /** هدرهای اضافی ثابت */
  headers?: Record<string, string>;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  body: string;
  latencyMs: number;
  url: string;
  error?: string;
}

export interface ModelResult {
  provider: string;
  model: string;
  status: Status;
  httpStatus: number;
  latencyMs: number;
  detail: string;
  response: string;
  free: boolean | null;
  freeReason?: string;
  pricing?: Pricing;
  bench?: Bench;
  endpoint?: string;
}

export interface ProbeOptions {
  timeout?: number;
  retries?: number;
  maxTokens?: number;
  prompt?: string;
  stream?: boolean;
  includeNonChat?: boolean;
  grep?: string;
  skip?: string;
  limit?: number;
  freeOnly?: boolean;
  concurrency?: number;
  onProgress?: (done: number, total: number, model: string) => void;
}

export interface ProviderReport {
  provider: string;
  baseUrl: string;
  style: ApiStyle;
  generatedAt: string;
  sort?: string;
  summary: Summary;
  results: ModelResult[];
}

export interface Summary {
  total: number;
  usable: number;
  throttled: number;
  free: number;
  freeUsable: number;
  counts: Record<string, number>;
}
