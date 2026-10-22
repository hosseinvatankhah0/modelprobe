import type { Pricing } from './types.js';

const toNum = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/**
 * تبدیل قیمت‌های خام API به قیمت هر ۱ میلیون توکن.
 * اگر مقدار خیلی کوچک باشد (< 0.01) فرض می‌کنیم «به ازای هر توکن» است،
 * در غیر این صورت «به ازای هر ۱ میلیون توکن» در نظر گرفته می‌شود.
 */
const perMillion = (value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (value === 0) return 0;
  return value < 0.01 ? value * 1_000_000 : value;
};

/** استخراج قیمت از پاسخ /models (فرمت‌های مختلف: OpenRouter، Azure، گیت‌وی‌ها) */
export function parsePricing(raw: unknown): Pricing | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  // قیمت ممکن است داخل pricing/cost باشد یا مستقیم روی خود مدل (مثل Azure)
  const source = (obj.pricing ?? obj.cost ?? obj.price ?? obj.costs ?? obj) as
    | Record<string, unknown>
    | undefined;

  if (!source || typeof source !== 'object') return undefined;

  const promptRaw =
    toNum(source.prompt) ??
    toNum(source.input_price_per_token) ??
    toNum(source.input) ??
    toNum(source.prompt_price) ??
    toNum(source.promptPerMillion);
  const completionRaw =
    toNum(source.completion) ??
    toNum(source.output_price_per_token) ??
    toNum(source.output) ??
    toNum(source.completion_price) ??
    toNum(source.completionPerMillion);
  const requestRaw = toNum(source.request) ?? toNum(source.per_request);

  if (promptRaw === undefined && completionRaw === undefined && requestRaw === undefined) {
    return undefined;
  }

  const pricing: Pricing = { currency: 'USD' };
  const p = perMillion(promptRaw);
  const c = perMillion(completionRaw);
  if (p !== undefined) pricing.promptPerMillion = p;
  if (c !== undefined) pricing.completionPerMillion = c;
  if (requestRaw !== undefined) pricing.perRequest = requestRaw;
  return pricing;
}

/** الگوهای نامی که معمولاً به مدل رایگان اشاره دارند */
const FREE_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/:free\s*$/i, 'نام مدل با :free تمام می‌شود'],
  [/(^|[-_/.])free([-_/.]|$)/i, 'کلمه free در نام مدل'],
  [/\bfree\b/i, 'کلمه free در نام مدل'],
  [/\btrial\b/i, 'مدل trial'],
];

/**
 * تشخیص رایگان بودن مدل.
 * اولویت: قیمت اعلام‌شده در API → الگوی نام مدل → نامشخص
 */
export function detectFree(
  modelId: string,
  pricing?: Pricing,
  extraPattern?: RegExp,
): { free: boolean | null; reason?: string } {
  if (pricing) {
    const p = pricing.promptPerMillion;
    const c = pricing.completionPerMillion;
    const r = pricing.perRequest;
    const known = [p, c, r].filter((v) => v !== undefined) as number[];
    if (known.length > 0) {
      const allZero = known.every((v) => v === 0);
      if (allZero) return { free: true, reason: 'قیمت اعلام‌شده در API: صفر' };
      return { free: false, reason: 'قیمت اعلام‌شده در API' };
    }
  }

  for (const [rx, reason] of FREE_NAME_PATTERNS) {
    if (rx.test(modelId)) return { free: true, reason };
  }
  if (extraPattern?.test(modelId)) {
    return { free: true, reason: 'الگوی سفارشی --free-pattern' };
  }
  return { free: null };
}

/** فرمت قیمت برای نمایش */
export function formatPricing(pricing?: Pricing): string {
  if (!pricing) return '?';
  const parts: string[] = [];
  if (pricing.promptPerMillion !== undefined) {
    parts.push(`in ${pricing.promptPerMillion}/1M`);
  }
  if (pricing.completionPerMillion !== undefined) {
    parts.push(`out ${pricing.completionPerMillion}/1M`);
  }
  if (parts.length === 0 && pricing.perRequest !== undefined) {
    parts.push(`${pricing.perRequest}/req`);
  }
  return parts.length ? parts.join(' · ') : '?';
}
