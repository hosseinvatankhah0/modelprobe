/**
 * modelprobe — کتابخانه و CLI
 *
 * نمونه استفاده به صورت کتابخانه:
 * ```ts
 * import { probeProvider } from 'modelprobe';
 *
 * const report = await probeProvider(
 *   { name: 'custom', baseUrl: 'https://api.deepseek.com', style: 'openai' },
 *   'sk-xxx',
 * );
 *
 * console.log(report.summary.freeUsable); // تعداد مدل‌های رایگانِ قابل استفاده
 * ```
 */
export { getBuiltinProvider, listBuiltinProviders, BUILTIN_PROVIDERS } from './providers.js';
export {
  chatUrlCandidates,
  discoverModels,
  filterModels,
  listUrlCandidates,
  parseModels,
  runTests,
  testModel,
  NON_CHAT_RE,
} from './probe.js';
export { detectFree, formatPricing, parsePricing } from './free.js';
export { extractError, httpJson, redact } from './http.js';
export { buildSummary, resolveApiKey, runProvider } from './runner.js';
export type {
  ApiStyle,
  HttpResult,
  ModelInfo,
  ModelResult,
  Pricing,
  ProbeOptions,
  Provider,
  ProviderReport,
  Status,
  Summary,
} from './types.js';

import { discoverModels, filterModels, runTests } from './probe.js';
import { buildSummary } from './runner.js';
import type { ModelInfo, ModelResult, Provider, ProbeOptions, ProviderReport } from './types.js';

/**
 * اجرای یک پروب کامل روی یک پرووایدر: کشف مدل‌ها + تست واقعی همه.
 */
export async function probeProvider(
  provider: Provider,
  apiKey: string,
  options: ProbeOptions & { freePattern?: RegExp } = {},
): Promise<ProviderReport & { models: ModelInfo[] }> {
  const discovery = await discoverModels(provider, apiKey, options);
  const models = filterModels(discovery.models, options);
  const results: ModelResult[] = await runTests(provider, models, apiKey, options);
  return {
    provider: provider.name,
    baseUrl: provider.baseUrl,
    style: provider.style,
    generatedAt: new Date().toISOString(),
    summary: buildSummary(results),
    results,
    models,
  };
}
