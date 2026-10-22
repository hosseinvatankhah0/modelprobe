import { createInterface } from 'node:readline';

import { formatPricing } from './free.js';
import type { Bench, ModelResult, Status } from './types.js';

let colorEnabled = process.stdout.isTTY === true && !process.env.NO_COLOR;

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

function wrap(code: string, text: string): string {
  return colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const c = {
  bold: (s: string) => wrap('1', s),
  dim: (s: string) => wrap('2', s),
  red: (s: string) => wrap('31', s),
  green: (s: string) => wrap('32', s),
  yellow: (s: string) => wrap('33', s),
  blue: (s: string) => wrap('36', s),
  cyan: (s: string) => wrap('36', s),
  magenta: (s: string) => wrap('35', s),
};

export const STATUS_META: Record<Status, { label: string; color: string }> = {
  ok: { label: 'OK', color: '32' },
  ratelimit: { label: 'RATE-LIMIT', color: '33' },
  quota: { label: 'NO-CREDIT', color: '33' },
  auth: { label: 'AUTH-ERR', color: '31' },
  not_found: { label: 'NOT-FOUND', color: '31' },
  bad_request: { label: 'BAD-REQ', color: '31' },
  server: { label: 'SERVER-ERR', color: '35' },
  network: { label: 'NET-ERR', color: '35' },
  timeout: { label: 'TIMEOUT', color: '35' },
  error: { label: 'ERROR', color: '31' },
};

export const VERDICT_META: Record<Status, { label: string; color: string }> = {
  ok: { label: 'USABLE', color: '32' },
  ratelimit: { label: 'USABLE*', color: '33' },
  quota: { label: 'NEED-BAL', color: '33' },
  auth: { label: 'AUTH-FAIL', color: '31' },
  not_found: { label: 'UNAVAILABLE', color: '31' },
  bad_request: { label: 'UNAVAILABLE', color: '31' },
  server: { label: 'TRANSIENT', color: '35' },
  network: { label: 'UNKNOWN', color: '35' },
  timeout: { label: 'UNKNOWN', color: '35' },
  error: { label: 'UNKNOWN', color: '35' },
};

export function statusText(status: Status): string {
  const m = STATUS_META[status] ?? { label: 'ERROR', color: '31' };
  return wrap(m.color, m.label);
}

export function verdictText(status: Status): string {
  const m = VERDICT_META[status] ?? { label: 'UNKNOWN', color: '35' };
  return wrap(m.color, m.label);
}

export function freeText(free: boolean | null): string {
  if (free === true) return wrap('32', 'FREE');
  if (free === false) return wrap('2', 'paid');
  return wrap('2', '?');
}

/** نمایش امتیاز بنچمارک: تخمینی با ~ مشخص می‌شود */
export function benchText(bench?: Bench): string {
  if (!bench || bench.score === null) return c.dim('?');
  if (bench.source === 'estimate') return c.yellow(`~${Math.round(bench.score)}`);
  return c.cyan(String(Math.round(bench.score)));
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** پدینگ بر اساس طول قابل مشاهده (کدهای ANSI حساب نمی‌شوند) */
export function padVisible(text: string, width: number): string {
  const visible = text.replace(ANSI_RE, '').length;
  return text + ' '.repeat(Math.max(0, width - visible));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** نمایش جدول نتایج */
export function renderTable(results: ModelResult[], showResponse = false): void {
  if (!results.length) return;

  const modelWidth = Math.min(46, Math.max(14, ...results.map((r) => r.model.length)));
  const detailWidth = 38;
  const benchWidth = 6;
  const statusWidth = 12;
  const verdictWidth = 13;
  const freeWidth = 6;
  const priceWidth = 22;

  const header = [
    '  #',
    'MODEL'.padEnd(modelWidth),
    'BENCH'.padEnd(benchWidth),
    'STATUS'.padEnd(statusWidth),
    'VERDICT'.padEnd(verdictWidth),
    'FREE'.padEnd(freeWidth),
    'PRICE'.padEnd(priceWidth),
    'TIME'.padStart(8),
    'DETAIL',
  ].join('  ');

  console.log(c.bold(header));
  console.log(c.dim('-'.repeat(header.length + 6)));

  results.forEach((r, i) => {
    const detail = truncate((r.detail ?? '').replace(/\n/g, ' '), detailWidth);
    console.log(
      [
        String(i + 1).padStart(3),
        truncate(r.model, modelWidth).padEnd(modelWidth),
        padVisible(benchText(r.bench), benchWidth),
        padVisible(statusText(r.status), statusWidth),
        padVisible(verdictText(r.status), verdictWidth),
        padVisible(freeText(r.free), freeWidth),
        padVisible(c.dim(truncate(formatPricing(r.pricing), priceWidth)), priceWidth),
        `${Math.round(r.latencyMs)}ms`.padStart(8),
        c.dim(detail),
      ].join('  '),
    );
    if (showResponse && r.response) {
      console.log(`     ${c.green('↳ ' + r.response)}`);
    }
  });
}

/** خلاصه نتایج */
export function renderSummary(results: ModelResult[]): void {
  const counts = new Map<Status, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

  const usable = results.filter((r) => r.status === 'ok');
  const throttled = results.filter((r) => r.status === 'ratelimit');
  const freeModels = results.filter((r) => r.free === true);
  const freeUsable = freeModels.filter((r) => r.status === 'ok' || r.status === 'ratelimit');
  const usableAll = results.filter((r) => r.status === 'ok' || r.status === 'ratelimit');

  console.log('');
  console.log(c.bold('- Summary -'));
  for (const [status, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${padVisible(statusText(status), 20)} ${count}`);
  }
  console.log('');
  console.log(
    `  ${c.green(`Usable: ${usableAll.length}`)}` +
      `   |  ${c.yellow(`Free: ${freeModels.length}`)}` +
      `   |  ${c.bold(`Total: ${results.length}`)}`,
  );

  const ranked = usableAll
    .filter((r) => r.bench?.score !== null && r.bench?.score !== undefined)
    .sort((a, b) => (b.bench?.score ?? 0) - (a.bench?.score ?? 0));

  if (ranked.length) {
    console.log(c.bold('\n  Best models by benchmark score:'));
    for (const r of ranked.slice(0, 10)) {
      const free = r.free === true ? c.green(' [FREE]') : '';
      const score = benchText(r.bench);
      console.log(
        `    ${padVisible(score, 6)}  ${r.model}${free}` + c.dim(`  ${Math.round(r.latencyMs)}ms`),
      );
    }
  }

  if (freeUsable.length) {
    console.log(c.bold('\n  Free + usable models:'));
    for (const r of freeUsable) console.log(`    ${c.green('+')} ${r.model}`);
  }
  const paidUsable = usableAll.filter((r) => r.free === false);
  if (paidUsable.length) {
    console.log(c.bold('\n  Paid + usable models:'));
    for (const r of paidUsable) console.log(`    ${c.blue('*')} ${r.model}`);
  }
}

/** نوار پیشرفت ساده */
export class Progress {
  private active = false;
  private timer?: NodeJS.Timeout;

  start(total: number): void {
    if (!process.stdout.isTTY) return;
    this.active = true;
    this.timer = setInterval(() => {
      this.render(total, 0, '');
    }, 120);
    this.timer.unref?.();
  }

  update(done: number, total: number, model: string): void {
    if (!this.active) return;
    this.render(total, done, model);
  }

  private render(total: number, done: number, model: string): void {
    const width = 24;
    const ratio = total > 0 ? done / total : 0;
    const filled = Math.round(ratio * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const line = `  ${c.cyan(bar)} ${done}/${total} ${c.dim(truncate(model, 40))}`;
    process.stdout.write(`\r${line.padEnd(100)}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active) {
      process.stdout.write('\r' + ' '.repeat(100) + '\r');
      this.active = false;
    }
  }
}

/**
 * پرسش متنی.
 * در حالت TTY از readline (با پشتیبانی از ویرایش خط) و در حالت pipe
 * از یک خواننده‌ی خطی ساده استفاده می‌شود.
 */
let ttyRl: ReturnType<typeof createInterface> | undefined;
const queuedLines: string[] = [];
const lineWaiters: Array<(line: string) => void> = [];
let pipeStarted = false;
let pipeBuffer = '';

function startPipeReader(): void {
  if (pipeStarted) return;
  pipeStarted = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    pipeBuffer += chunk;
    let index = pipeBuffer.indexOf('\n');
    while (index >= 0) {
      const line = pipeBuffer.slice(0, index).replace(/\r$/, '');
      pipeBuffer = pipeBuffer.slice(index + 1);
      const waiter = lineWaiters.shift();
      if (waiter) waiter(line);
      else queuedLines.push(line);
      index = pipeBuffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    if (pipeBuffer.length) {
      const waiter = lineWaiters.shift();
      waiter?.(pipeBuffer);
      pipeBuffer = '';
    }
    while (lineWaiters.length) lineWaiters.shift()?.('');
  });
}

function getTtyRl(): ReturnType<typeof createInterface> {
  if (!ttyRl) {
    ttyRl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
  }
  return ttyRl;
}

export function closePrompts(): void {
  ttyRl?.close();
  ttyRl = undefined;
}

export function ask(question: string, defaultValue = ''): Promise<string> {
  if (process.stdin.isTTY) {
    const rl = getTtyRl();
    return new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim() || defaultValue));
    });
  }

  startPipeReader();
  process.stdout.write(question);
  return new Promise((resolve) => {
    const finish = (line: string): void => resolve(line.trim() || defaultValue);
    const queued = queuedLines.shift();
    if (queued !== undefined) finish(queued);
    else lineWaiters.push(finish);
  });
}

/** پرسش با پنهان کردن ورودی (برای api key) */
export function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return ask(question);
  }

  const rl = getTtyRl();
  const internal = rl as unknown as { _writeToOutput?: (str: string) => void };
  const original = internal._writeToOutput?.bind(rl);

  return new Promise((resolve) => {
    let muted = false;
    internal._writeToOutput = (str: string): void => {
      if (!original) return;
      original(muted ? '*'.repeat(str.length) : str);
    };

    rl.question(question, (answer) => {
      muted = false;
      internal._writeToOutput = original;
      process.stdout.write('\n');
      resolve(answer.trim());
    });

    muted = true;
  });
}
