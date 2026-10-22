import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * دیتاست توانمندی مدل‌ها (Benchmark ratings)
 *
 * امتیازها سبک «Elo» هستند (مثل Chatbot Arena / LMSYS) و یک اسنپ‌شات تقریبی از
 * لیدربوردهای عمومی‌اند. برای مدل‌هایی که در دیتاست نیستند، یک تخمین بر پایه‌ی
 * خانواده/اندازه‌ی مدل محاسبه می‌شود که با `~` نمایش داده می‌شود.
 *
 * کاربر می‌تواند لیست دلخواهش را با `--rank-file <file.json>` بدهد:
 *   { "gpt-4o": 1360, "my-model": 1200 }
 *
 * منبع داده: src/benchmarks.json (مشترک با نسخه‌ی پایتون)
 */

export interface BenchEntry {
  /** الگوی تطبیق نام مدل (regex، بدون حساسیت به بزرگی/کوچکی حروف) */
  pattern: string;
  /** امتیاز توانمندی (سبک Elo) */
  score: number;
  /** برچسب اختیاری */
  label?: string;
}

export interface BenchResult {
  /** امتیاز توانمندی؛ null یعنی نامشخص */
  score: number | null;
  /** منبع امتیاز: dataset | estimate | custom | none */
  source: 'dataset' | 'estimate' | 'custom' | 'none';
  /** توضیح کوتاه */
  label?: string;
}

export const NO_BENCH: BenchResult = { score: null, source: 'none' };

/**
 * دیتاست داخلی — الگوها از اختصاصی به عمومی مرتب شده‌اند
 * تا اولین تطابق برنده شود (مثلاً gpt-4o-mini قبل از gpt-4o).
 * منبع: src/benchmarks.json
 */
function loadBenchmarkData(): BenchEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'benchmarks.json'),
    join(here, '..', 'src', 'benchmarks.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf8');
      return JSON.parse(raw) as BenchEntry[];
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

export const BENCHMARKS: BenchEntry[] = loadBenchmarkData();

/** حذف پیشوند ارائه‌دهنده و نویزهای رایج از نام مدل */
export function normalizeModelId(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/^models\//, '')
    .split('/')
    .pop()!
    .replace(/:free$/, '')
    .replace(/-v\d+:\w+$/, '')
    .trim();
}

/** پیدا کردن امتیاز در دیتاست داخلی */
export function lookupDataset(
  modelId: string,
  entries: BenchEntry[] = BENCHMARKS,
): BenchResult | undefined {
  const id = normalizeModelId(modelId);
  for (const entry of entries) {
    try {
      if (new RegExp(entry.pattern, 'i').test(id)) {
        return { score: entry.score, source: 'dataset', label: entry.label };
      }
    } catch {
      /* الگوی نامعتبر را نادیده بگیر */
    }
  }
  return undefined;
}

const SIZE_TIERS: Array<[RegExp, number]> = [
  [/\b(400|405)b\b/, 30],
  [/\b(70|72|80)b\b/, 22],
  [/\b(32|34|36)b\b/, 14],
  [/\b(20|14|16)b\b/, 8],
  [/\b(7|8|9)b\b/, 3],
  [/\b(1|2|3|4)b\b/, -4],
];

const QUALITY_TIERS: Array<[RegExp, number]> = [
  [/\b(opus|ultra|flagship)\b/, 16],
  [/\b(pro|max|xl)\b/, 12],
  [/\b(plus|advanced|premium)\b/, 8],
  [/\b(thinking|reasoner|reasoning|r1)\b/, 8],
  [/\b(instruct|chat)\b/, 2],
  [/\b(reasoning)\b/, 8],
  [/\b(preview|beta|experimental|exp|nightly|thinking-draft)\b/, -6],
  [/\b(mini|nano|tiny|small|lite|light)\b/, -8],
  [/\b(large|xl)\b/, 6],
];

/**
 * تخمین توانمندی برای مدل‌هایی که در دیتاست نیستند.
 * خروجی با `~` نمایش داده می‌شود چون تخمینی است.
 */
export function estimateBenchmark(modelId: string): BenchResult {
  const id = normalizeModelId(modelId);
  let score = 1180;

  for (const [rx, delta] of SIZE_TIERS) if (rx.test(id)) score += delta;
  for (const [rx, delta] of QUALITY_TIERS) if (rx.test(id)) score += delta;

  return { score: Math.max(900, Math.min(1500, score)), source: 'estimate' };
}

/**
 * امتیاز نهایی یک مدل.
 * `custom` (از --rank-file) > `dataset` > `estimate`
 */
export function getBenchmark(
  modelId: string,
  custom?: Map<string, number>,
): BenchResult {
  if (custom) {
    const id = normalizeModelId(modelId);
    const exact = custom.get(id) ?? custom.get(modelId.toLowerCase());
    if (exact !== undefined) {
      return { score: exact, source: 'custom' };
    }
  }

  const found = lookupDataset(modelId);
  if (found) return found;

  return estimateBenchmark(modelId);
}

/** بارگذاری لیست سفارشی امتیازها از فایل JSON */
export function parseRankFile(content: string): Map<string, number> {
  const map = new Map<string, number>();
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Rank file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Rank file must be a JSON object of { "model-id": score }');
  }

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const score = typeof value === 'number' ? value : Number.parseFloat(String(value));
    if (Number.isFinite(score)) map.set(key.toLowerCase(), score);
  }
  return map;
}
