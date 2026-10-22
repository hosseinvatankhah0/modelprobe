import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ApiStyle } from './types.js';

export interface CliArgs {
  baseUrl?: string;
  apiKey?: string;
  keyEnv?: string;
  provider?: string;
  style?: ApiStyle;
  models: string[];
  listOnly: boolean;
  grep?: string;
  skip?: string;
  limit: number;
  includeNonChat: boolean;
  freeOnly: boolean;
  freePattern?: string;
  prompt: string;
  maxTokens: number;
  timeout: number;
  concurrency: number;
  retries: number;
  showResponse: boolean;
  json?: string;
  csv?: string;
  reportDir: string;
  noReport: boolean;
  interactive: boolean;
  noColor: boolean;
  quiet: boolean;
  version: boolean;
  help: boolean;
  subcommand?: string;
}

export const DEFAULT_ARGS: CliArgs = {
  models: [],
  listOnly: false,
  limit: 0,
  includeNonChat: false,
  freeOnly: false,
  prompt: 'Reply with exactly: OK',
  maxTokens: 16,
  timeout: 30_000,
  concurrency: 8,
  retries: 2,
  showResponse: false,
  reportDir: join(homedir(), '.modelprobe', 'reports'),
  noReport: false,
  interactive: false,
  noColor: false,
  quiet: false,
  version: false,
  help: false,
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { ...DEFAULT_ARGS, models: [] };
  const rest: string[] = [];

  const takeValue = (i: number, inline: string | undefined, name: string): string => {
    if (inline !== undefined) return inline;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) {
      throw new Error(`گزینه ${name} به یک مقدار نیاز دارد`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;

    switch (flag) {
      case '-b':
      case '--base-url':
        args.baseUrl = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '-k':
      case '--api-key':
        args.apiKey = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '--key-env':
        args.keyEnv = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '-p':
      case '--provider':
        args.provider = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '--style':
        args.style = takeValue(i, inline, flag) as ApiStyle;
        if (inline === undefined) i++;
        break;
      case '-m':
      case '--model': {
        const value = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        args.models.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
        break;
      }
      case '--list-only':
        args.listOnly = true;
        break;
      case '--free-only':
        args.freeOnly = true;
        break;
      case '--free-pattern':
        args.freePattern = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '--grep':
        args.grep = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '--skip':
        args.skip = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '--limit':
        args.limit = Number.parseInt(takeValue(i, inline, flag), 10);
        if (inline === undefined) i++;
        break;
      case '--include-non-chat':
        args.includeNonChat = true;
        break;
      case '--prompt':
        args.prompt = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '--max-tokens':
        args.maxTokens = Number.parseInt(takeValue(i, inline, flag), 10);
        if (inline === undefined) i++;
        break;
      case '--timeout':
        args.timeout = Number.parseInt(takeValue(i, inline, flag), 10);
        if (inline === undefined) i++;
        break;
      case '-w':
      case '--concurrency':
        args.concurrency = Number.parseInt(takeValue(i, inline, flag), 10);
        if (inline === undefined) i++;
        break;
      case '--retries':
        args.retries = Number.parseInt(takeValue(i, inline, flag), 10);
        if (inline === undefined) i++;
        break;
      case '--show-response':
        args.showResponse = true;
        break;
      case '--json':
        args.json = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '--csv':
        args.csv = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '--report-dir':
        args.reportDir = takeValue(i, inline, flag);
        if (inline === undefined) i++;
        break;
      case '--no-report':
        args.noReport = true;
        break;
      case '-i':
      case '--interactive':
        args.interactive = true;
        break;
      case '--no-color':
        args.noColor = true;
        break;
      case '-q':
      case '--quiet':
        args.quiet = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (flag.startsWith('-')) throw new Error(`گزینه ناشناخته: ${flag}`);
        rest.push(raw);
    }
  }

  if (rest.length) args.subcommand = rest[0];
  return args;
}
