/**
 * اجرای تست‌ها روی همه‌ی نسخه‌های Node
 *
 * `node --test` با گلوب فقط از Node 22 به بعد کار می‌کنه و با پوشه فقط از
 * Node 24 به بعد. برای اینکه تست روی Node 18/20/22/24 یکسان اجرا بشه،
 * فایل‌های تست رو خودمون پیدا می‌کنیم و صریح به Node می‌دیم.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = 'test';

if (!existsSync(TEST_DIR)) {
  console.error(`test directory not found: ${TEST_DIR}`);
  process.exit(1);
}

const files = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(TEST_DIR, name));

if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
