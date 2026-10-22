# modelprobe

> **Probe any LLM API with a key — find out which models actually respond, and which ones are free.**

[![npm](https://img.shields.io/npm/v/modelprober)](https://www.npmjs.com/package/modelprober)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](./package.json)

`modelprobe` takes a **base URL** + **API key**, discovers every model the provider exposes, sends a
real (tiny) request to each one, and tells you exactly what works:

- ✅ which models respond
- 🆓 which of them are **free**
- 💸 which ones cost money (and how much, per 1M tokens)
- 🔑 whether your key is valid, out of credit, or just rate-limited

Works with **any OpenAI-compatible endpoint** (OpenAI, DeepSeek, Groq, OpenRouter, Together, Mistral,
xAI, Cerebras, SiliconFlow, Moonshot, GLM, Qwen, OneAPI/NewAPI, vLLM, Ollama, LM Studio, …) plus
**Anthropic** and **Google Gemini** style APIs.

---

## Install

```bash
npm i -g modelprober
# یا بدون نصب:
npx modelprober
```

Requires Node.js 18+. No runtime dependencies.

> **نکته:** اسم پکیج روی npm **`modelprober`** هست (`modelprobe` قبلاً توسط پکیج دیگری رزرو شده بود و npm اسم مشابه رو بلاک می‌کرد).
> بعد از نصب، هر دو دستور `modelprober` و `modelprobe` کار می‌کنن.

---

## Quick start

### حالت تعاملی (ساده‌ترین راه)

```bash
npx modelprober
```

```
🔍  modelprobe — تست مدل‌های API

  Base URL یا اسم پرووایدر (مثلاً openrouter، deepseek، ollama): openrouter
  → https://openrouter.ai/api/v1  (openai)
  API Key (متغیر محیطی پیشنهادی: OPENROUTER_API_KEY): ********
```

The API key is read from the terminal **without echoing** it.

### با فلگ

```bash
npx modelprober --base-url https://api.deepseek.com --api-key sk-xxx
npx modelprober --provider openrouter --free-only
npx modelprober --provider openai,deepseek,groq
npx modelprober --base-url http://localhost:11434/v1 --api-key ollama
```

### فقط مدل‌های رایگان

```bash
npx modelprober --provider openrouter --free-only
```

---

## Sample output

```
--- openrouter  https://openrouter.ai/api/v1 ---
  Discovered 312 models  https://openrouter.ai/api/v1/models
  Testing 40 models with 8 parallel workers ...

  #  MODEL                             BENCH   STATUS        VERDICT        FREE   PRICE                      TIME  DETAIL
--------------------------------------------------------------------------------------------------------------
  1  anthropic/claude-sonnet-4        1430    OK            USABLE         paid   in 3/1M · out 15/1M        712ms  ok
  2  deepseek/deepseek-r1             1395    OK            USABLE         paid   in 0.55/1M · out 2.19/1M    640ms  ok
  3  meta-llama/llama-3.3-70b:free    1245    OK            USABLE         FREE   in 0/1M · out 0/1M          480ms  ok
  4  qwen/qwen-2.5-7b-instruct        1170    RATE-LIMIT    USABLE*        ?      ?                          120ms  Rate limit exceeded
  5  some/paid-model                  1240    NO-CREDIT     NEED-BAL       paid   in 3/1M · out 15/1M            95ms  insufficient balance
  6  vendor/ghost-model               ~1180   BAD-REQ       UNAVAILABLE    ?      ?                           88ms  model not found

- Summary -
  OK                     2
  RATE-LIMIT             1
  NO-CREDIT              1
  BAD-REQ                1

  Usable: 3   |  Free: 1   |  Total: 6

  Best models by benchmark score:
    1430    anthropic/claude-sonnet-4  712ms
    1395    deepseek/deepseek-r1  640ms
    1245    meta-llama/llama-3.3-70b:free [FREE]  480ms

  Free + usable models:
    + meta-llama/llama-3.3-70b:free

  Paid + usable models:
    * anthropic/claude-sonnet-4
    * deepseek/deepseek-r1
```

---

## Benchmark ranking (BENCH column)

Results are **sorted by model capability first, response speed second**, so the strongest model
that actually answers shows up at the top.

- The `BENCH` column is an Elo-style capability score from a bundled snapshot of public
  leaderboards (`src/benchmarks.json`, ~120 model families).
- `~` means the model is **not** in the dataset and the score is a heuristic estimate based on
  family/size hints (`70b` > `8b`, `pro` > `mini`, `preview` gets a penalty, ...).
- Override or extend the scores with your own file:

```json
{
  "my-provider/my-best-model": 1500,
  "gpt-4o": 1360
}
```

```bash
npx modelprober --provider openrouter --rank-file ./ranks.json
```

### Sort modes

| `--sort` | Order |
|---|---|
| `bench` (default) | strongest first, ties broken by response speed |
| `speed` | fastest response first |
| `name` | alphabetical |
| `free` | free models first, then strongest, then fastest |

---

## Status codes

| STATUS | VERDICT | Meaning |
|---|---|---|
| `OK` | `USABLE` | Model works |
| `RATE-LIMIT` | `USABLE*` | Key is fine, you are just throttled right now |
| `NO-CREDIT` | `NEED-BAL` | Key is valid but the account has no balance/quota |
| `AUTH-ERR` | `AUTH-FAIL` | Key is wrong or revoked |
| `BAD-REQ` | `UNAVAILABLE` | Model does not exist / not compatible with this provider |
| `NOT-FOUND` | `UNAVAILABLE` | Model could not be found |
| `SERVER-ERR` | `TRANSIENT` | Temporary provider-side error |
| `NET-ERR` / `TIMEOUT` | `UNKNOWN` | Network problem or timeout |

Only `USABLE` and `USABLE*` models are safe to use.

---

## How "free" is detected

1. **Pricing from the API** — when `/models` includes pricing (OpenRouter, Azure-style gateways,
   SiliconFlow, …) the prompt/completion price is read. A price of `0` ⇒ **FREE**.
2. **Model name** — names containing `:free` / `free` are treated as free (OpenRouter convention).
3. **Otherwise** → `?` (unknown). Use `--free-pattern <regex>` to add your own rule.

Pricing is normalized to **per 1M tokens** in the table and in the JSON report.

---

## Options

```
-b, --base-url <url>     Base URL of the API
-k, --api-key <key>      API key
    --key-env <name>     Read the key from an environment variable
-p, --provider <name>    Known provider (comma separated for several)
    --providers          List all known providers
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
-h, --help               Show help
```

### Subcommands

```bash
modelprobe providers               # list known providers
modelprobe keys set openrouter sk-or-v1-xxx
modelprobe keys list
modelprobe keys remove openrouter
```

Keys are stored in `~/.modelprobe/keys.json` and are never printed back.

---

## Where the API key comes from

Priority:

1. `--api-key`
2. `--key-env <NAME>`
3. `~/.modelprobe/keys.json`
4. The provider's own env var (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, …)
5. `MODELPROBE_API_KEY`
6. Interactive prompt (hidden input)

---

## Reports

Every run writes a single JSON report to `~/.modelprobe/reports/` (override with `--report-dir`):

- `<provider>-<timestamp>.json` — full detail (status, verdict, latency, pricing, free flag,
  benchmark score, response text)

No CSV is produced; use `--json <file>` if you want the report somewhere specific.

---

## Local / self-hosted models

```bash
# Ollama
ollama pull llama-3.1-8b
npx modelprober --base-url http://localhost:11434/v1 --api-key ollama

# LM Studio (enable the OpenAI-compatible server)
npx modelprober --base-url http://localhost:1234/v1 --api-key lmstudio

# vLLM
npx modelprober --base-url http://localhost:8000/v1 --api-key vllm

# OneAPI / NewAPI / OpenWebUI
npx modelprober --base-url http://localhost:3000/v1 --api-key sk-xxx
```

---

## Use as a library

```ts
import { probeProvider } from 'modelprobe';

const report = await probeProvider(
  { name: 'custom', baseUrl: 'https://api.deepseek.com', style: 'openai' },
  process.env.DEEPSEEK_API_KEY!,
  { concurrency: 8, timeout: 30_000 },
);

console.log(report.summary.usable);      // models that answered
console.log(report.summary.freeUsable);  // free models that answered
console.log(report.results.filter((r) => r.status === 'ok'));
```

---

## فارسی (خلاصه)

- `npx modelprober` → به‌صورت تعاملی آدرس و کلید رو می‌پرسه (کلید پنهان تایپ میشه).
- **خروجی کاملاً انگلیسیه** (برای جلوگیری از به‌هم‌ریختگی جدول‌ها به‌خاطر راست‌به‌چپ بودن).
- ستون `BENCH` = امتیاز توانمندی مدل (سبک Elo). `~` یعنی مدل توی دیتاست داخلی نیست و امتیازش تخمینیه.
- خروجی بر اساس **قدرت مدل** سورت میشه و در امتیاز برابر، **سریع‌ترین** مدل بالاتر میاد.
  با `--sort speed|name|free` میشه حالت دیگه انتخاب کرد.
- با `--rank-file ranks.json` میشه امتیازهای دلخواه خودت رو جایگزین کنی.
- فقط مدل‌های `USABLE` و `USABLE*` قابل استفاده‌ان.
- فقط گزارش **JSON** ساخته میشه (CSV حذف شده) — توی `~/.modelprobe/reports/`.
- نسخه‌ی پایتون هم توی پوشه‌ی [`python/`](./python) هست (بدون npm، همون امکانات).

---

## Development

```bash
git clone https://github.com/hosseinvatankhah0/modelprobe.git
cd modelprobe
npm install
npm run build
npm test
```

The test suite runs against a local mock OpenAI-compatible server — no API key or network needed.

## License

MIT © [hossein](https://github.com/hosseinvatankhah0)

