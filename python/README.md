# modeltest

ابزار کوچکی برای تست سریع مدل‌های هر پرووایدر با `base_url` و `api_key`.  
فقط با پایتون استاندارد اجرا میشه، نیازی به نصب پکیج نداره.

## قابلیت‌ها

- **کشف خودکار مدل‌ها**: تلاش برای گرفتن لیست از `GET /models` با چند الگوی مختلف
- **تست واقعی**: یه درخواست کوچک چت می‌فرسته تا مطمئن شه مدل واقعاً کار می‌ده
- **دسته‌بندی خطاها**: `AUTH-ERR` / `NO-CREDIT` / `RATE-LIMIT` / `BAD-REQ` / `NOT-FOUND` و...
- **فیلتر مدل‌های غیرچت**: بطور پیش‌فرض مدل‌های `embedding`, `tts`, `whisper`, `rerank`, `dall-e` و مشابه فیلتر میشه
- **اجرای موازی**: با `--workers` میشه سریع‌تر تست بزنی
- **پشتیبانی از APIهای مختلف**: OpenAI-Compatible, Anthropic, Gemini
- **پشتیبانی از سرورهای محلی**: Ollama, LMStudio, vLLM, LocalAI, OpenWebUI, OneAPI/NewAPI
- **گزارش خودکار**: فایل‌های `JSON` و `CSV` توی پوشه `reports/` ذخیره میشه

## شروع سریع

فقط با base_url و api_key تست کن:

```bash
python modeltest.py --base-url https://api.deepseek.com --api-key sk-xxxx
python modeltest.py --base-url https://openrouter.ai/api/v1 --api-key sk-or-v1-xxxx
python modeltest.py --base-url http://localhost:11434/v1 --api-key ollama
```

اگه میشه کلید رو توی متغیر محیطی بزنی بهتره:

```bash
# Windows (cmd)
set DEEPSEEK_API_KEY=sk-xxxx

# Windows (PowerShell)
$env:DEEPSEEK_API_KEY="sk-xxxx"

# Linux/Mac
export DEEPSEEK_API_KEY=sk-xxxx
```

بعد فقط بنویس:

```bash
python modeltest.py --provider deepseek
```

## استفاده با پرووایدرهای از پیش تعریف شده

لیست پرووایدرهای شناخته‌شده:

```bash
python modeltest.py --providers
```

تست یه یا چند پرووایدر:

```bash
python modeltest.py --provider openai,openrouter,groq
```

تست **همه** پرووایدرهایی که کلید دارن:

```bash
python modeltest.py --provider all
```

## مدیریت کلیدها

می‌تونی کلید رو مستقیم توی `keys.local.json` ذخیره کنی:

```bash
python modeltest.py --set-key openrouter sk-or-v1-xxxx
```

یا فایل نمونه رو کپی کنی:

```bash
copy keys.local.example.json keys.local.json
```

اولویت خواندن کلید: `--api-key` > `keys.local.json` > متغیر محیطی (`<PROVIDER>_API_KEY`)

## گزینه‌های پرکاربرد

| گزینه | توضیح |
|---|---|
| `--model gpt-4o --model gpt-4o-mini` | تست فقط مدل‌های مشخص |
| `--list-only` | فقط لیست مدل‌ها رو نشون بده، تست نکن |
| `--grep regex` | فیلتر با regex روی اسم مدل |
| `--skip regex` | حذف مدل‌های مطابق regex |
| `--limit 30` | محدود کردن تعداد مدل برای تست |
| `--include-non-chat` | شامل کردن مدل‌های embedding/tts/whisper هم |
| `--workers 10` | افزایش تعداد درخواست‌های موازی |
| `--prompt "..."` | تغییر متن تست |
| `--max-tokens 32` | تغییر تعداد توکن تست |
| `--timeout 60` | افزایش تایم‌اوت |
| `--show-response` | نمایش پاسخ کوتاه هر مدل |
| `--json out.json` / `--csv out.csv` | ذخیره خروجی در فایل دلخواه |

## تفسیر نتایج

| STATUS | VERDICT | توضیح |
|---|---|---|
| `OK` | `USABLE` | مدل کاملاً قابل استفاده هست |
| `RATE-LIMIT` | `USABLE*` | کلید معتبره ولی الان محدود شده، میشه استفاده کنی (فقط کمی کند/محدود) |
| `NO-CREDIT` | `NEED-BAL` | کلید معتبره ولی اعتبار/بالانس نداره، باید شارژ کنی |
| `AUTH-ERR` | `AUTH-FAIL` | کلید اشتباهه یا نامعتبره |
| `BAD-REQ` | `UNAVAILABLE` | مدل موجود نیست یا با فرمت این پرووایدر سازگار نیست |
| `NOT-FOUND` | `UNAVAILABLE` | مدل پیدا نشد |
| `SERVER-ERR` | `TRANSIENT` | خطای موقت سرور، میشه دوباره تست کنی |
| `NET-ERR`/`TIMEOUT` | `UNKNOWN` | مشکل شبکه/تایم‌اوت |

فقط مدل‌هایی با `USABLE` یا `USABLE*` رو میشه واقعاً استفاده کنی.

## پرووایدرهای سفارشی

اگه پرووایدرت توی لیست نیست، میشه توی `providers.local.json` اضافه کنی.

```json
{
  "providers": {
    "my-gateway": {
      "base_url": "https://gateway.example.com/v1",
      "api_key_env": "MY_GATEWAY_KEY",
      "style": "openai"
    }
  }
}
```

سپس:

```bash
python modeltest.py --provider my-gateway
```

همچنین میشه مستقیم تست کنی بدون تعریف پرووایدر:

```bash
python modeltest.py --base-url https://gateway.example.com/v1 --api-key sk-xxx --style openai
```

## تست با سرور محلی

```bash
# Ollama
ollama pull llama-3.1-8b
python modeltest.py --base-url http://localhost:11434/v1 --api-key ollama

# LMStudio (OpenAI Compatible فعال باشه)
python modeltest.py --base-url http://localhost:1234/v1 --api-key lmstudio

# vLLM
vllm serve meta-llama/Llama-3.1-8B-Instruct
python modeltest.py --base_url http://localhost:8000/v1 --api-key vllm
```

## گزارش‌ها

بعد هر تست، دو فایل توی `reports/` ساخته میشه:

- `PROVIDER-YYYYMMDD-HHMMSS.json` - کامل با جزئیات
- `PROVIDER-YYYYMMDD-HHMMSS.csv` - مناسب اکسل/گوگل شیت

## تست با mock server (توسعه)

اگه میخوای بدون کلید واقعی تست کنی:

```bash
# ترمینال ۱
python mock_provider.py

# ترمینال ۲
python modeltest.py --base-url http://127.0.0.1:8888/v1 --api-key test-key
```

## نکات

- اگه پرووایدر `base_url` رو بدون `/v1` بدی هم کار می‌کنه (اسکریپت خودشو تطبیق می‌ده)
- برای Anthropic از `--style anthropic` استفاده کن یا از `--provider anthropic`
- برای Gemini از `--provider gemini` استفاده کن
- اگه مدل‌هات خیلی زیادن از `--limit` یا `--grep` استفاده کن تا سریع‌تر شه
