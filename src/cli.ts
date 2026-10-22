#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

import { DEFAULT_ARGS, parseArgs, type CliArgs } from './args.js';
import { getBuiltinProvider, listBuiltinProviders } from './providers.js';
import { KEYS_FILE, readKeys, runProvider, writeKeys } from './runner.js';
import { ask, askSecret, c, closePrompts, renderSummary, renderTable, setColor } from './ui.js';
import type { ApiStyle, ModelResult, Provider } from './types.js';

const VERSION = '0.1.0';

const HELP = `
${c.bold('modelprobe')} — تست مدل‌های هر API و پیدا کردن مدل‌های رایگان

${c.bold('استفاده سریع')}
  npx modelprobe
  npx modelprobe --base-url https://api.deepseek.com --api-key sk-xxx
  npx modelprobe --provider openrouter --free-only

${c.bold('گزینه‌ها')}
  -b, --base-url <url>     آدرس پایه API
  -k, --api-key <key>      کلید API
      --key-env <name>     خواندن کلید از متغیر محیطی
  -p, --provider <name>    پرووایدر معروف (یا چند نام با کاما)
      --providers          لیست پرووایدرهای معروف
      --style <style>      openai | anthropic | gemini
  -m, --model <id>         فقط این مدل‌ها (قابل تکرار یا کاما)
      --list-only          فقط لیست مدل‌ها
      --free-only          فقط مدل‌های رایگان
      --free-pattern <re>  الگوی دلخواه برای تشخیص رایگان
      --grep <re>          فیلتر مدل‌ها
      --skip <re>          حذف مدل‌ها
      --limit <n>          حداکثر تعداد مدل
      --include-non-chat   شامل مدل‌های embedding/tts و...
      --prompt <text>      متن تست
      --max-tokens <n>     توکن خروجی تست
      --timeout <ms>       تایم‌اوت درخواست
  -w, --concurrency <n>    تعداد درخواست موازی (پیش‌فرض 8)
      --retries <n>        تعداد تلاش مجدد
      --show-response      نمایش پاسخ مدل
      --json <file>        ذخیره گزارش JSON
      --csv <file>         ذخیره گزارش CSV
      --report-dir <dir>   مسیر گزارش‌ها
      --no-report          بدون ذخیره گزارش
  -i, --interactive        حالت تعاملی
      --no-color           بدون رنگ
  -q, --quiet              کم‌حرف
  -v, --version            نسخه
  -h, --help               این راهنما

${c.bold('دستورها')}
  modelprobe providers              لیست پرووایدرهای معروف
  modelprobe keys set <name> <key>  ذخیره کلید
  modelprobe keys list              لیست کلیدهای ذخیره‌شده
  modelprobe keys remove <name>     حذف کلید
`;

function cmdProviders(): void {
  console.log(c.bold('\nپرووایدرهای شناخته‌شده:\n'));
  console.log(`  ${'NAME'.padEnd(14)} ${'STYLE'.padEnd(11)} ${'BASE URL'.padEnd(48)} ENV KEY`);
  console.log(c.dim('  ' + '-'.repeat(98)));
  for (const p of listBuiltinProviders()) {
    const hasKey = p.apiKeyEnv && process.env[p.apiKeyEnv] ? c.green('✔') : ' ';
    console.log(
      `  ${p.name.padEnd(14)} ${p.style.padEnd(11)} ${p.baseUrl.padEnd(48)} ${(p.apiKeyEnv ?? '-').padEnd(24)} ${hasKey}`,
    );
  }
  console.log(c.dim('\n  ✔ = کلید در متغیر محیطی موجود است\n'));
}

function cmdKeys(argv: string[]): void {
  const [action, name, value] = argv;
  const keys = readKeys();

  if (action === 'set' && name && value) {
    keys[name] = value;
    writeKeys(keys);
    console.log(c.green(`  کلید «${name}» ذخیره شد (${KEYS_FILE})`));
    return;
  }
  if (action === 'remove' && name) {
    if (name in keys) {
      delete keys[name];
      writeKeys(keys);
      console.log(c.green(`  کلید «${name}» حذف شد`));
    } else {
      console.log(c.yellow(`  کلیدی به نام «${name}» نبود`));
    }
    return;
  }
  if (action === 'list' || !action) {
    const names = Object.keys(keys);
    if (!names.length) {
      console.log(c.dim('  هیچ کلیدی ذخیره نشده است.'));
      return;
    }
    console.log(c.bold('\nکلیدهای ذخیره‌شده:\n'));
    for (const n of names) console.log(`  ${n.padEnd(16)} ${c.dim('••••••••')}`);
    console.log('');
    return;
  }
  console.log(c.yellow('  استفاده: modelprobe keys set <name> <key> | list | remove <name>'));
}

/** تشخیص خودکار نوع API از روی آدرس */
function guessStyle(baseUrl: string): ApiStyle {
  const url = baseUrl.toLowerCase();
  if (url.includes('anthropic')) return 'anthropic';
  if (url.includes('generativelanguage') || url.includes('googleapis')) return 'gemini';
  return 'openai';
}

async function interactiveSetup(): Promise<Provider> {
  console.log(c.bold('\n🔍  modelprobe — تست مدل‌های API\n'));
  const answer = await ask(
    '  Base URL یا اسم پرووایدر (مثلاً openrouter، deepseek، ollama): ',
  );

  const builtin = getBuiltinProvider(answer);
  if (builtin) {
    console.log(c.dim(`  → ${builtin.baseUrl}  (${builtin.style})`));
    return builtin;
  }
  if (!answer) {
    console.log(c.red('  آدرسی وارد نشد.'));
    process.exit(1);
  }
  const detected = guessStyle(answer);
  const style = (await ask(
    `  نوع API [openai/anthropic/gemini] (پیش‌فرض ${detected}): `,
    detected,
  )) as ApiStyle;
  return { name: 'custom', baseUrl: answer.replace(/\/+$/, ''), style };
}

async function askApiKey(provider: Provider): Promise<string> {
  const envHint = provider.apiKeyEnv ? ` (متغیر محیطی پیشنهادی: ${provider.apiKeyEnv})` : '';
  return askSecret(`  API Key${envHint}: `);
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(c.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (args.noColor) setColor(false);
  if (args.version) {
    console.log(`modelprobe ${VERSION}`);
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.subcommand === 'providers' || args.subcommand === 'provider') {
    cmdProviders();
    return;
  }
  if (args.subcommand === 'keys') {
    cmdKeys(process.argv.slice(3));
    return;
  }
  if (args.subcommand === 'help') {
    console.log(HELP);
    return;
  }

  const keys = readKeys();

  const providers: Provider[] = [];
  if (args.baseUrl) {
    providers.push({
      name: 'custom',
      baseUrl: args.baseUrl.replace(/\/+$/, ''),
      style: args.style ?? 'openai',
    });
  } else if (args.provider) {
    for (const name of args.provider.split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const found = getBuiltinProvider(name);
      if (!found) {
        console.error(c.red(`  پرووایدر ناشناخته: ${name}  (modelprobe providers)`));
        continue;
      }
      providers.push(found);
    }
  } else if (args.interactive || process.stdin.isTTY) {
    providers.push(await interactiveSetup());
  } else {
    console.log(HELP);
    return;
  }

  if (!providers.length) return;

  const allResults: ModelResult[] = [];
  for (const provider of providers) {
    const results = await runProvider(provider, args, keys, askApiKey);
    allResults.push(...results);
  }

  if (providers.length > 1 && allResults.length) {
    console.log(c.bold('\n\n═══ جمع‌بندی همه پرووایدرها ═══'));
    renderTable(allResults);
    renderSummary(allResults);
  }
}

main()
  .catch((err) => {
    console.error(c.red(`\n  خطا: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  })
  .finally(() => closePrompts());
