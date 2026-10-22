#!/usr/bin/env node
import { getBuiltinProvider, listBuiltinProviders } from './providers.js';
import { parseArgs, type CliArgs } from './args.js';
import { KEYS_FILE, loadRankFile, readKeys, runProvider, writeKeys } from './runner.js';
import { ask, askSecret, c, closePrompts, renderSummary, renderTable, setColor } from './ui.js';
import type { ApiStyle, ModelResult, Provider } from './types.js';

const VERSION = '0.2.0';

const HELP = `
${c.bold('modelprober')} - probe any LLM API and find out which models work (and which are free)

${c.bold('Quick start')}
  npx modelprober
  npx modelprober --base-url https://api.deepseek.com --api-key sk-xxx
  npx modelprober --provider openrouter --free-only

${c.bold('Options')}
  -b, --base-url <url>     API base URL
  -k, --api-key <key>      API key
      --key-env <name>     Read the key from an environment variable
  -p, --provider <name>    Known provider (comma separated for several)
      --providers          List known providers
      --style <style>      openai | anthropic | gemini
  -m, --model <id>         Only test these models (repeatable / comma separated)
      --list-only          Only list models, do not test
      --free-only          Only test models detected as free
      --free-pattern <re>  Custom regex to mark models as free
      --grep <re>          Keep only models matching the regex
      --skip <re>          Drop models matching the regex
      --limit <n>          Max number of models to test
      --include-non-chat   Also test embedding / tts / image models
      --sort <mode>        bench (default) | speed | name | free
      --rank-file <file>   Custom benchmark scores as JSON {"model-id": 1350}
      --prompt <text>      Test prompt (default: "Reply with exactly: OK")
      --max-tokens <n>     Max tokens for the test request
      --timeout <ms>       Per-request timeout
  -w, --concurrency <n>    Parallel requests (default: 8)
      --retries <n>        Retries on 429/5xx
      --show-response      Print the model's short answer
      --json <file>        Write a JSON report
      --report-dir <dir>   Where reports are stored (default: ~/.modelprobe/reports)
      --no-report          Do not write reports
  -i, --interactive        Force interactive mode
      --no-color           Disable colors
  -q, --quiet              Quiet output
  -v, --version            Print version
  -h, --help               Show this help

${c.bold('Subcommands')}
  modelprobe providers               List known providers
  modelprobe keys set <name> <key>   Store a key
  modelprobe keys list               List stored keys
  modelprobe keys remove <name>      Remove a key

${c.bold('Notes')}
  BENCH column = capability score (Elo-style). "~" means it is an estimate for a
  model that is not in the bundled dataset. Use --rank-file to override scores.
  Only USABLE and USABLE* models are safe to use.
`;

function cmdProviders(): void {
  console.log(c.bold('\nKnown providers:\n'));
  console.log(`  ${'NAME'.padEnd(14)} ${'STYLE'.padEnd(11)} ${'BASE URL'.padEnd(48)} ENV KEY`);
  console.log(c.dim('  ' + '-'.repeat(98)));
  for (const p of listBuiltinProviders()) {
    const hasKey = p.apiKeyEnv && process.env[p.apiKeyEnv] ? c.green('yes') : '-';
    console.log(
      `  ${p.name.padEnd(14)} ${p.style.padEnd(11)} ${p.baseUrl.padEnd(48)} ${(p.apiKeyEnv ?? '-').padEnd(24)} ${hasKey}`,
    );
  }
  console.log(c.dim('\n  "yes" = an API key for that provider is present in the environment\n'));
}

function cmdKeys(argv: string[]): void {
  const [action, name, value] = argv;
  const keys = readKeys();

  if (action === 'set' && name && value) {
    keys[name] = value;
    writeKeys(keys);
    console.log(c.green(`  Stored key for "${name}" (${KEYS_FILE})`));
    return;
  }
  if (action === 'remove' && name) {
    if (name in keys) {
      delete keys[name];
      writeKeys(keys);
      console.log(c.green(`  Removed key for "${name}"`));
    } else {
      console.log(c.yellow(`  No key stored for "${name}"`));
    }
    return;
  }
  if (action === 'list' || !action) {
    const names = Object.keys(keys);
    if (!names.length) {
      console.log(c.dim('  No keys stored.'));
      return;
    }
    console.log(c.bold('\nStored keys:\n'));
    for (const n of names) console.log(`  ${n.padEnd(16)} ${c.dim('********')}`);
    console.log('');
    return;
  }
  console.log(c.yellow('  Usage: modelprobe keys set <name> <key> | list | remove <name>'));
}

/** تشخیص خودکار نوع API از روی آدرس */
function guessStyle(baseUrl: string): ApiStyle {
  const url = baseUrl.toLowerCase();
  if (url.includes('anthropic')) return 'anthropic';
  if (url.includes('generativelanguage') || url.includes('googleapis')) return 'gemini';
  return 'openai';
}

async function interactiveSetup(): Promise<Provider> {
  console.log(c.bold('\nmodelprober - probe any LLM API\n'));
  const answer = await ask(
    '  Base URL or provider name (e.g. openrouter, deepseek, ollama): ',
  );

  const builtin = getBuiltinProvider(answer);
  if (builtin) {
    console.log(c.dim(`  -> ${builtin.baseUrl}  (${builtin.style})`));
    return builtin;
  }
  if (!answer) {
    console.log(c.red('  No URL given.'));
    process.exit(1);
  }
  const detected = guessStyle(answer);
  console.log(c.dim(`  -> ${answer.replace(/\/+$/, '')}  (${detected}, override with --style)`));
  return { name: 'custom', baseUrl: answer.replace(/\/+$/, ''), style: detected };
}

async function askApiKey(provider: Provider): Promise<string> {
  const envHint = provider.apiKeyEnv ? ` (suggested env var: ${provider.apiKeyEnv})` : '';
  return askSecret(`  API key${envHint}: `);
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
    console.log(`modelprober ${VERSION}`);
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

  let rankMap: Map<string, number> | undefined;
  if (args.rankFile) {
    try {
      rankMap = loadRankFile(args.rankFile);
    } catch (err) {
      console.error(c.red(`  ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  }

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
        console.error(c.red(`  Unknown provider: ${name}  (try: modelprobe providers)`));
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
    const results = await runProvider(provider, args, keys, askApiKey, rankMap);
    allResults.push(...results);
  }

  if (providers.length > 1 && allResults.length) {
    console.log(c.bold('\n\n=== All providers ==='));
    renderTable(allResults);
    renderSummary(allResults);
  }
}

main()
  .catch((err) => {
    console.error(c.red(`\n  Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  })
  .finally(() => closePrompts());
