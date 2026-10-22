import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { CliArgs } from './args.js';
import { discoverModels, filterModels, runTests } from './probe.js';
import { c, Progress, renderSummary, renderTable } from './ui.js';
import type { ModelInfo, ModelResult, Provider, ProviderReport, Summary } from './types.js';

export const HOME_DIR = join(homedir(), '.modelprobe');
export const KEYS_FILE = join(HOME_DIR, 'keys.json');
export const DEFAULT_REPORT_DIR = join(HOME_DIR, 'reports');

export function readKeys(): Record<string, string> {
  try {
    if (!existsSync(KEYS_FILE)) return {};
    return JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeKeys(keys: Record<string, string>): void {
  mkdirSync(dirname(KEYS_FILE), { recursive: true });
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
}

export function resolveApiKey(
  provider: Provider,
  args: CliArgs,
  keys: Record<string, string>,
): string {
  if (args.apiKey) return args.apiKey.trim();
  if (args.keyEnv && process.env[args.keyEnv]) return process.env[args.keyEnv]!.trim();
  if (keys[provider.name]) return keys[provider.name].trim();
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) {
    return process.env[provider.apiKeyEnv]!.trim();
  }
  if (process.env.MODELPROBE_API_KEY) return process.env.MODELPROBE_API_KEY.trim();
  return '';
}

export function buildSummary(results: ModelResult[]): Summary {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    total: results.length,
    usable: results.filter((r) => r.status === 'ok').length,
    throttled: results.filter((r) => r.status === 'ratelimit').length,
    free: results.filter((r) => r.free === true).length,
    freeUsable: results.filter(
      (r) => r.free === true && (r.status === 'ok' || r.status === 'ratelimit'),
    ).length,
    counts,
  };
}

function csvEscape(value: string): string {
  const v = value ?? '';
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function writeReports(
  provider: Provider,
  results: ModelResult[],
  models: ModelInfo[],
  args: CliArgs,
): string[] {
  const dir = resolve(args.reportDir);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = provider.name.replace(/[^A-Za-z0-9_.-]+/g, '_');
  const written: string[] = [];

  const report: ProviderReport = {
    provider: provider.name,
    baseUrl: provider.baseUrl,
    style: provider.style,
    generatedAt: new Date().toISOString(),
    summary: buildSummary(results),
    results,
  };

  const jsonPath = join(dir, `${safe}-${stamp}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        ...report,
        models: models.map((m) => ({ id: m.id, free: m.free, pricing: m.pricing })),
      },
      null,
      2,
    ),
    'utf8',
  );
  written.push(jsonPath);

  const csvPath = join(dir, `${safe}-${stamp}.csv`);
  const rows = [
    [
      'provider',
      'model',
      'status',
      'verdict',
      'free',
      'http_status',
      'latency_ms',
      'price_prompt_per_1m',
      'price_completion_per_1m',
      'detail',
      'response',
    ],
    ...results.map((r) => [
      r.provider,
      r.model,
      r.status,
      r.status === 'ok' ? 'USABLE' : r.status === 'ratelimit' ? 'USABLE*' : '',
      r.free === null ? '' : String(r.free),
      String(r.httpStatus),
      String(Math.round(r.latencyMs)),
      r.pricing?.promptPerMillion === undefined ? '' : String(r.pricing.promptPerMillion),
      r.pricing?.completionPerMillion === undefined ? '' : String(r.pricing.completionPerMillion),
      r.detail,
      r.response,
    ]),
  ];
  writeFileSync(csvPath, '\ufeff' + rows.map((r) => r.map(csvEscape).join(',')).join('\n'), 'utf8');
  written.push(csvPath);

  return written;
}

/** اجرای کامل روی یک پرووایدر: کشف مدل + تست + گزارش */
export async function runProvider(
  provider: Provider,
  args: CliArgs,
  keys: Record<string, string>,
  askForKey?: (provider: Provider) => Promise<string>,
): Promise<ModelResult[]> {
  console.log(c.bold(`\n━━━ ${provider.name}  ${c.dim(provider.baseUrl)} ━━━`));

  let apiKey = resolveApiKey(provider, args, keys);
  if (!apiKey && askForKey) {
    apiKey = await askForKey(provider);
  }
  if (!apiKey) {
    console.log(
      c.yellow('  ⚠ کلیدی پیدا نشد — بدون احراز هویت تست می‌شود (مناسب سرورهای محلی)'),
    );
  }

  let models: ModelInfo[] = [];

  if (args.models.length) {
    models = args.models.map((m) => ({ id: m, requestId: m, free: null }));
    console.log(`  ${c.dim(`مدل‌های دستی: ${models.length}`)}`);
  } else {
    const discovery = await discoverModels(provider, apiKey, {
      timeout: args.timeout,
      retries: 1,
    });
    if (discovery.endpoint) {
      console.log(
        `  ${c.dim(`لیست مدل‌ها: ${discovery.models.length} عدد`)}  ${c.dim(discovery.endpoint)}`,
      );
    } else {
      console.log(c.yellow(`  ⚠ لیست مدل‌ها گرفته نشد: ${discovery.error ?? '?'}`));
    }
    models = discovery.models;
  }

  if (args.listOnly) {
    for (const m of models) {
      const tag = m.free === true ? c.green(' [FREE]') : m.free === false ? c.dim(' [paid]') : '';
      console.log(`    ${m.id}${tag}`);
    }
    return [];
  }

  const freePattern = args.freePattern ? new RegExp(args.freePattern, 'i') : undefined;
  const filtered = filterModels(models, {
    grep: args.grep,
    skip: args.skip,
    limit: args.limit,
    includeNonChat: args.includeNonChat,
    freeOnly: args.freeOnly,
    freePattern,
  });

  if (!filtered.length) {
    console.log(c.yellow('  مدلی برای تست نماند.'));
    return [];
  }

  if (!args.quiet) {
    console.log(
      `  ${c.dim(`تست ${filtered.length} مدل با ${args.concurrency} درخواست موازی ...`)}\n`,
    );
  }

  const progress = new Progress();
  progress.start(filtered.length);
  const results = await runTests(provider, filtered, apiKey, {
    timeout: args.timeout,
    retries: args.retries,
    maxTokens: args.maxTokens,
    prompt: args.prompt,
    concurrency: args.concurrency,
    onProgress: (done, total, model) => progress.update(done, total, model),
  });
  progress.stop();

  if (!args.quiet) {
    renderTable(results, args.showResponse);
    renderSummary(results);
  }

  if (!args.noReport) {
    const files = writeReports(provider, results, filtered, args);
    if (!args.quiet) console.log(c.dim(`\n  گزارش‌ها: ${files.join(' , ')}`));
  }

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify(
        {
          provider: provider.name,
          baseUrl: provider.baseUrl,
          generatedAt: new Date().toISOString(),
          summary: buildSummary(results),
          results,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  if (args.csv) {
    const rows = [
      ['provider', 'model', 'status', 'verdict', 'free', 'http_status', 'latency_ms', 'detail'],
      ...results.map((r) => [
        r.provider,
        r.model,
        r.status,
        r.status === 'ok' ? 'USABLE' : r.status === 'ratelimit' ? 'USABLE*' : '',
        r.free === null ? '' : String(r.free),
        String(r.httpStatus),
        String(Math.round(r.latencyMs)),
        r.detail,
      ]),
    ];
    writeFileSync(
      args.csv,
      '\ufeff' + rows.map((r) => r.map(csvEscape).join(',')).join('\n'),
      'utf8',
    );
  }

  return results;
}
