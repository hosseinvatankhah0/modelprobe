/** کپی فایل‌های داده به پوشه dist (تا داخل پکیج npm هم باشند) */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataFiles = ['benchmarks.json'];

for (const file of dataFiles) {
  const from = join(root, 'src', file);
  const to = join(root, 'dist', file);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${file} -> dist/`);
}
