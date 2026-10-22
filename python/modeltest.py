#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
modeltest.py  —  probe the models of any provider with base_url + api_key

What it does:
  1) auto-discover the model list (GET /models) using several URL patterns
  2) send a real (tiny) chat request to every model
  3) classify errors precisely: auth / quota / rate-limit / not-found / bad-request / server / network
  4) run tests in parallel, write a JSON report, print a colored table

Uses only the Python standard library (no pip install required).

Examples:
    python modeltest.py --base-url https://api.deepseek.com --api-key sk-xxx
    python modeltest.py --provider openai,openrouter --limit 40
    python modeltest.py --provider all
    python modeltest.py --base-url http://localhost:11434/v1 --api-key ollama
    python modeltest.py --base-url ... --model gpt-4o --model claude-3-5-sonnet
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import csv
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

APP_VERSION = "1.0"

HERE = Path(__file__).resolve().parent
PROVIDERS_FILE = HERE / "providers.local.json"
KEYS_FILE = HERE / "keys.local.json"
REPORT_DIR = HERE / "reports"

DEFAULT_PROMPT = "Reply with exactly: OK"
DEFAULT_MAX_TOKENS = 16
DEFAULT_TIMEOUT = 30
DEFAULT_WORKERS = 6
DEFAULT_RETRIES = 2

# models that are not chat/completion models (embedding, image, audio, ...)
NON_CHAT_RE = re.compile(
    r"(?i)(embed|tts|whisper|moderation|rerank|re-rank|dall-?e|gpt-image|imagen|"
    r"stable-diffusion|flux|sdxl|^clip$|clip-|guard-|realtime|audio-|voice-|music-|"
    r"computer-use|^ft:|bge-|gte-|^e5-|nomic-|inpaint|upscale|background-removal|"
    r"speech-to-text|text-to-speech)"
)

# ---------------------------------------------------------------- colors

class C:
    enabled = True

    @classmethod
    def wrap(cls, code: str, s: str) -> str:
        return f"\033[{code}m{s}\033[0m" if cls.enabled else s

    @classmethod
    def dim(cls, s): return cls.wrap("2", s)
    @classmethod
    def bold(cls, s): return cls.wrap("1", s)
    @classmethod
    def green(cls, s): return cls.wrap("32", s)
    @classmethod
    def red(cls, s): return cls.wrap("31", s)
    @classmethod
    def yellow(cls, s): return cls.wrap("33", s)
    @classmethod
    def blue(cls, s): return cls.wrap("36", s)
    @classmethod
    def cyan(cls, s): return cls.wrap("36", s)
    @classmethod
    def magenta(cls, s): return cls.wrap("35", s)


# ---------------------------------------------------------------- statuses

STATUS_META = {
    "ok":          ("OK",          "32"),
    "ratelimit":   ("RATE-LIMIT",  "33"),
    "quota":       ("NO-CREDIT",   "33"),
    "auth":        ("AUTH-ERR",    "31"),
    "not_found":   ("NOT-FOUND",   "31"),
    "bad_request": ("BAD-REQ",     "31"),
    "server":      ("SERVER-ERR",  "35"),
    "network":     ("NET-ERR",     "35"),
    "timeout":     ("TIMEOUT",     "35"),
    "error":       ("ERROR",       "31"),
}

# final verdict per model
VERDICT = {
    "ok":          ("USABLE",     "green"),
    "ratelimit":   ("USABLE*",    "yellow"),
    "quota":       ("NEED-BAL",   "yellow"),
    "auth":        ("AUTH-FAIL",  "red"),
    "not_found":   ("UNAVAILABLE", "red"),
    "bad_request": ("UNAVAILABLE", "red"),
    "server":      ("TRANSIENT",  "magenta"),
    "network":     ("UNKNOWN",    "magenta"),
    "timeout":     ("UNKNOWN",    "magenta"),
    "error":       ("UNKNOWN",    "magenta"),
}


# ---------------------------------------------------------------- dataclasses

@dataclass
class Provider:
    name: str
    base_url: str
    style: str = "openai"           # openai | anthropic | gemini
    api_key_env: str = ""
    api_key: str = ""
    docs: str = ""
    extra_headers: dict = field(default_factory=dict)
    default_models: list = field(default_factory=list)
    source: str = "builtin"        # builtin | local


@dataclass
class HttpResult:
    status: int
    ok: bool
    body: str
    latency_ms: float
    url: str
    error: str = ""


@dataclass
class ModelResult:
    provider: str
    model: str
    request_model: str
    status: str
    http_status: int
    latency_ms: float
    detail: str
    response: str = ""
    verdict: str = ""
    free: bool | None = None
    bench: tuple[float | None, str] | None = None
    endpoint: str = ""


# ---------------------------------------------------------------- utilities

def now_iso() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")


def ts_slug() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def load_json(path: Path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def redact(text: str, key: str) -> str:
    if key and key in text:
        text = text.replace(key, "***")
    return text


def load_dotenv() -> None:
    """Read a simple .env file without external dependencies"""
    env_file = HERE / ".env"
    if not env_file.exists():
        return
    for raw in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k, v)


# ---------------------------------------------------------------- HTTP

def make_opener(direct: bool):
    if direct:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


def http_json(url, method="GET", headers=None, body=None, timeout=DEFAULT_TIMEOUT,
              retries=DEFAULT_RETRIES, direct=False):
    """A JSON request with retry on 429/5xx"""
    payload = None
    hdrs = {
        "User-Agent": f"modeltest/{APP_VERSION}",
        "Accept": "application/json",
    }
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})

    opener = make_opener(direct)
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=payload, headers=hdrs, method=method)
        t0 = time.perf_counter()
        try:
            with opener.open(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                return HttpResult(resp.status, True, raw,
                                  (time.perf_counter() - t0) * 1000.0, url)
        except urllib.error.HTTPError as e:
            raw = ""
            try:
                raw = e.read().decode("utf-8", "replace")
            except Exception:
                pass
            lat = (time.perf_counter() - t0) * 1000.0
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(min(2.0 * (2 ** attempt) + random.random(), 20))
                continue
            return HttpResult(e.code, False, raw, lat, url, error=f"HTTP {e.code}")
        except urllib.error.URLError as e:
            lat = (time.perf_counter() - t0) * 1000.0
            last = f"{type(e.reason).__name__}: {e.reason}"
            if attempt < retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            return HttpResult(0, False, "", lat, url, error=last)
        except Exception as e:  # timeout, etc.
            lat = (time.perf_counter() - t0) * 1000.0
            msg = f"{type(e).__name__}: {e}"
            if "timed out" in msg.lower() or "timeout" in msg.lower():
                return HttpResult(0, False, "", lat, url, error="timeout")
            if attempt < retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            return HttpResult(0, False, "", lat, url, error=msg)
    return HttpResult(0, False, "", 0.0, url, error=last or "unknown error")


# ---------------------------------------------------------------- providers

BUILTIN_PROVIDERS = {
    # ---------- OpenAI-compatible ----------
    "openai":        {"base_url": "https://api.openai.com/v1",           "api_key_env": "OPENAI_API_KEY"},
    "deepseek":      {"base_url": "https://api.deepseek.com",            "api_key_env": "DEEPSEEK_API_KEY"},
    "groq":          {"base_url": "https://api.groq.com/openai/v1",     "api_key_env": "GROQ_API_KEY"},
    "openrouter":    {"base_url": "https://openrouter.ai/api/v1",        "api_key_env": "OPENROUTER_API_KEY"},
    "together":      {"base_url": "https://api.together.xyz/v1",         "api_key_env": "TOGETHER_API_KEY"},
    "mistral":       {"base_url": "https://api.mistral.ai/v1",           "api_key_env": "MISTRAL_API_KEY"},
    "xai":           {"base_url": "https://api.x.ai/v1",                 "api_key_env": "XAI_API_KEY"},
    "cerebras":      {"base_url": "https://api.cerebras.ai/v1",          "api_key_env": "CEREBRAS_API_KEY"},
    "fireworks":     {"base_url": "https://api.fireworks.ai/inference/v1", "api_key_env": "FIREWORKS_API_KEY"},
    "siliconflow":   {"base_url": "https://api.siliconflow.cn/v1",       "api_key_env": "SILICONFLOW_API_KEY"},
    "moonshot":      {"base_url": "https://api.moonshot.cn/v1",          "api_key_env": "MOONSHOT_API_KEY"},
    "zhipu":         {"base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key_env": "ZHIPU_API_KEY"},
    "zai":           {"base_url": "https://api.z.ai/api/paas/v4",        "api_key_env": "ZAI_API_KEY"},
    "dashscope":     {"base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key_env": "DASHSCOPE_API_KEY"},
    "volcengine":    {"base_url": "https://ark.cn-beijing.volces.com/api/v3", "api_key_env": "ARK_API_KEY"},
    "hunyuan":       {"base_url": "https://api.hunyuan.cloud.tencent.com/v1", "api_key_env": "HUNYUAN_API_KEY"},
    "qianfan":       {"base_url": "https://qianfan.baidubce.com/v2",     "api_key_env": "QIANFAN_API_KEY"},
    "minimax":       {"base_url": "https://api.minimax.chat/v1",         "api_key_env": "MINIMAX_API_KEY"},
    "upstage":       {"base_url": "https://api.upstage.ai/v1",           "api_key_env": "UPSTAGE_API_KEY"},
    "sambanova":     {"base_url": "https://api.sambanova.ai/v1",         "api_key_env": "SAMBANOVA_API_KEY"},
    "deepinfra":     {"base_url": "https://api.deepinfra.com/v1/openai", "api_key_env": "DEEPINFRA_API_KEY"},
    "hyperbolic":    {"base_url": "https://api.hyperbolic.xyz/v1",       "api_key_env": "HYPERBOLIC_API_KEY"},
    "nvidia":        {"base_url": "https://integrate.api.nvidia.com/v1", "api_key_env": "NVIDIA_API_KEY"},
    "novita":        {"base_url": "https://api.novita.ai/v3/openai",     "api_key_env": "NOVITA_API_KEY"},
    "github":        {"base_url": "https://models.inference.ai.azure.com", "api_key_env": "GITHUB_TOKEN"},
    "nebius":        {"base_url": "https://api.studio.nebius.ai/v1",     "api_key_env": "NEBIUS_API_KEY"},
    "openai-compat": {"base_url": "",                                  "api_key_env": ""},

    # ---------- Anthropic-style ----------
    "anthropic":     {"base_url": "https://api.anthropic.com", "style": "anthropic", "api_key_env": "ANTHROPIC_API_KEY"},

    # ---------- Gemini-style ----------
    "gemini":        {"base_url": "https://generativelanguage.googleapis.com", "style": "gemini", "api_key_env": "GEMINI_API_KEY"},

    # ---------- local ----------
    "ollama":        {"base_url": "http://localhost:11434/v1",  "api_key_env": "OLLAMA_API_KEY"},
    "lmstudio":      {"base_url": "http://localhost:1234/v1",   "api_key_env": "LMSTUDIO_API_KEY"},
    "llamacpp":      {"base_url": "http://localhost:8080/v1",   "api_key_env": "LLAMACPP_API_KEY"},
    "vllm":          {"base_url": "http://localhost:8000/v1",   "api_key_env": "VLLM_API_KEY"},
    "localai":       {"base_url": "http://localhost:8080/v1",   "api_key_env": "LOCALAI_API_KEY"},
    "newapi":        {"base_url": "http://localhost:3000/v1",   "api_key_env": "NEWAPI_API_KEY"},
    "oneapi":        {"base_url": "http://localhost:3000/v1",   "api_key_env": "ONEAPI_API_KEY"},
}


def build_providers(local_file: Path = PROVIDERS_FILE):
    """Merge builtin providers with the user local config file"""
    providers: dict[str, Provider] = {}
    for name, cfg in BUILTIN_PROVIDERS.items():
        providers[name] = Provider(
            name=name,
            base_url=cfg.get("base_url", ""),
            style=cfg.get("style", "openai"),
            api_key_env=cfg.get("api_key_env", ""),
            docs=cfg.get("docs", ""),
            default_models=list(cfg.get("default_models", [])),
        )

    local = load_json(local_file, {}) or {}
    if "providers" in local and isinstance(local["providers"], dict):
        local = local["providers"]
    for name, cfg in (local or {}).items():
        if not isinstance(cfg, dict):
            continue
        base = providers.get(name)
        if base:
            base.base_url = cfg.get("base_url", base.base_url) or base.base_url
            base.style = cfg.get("style", base.style)
            base.api_key_env = cfg.get("api_key_env", base.api_key_env)
            base.docs = cfg.get("docs", base.docs)
            base.default_models = list(cfg.get("default_models", base.default_models))
            base.extra_headers.update(cfg.get("extra_headers", {}) or {})
            base.source = "local"
        else:
            providers[name] = Provider(
                name=name,
                base_url=cfg.get("base_url", ""),
                style=cfg.get("style", "openai"),
                api_key_env=cfg.get("api_key_env", ""),
                api_key=cfg.get("api_key", ""),
                docs=cfg.get("docs", ""),
                extra_headers=dict(cfg.get("extra_headers", {}) or {}),
                default_models=list(cfg.get("default_models", [])),
                source="local",
            )
    return providers


def resolve_key(provider: Provider, keys: dict, cli_key: str = "") -> str:
    if cli_key:
        return cli_key.strip()
    if provider.api_key:
        return provider.api_key.strip()
    if keys.get(provider.name):
        return str(keys[provider.name]).strip()
    if provider.api_key_env and os.environ.get(provider.api_key_env):
        return os.environ[provider.api_key_env].strip()
    # fallback: generic env var named after the provider
    generic = os.environ.get(f"{provider.name.upper()}_API_KEY")
    if generic:
        return generic.strip()
    return ""


# ---------------------------------------------------------------- endpoints

def _join(base: str, suffix: str) -> str:
    return base.rstrip("/") + suffix


def list_url_candidates(p: Provider) -> list[str]:
    b = p.base_url.rstrip("/")
    if p.style == "anthropic":
        if re.search(r"/v\d+$", b):
            return [_join(b, "/models")]
        return [_join(b, "/v1/models"), _join(b, "/models")]
    if p.style == "gemini":
        cands = []
        if re.search(r"/v\d+(beta\d*)?$", b):
            cands.append(_join(b, "/models"))
        else:
            cands += [_join(b, "/v1beta/models"), _join(b, "/v1/models")]
        return cands
    # openai-style
    cands = [_join(b, "/models")]
    if not re.search(r"/v\d+$", b):
        cands.append(_join(b, "/v1/models"))
        cands.append(_join(b, "/openai/v1/models"))
        cands.append(_join(b, "/api/v1/models"))
    return cands


def chat_url_candidates(p: Provider) -> list[str]:
    b = p.base_url.rstrip("/")
    if p.style == "anthropic":
        if re.search(r"/v\d+$", b):
            return [_join(b, "/messages")]
        return [_join(b, "/v1/messages"), _join(b, "/messages")]
    if p.style == "gemini":
        return []  # built per model
    cands = [_join(b, "/chat/completions")]
    if not re.search(r"/v\d+$", b):
        cands.append(_join(b, "/v1/chat/completions"))
        cands.append(_join(b, "/openai/v1/chat/completions"))
        cands.append(_join(b, "/api/v1/chat/completions"))
    return cands


# ---------------------------------------------------------------- headers

def auth_headers(p: Provider, key: str) -> dict:
    h = dict(p.extra_headers)
    if not key:
        return h
    if p.style == "anthropic":
        h.setdefault("x-api-key", key)
        h.setdefault("anthropic-version", "2023-06-01")
    elif p.style == "gemini":
        pass  # key goes in the query string
    else:
        h.setdefault("Authorization", f"Bearer {key}")
    return h


# ---------------------------------------------------------------- model discovery

FREE_NAME_RE = re.compile(r"(?i)(:free$|(^|[-_/.])free([-_/.]|$))")


def detect_free(model_id: str) -> bool | None:
    """True / False / None (unknown) - name based detection."""
    if FREE_NAME_RE.search(model_id):
        return True
    return None


def parse_models(p: Provider, payload: dict) -> list[tuple[str, str]]:
    """Returns a list of (model_id, request_model) tuples"""
    out: list[tuple[str, str]] = []
    if p.style == "gemini":
        items = payload.get("models") or payload.get("data") or []
        for it in items:
            if not isinstance(it, dict):
                continue
            full = it.get("name") or it.get("id") or ""
            if not full:
                continue
            methods = it.get("supportedGenerationMethods") or []
            if methods and "generateContent" not in methods:
                continue
            out.append((full.replace("models/", ""), full))
        return out

    items = payload.get("data")
    if not isinstance(items, list):
        items = payload.get("models") if isinstance(payload.get("models"), list) else []
    for it in items:
        if isinstance(it, str):
            out.append((it, it))
        elif isinstance(it, dict):
            mid = it.get("id") or it.get("name") or it.get("model")
            if mid:
                out.append((str(mid), str(mid)))
    return out


def discover_models(p: Provider, key: str, timeout: int, direct: bool):
    """Discover the model list. Returns (models, endpoint, error)"""
    headers = auth_headers(p, key)
    last_err = ""
    for url in list_url_candidates(p):
        if p.style == "gemini":
            if key:
                url = f"{url}?key={urllib.parse.quote(key)}"
        res = http_json(url, "GET", headers=headers, timeout=timeout, retries=1, direct=direct)
        if res.ok:
            try:
                payload = json.loads(res.body)
            except Exception:
                last_err = "response was not JSON"
                continue
            models = parse_models(p, payload)
            if models:
                return models, url, ""
            # some gateways return an empty list but a valid structure
            if isinstance(payload, dict) and ("data" in payload or "models" in payload):
                return [], url, ""
        else:
            last_err = extract_error(res)
    return [], "", last_err


def extract_error(res: HttpResult) -> str:
    if res.error:
        return res.error
    body = (res.body or "").strip()
    if not body:
        return f"HTTP {res.status}"
    try:
        data = json.loads(body)
    except Exception:
        return body[:220].replace("\n", " ")
    err = data.get("error")
    if isinstance(err, dict):
        msg = err.get("message") or err.get("type") or err.get("code")
        if msg:
            return str(msg)[:220]
    if isinstance(err, str):
        return err[:220]
    for k in ("message", "msg", "detail", "error_message"):
        if isinstance(data.get(k), str):
            return data[k][:220]
    return body[:220].replace("\n", " ")


# ---------------------------------------------------------------- model testing

def classify(status: int, body: str, err: str) -> str:
    if status == 200:
        return "ok"
    if status in (401, 403):
        return "auth"
    if status == 429:
        low = (body or "").lower()
        if "rate limit" in low or "too many requests" in low or "rpm" in low or "tpm" in low:
            return "ratelimit"
        return "quota"
    if status == 404:
        return "not_found"
    if status == 400:
        return "bad_request"
    if status == 408:
        return "timeout"
    if status >= 500:
        return "server"
    if status == 0:
        return "timeout" if "timeout" in (err or "").lower() else "network"
    return "error"


def body_variants(p: Provider, model: str, prompt: str, max_tokens: int, stream: bool):
    """Fallback request bodies for models that reject specific parameters"""
    if p.style == "anthropic":
        return [{
            "model": model, "max_tokens": max_tokens, "temperature": 0,
            "messages": [{"role": "user", "content": prompt}],
        }]
    if p.style == "gemini":
        return [{
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"maxOutputTokens": max_tokens, "temperature": 0},
        }]
    base = {"model": model, "messages": [{"role": "user", "content": prompt}]}
    v1 = dict(base)
    v1["max_tokens"] = max_tokens
    v1["temperature"] = 0
    if stream:
        v1["stream"] = True
    v2 = dict(base)
    v2["max_tokens"] = max_tokens
    v3 = dict(base)
    v3["max_completion_tokens"] = max_tokens
    v4 = dict(base)
    return [v1, v2, v3, v4]


def extract_text(p: Provider, payload: dict) -> str:
    try:
        if p.style == "anthropic":
            parts = payload.get("content") or []
            txt = "".join(c.get("text", "") for c in parts if isinstance(c, dict))
            return txt.strip()
        if p.style == "gemini":
            cands = payload.get("candidates") or []
            if not cands:
                return ""
            parts = cands[0].get("content", {}).get("parts", [])
            return "".join(x.get("text", "") for x in parts if isinstance(x, dict)).strip()
        choices = payload.get("choices") or []
        if not choices:
            return ""
        msg = choices[0].get("message") or {}
        content = msg.get("content")
        if content is None:
            content = choices[0].get("text") or ""
        if isinstance(content, list):
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        return str(content).strip()
    except Exception:
        return ""


def looks_like_param_error(body: str) -> bool:
    low = (body or "").lower()
    keys = ("temperature", "max_tokens", "max_completion_tokens", "unsupported",
            "not supported", "invalid_request_error", "unrecognized", "unexpected",
            "too many tokens", "max_tokens is too large", "reasoning")
    return any(k in low for k in keys)


def test_model(p: Provider, model_id: str, request_model: str, key: str, args) -> ModelResult:
    headers = auth_headers(p, key)
    variants = body_variants(p, request_model, args.prompt, args.max_tokens, args.stream)

    if p.style == "gemini":
        cands = []
        b = p.base_url.rstrip("/")
        prefixes = []
        if re.search(r"/v\d+(beta\d*)?$", b):
            prefixes.append(b)
        else:
            prefixes += [_join(b, "/v1beta"), _join(b, "/v1")]
        for pref in prefixes:
            url = f"{pref}/models/{urllib.parse.quote(request_model)}:generateContent"
            if key:
                url += f"?key={urllib.parse.quote(key)}"
            cands.append(url)
    else:
        cands = chat_url_candidates(p)

    last = HttpResult(0, False, "", 0.0, "", error="no endpoint")
    for url in cands:
        for vi, body in enumerate(variants):
            res = http_json(url, "POST", headers=headers, body=body,
                            timeout=args.timeout, retries=args.retries, direct=args.direct)
            last = res
            if res.ok:
                try:
                    payload = json.loads(res.body)
                except Exception:
                    payload = {}
                text = extract_text(p, payload)
                if p.style == "openai" and not text:
                    err_obj = payload.get("error")
                    if isinstance(err_obj, dict) and err_obj.get("message"):
                        detail = str(err_obj["message"])[:200]
                        status = classify(res.status, res.body, res.error)
                        return ModelResult(p.name, model_id, request_model, status,
                                           res.status, res.latency_ms, detail, "", "", url)
                return ModelResult(p.name, model_id, request_model, "ok", res.status,
                                   res.latency_ms, "ok", text[:300], "", url)
            # parameter error -> try the next body variant
            if res.status == 400 and vi < len(variants) - 1 and looks_like_param_error(res.body):
                continue
            if res.status == 400 and vi < len(variants) - 1 and vi == 0:
                continue
            break  # do not try another url/body unless it was a param error
        else:
            continue
        # reaching here means this endpoint did not work
        if last.status not in (404, 405):
            break

    status = classify(last.status, last.body, last.error)
    detail = redact(extract_error(last), key)
    return ModelResult(p.name, model_id, request_model, status, last.status,
                       last.latency_ms, detail, "", "", last.url)


# ---------------------------------------------------------------- benchmarks

BENCH_FILE = HERE.parent / "src" / "benchmarks.json"

SIZE_TIERS = [
    (re.compile(r"\b(400|405)b\b"), 30),
    (re.compile(r"\b(70|72|80)b\b"), 22),
    (re.compile(r"\b(32|34|36)b\b"), 14),
    (re.compile(r"\b(20|14|16)b\b"), 8),
    (re.compile(r"\b(7|8|9)b\b"), 3),
    (re.compile(r"\b(1|2|3|4)b\b"), -4),
]

QUALITY_TIERS = [
    (re.compile(r"\b(opus|ultra|flagship)\b"), 16),
    (re.compile(r"\b(pro|max|xl)\b"), 12),
    (re.compile(r"\b(plus|advanced|premium)\b"), 8),
    (re.compile(r"\b(thinking|reasoner|reasoning|r1)\b"), 8),
    (re.compile(r"\b(instruct|chat)\b"), 2),
    (re.compile(r"\b(preview|beta|experimental|exp|nightly)\b"), -6),
    (re.compile(r"\b(mini|nano|tiny|small|lite|light)\b"), -8),
    (re.compile(r"\b(large|xl)\b"), 6),
]


def load_benchmarks() -> list[dict]:
    try:
        return json.loads(BENCH_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def normalize_model_id(model_id: str) -> str:
    name = model_id.lower().replace("models/", "")
    name = name.split("/")[-1]
    name = re.sub(r":free$", "", name)
    return name.strip()


def lookup_benchmark(model_id: str) -> tuple[float | None, str]:
    """(score, source) - source is dataset | estimate | none"""
    mid = normalize_model_id(model_id)
    for entry in load_benchmarks():
        try:
            if re.search(entry["pattern"], mid, re.I):
                return float(entry["score"]), "dataset"
        except re.error:
            continue

    score = 1180.0
    for rx, delta in SIZE_TIERS:
        if rx.search(mid):
            score += delta
    for rx, delta in QUALITY_TIERS:
        if rx.search(mid):
            score += delta
    return max(900.0, min(1500.0, score)), "estimate"


def bench_text(bench: tuple[float | None, str] | None) -> str:
    if not bench or bench[0] is None:
        return C.dim("?")
    if bench[1] == "estimate":
        return C.yellow(f"~{int(round(bench[0]))}")
    return C.cyan(str(int(round(bench[0]))))


def sort_results(results: list[ModelResult], mode: str = "bench") -> list[ModelResult]:
    def score(r: ModelResult) -> float:
        return r.bench[0] if r and r.bench and r.bench[0] is not None else float("-inf")

    out = list(results)
    if mode == "speed":
        out.sort(key=lambda r: (r.latency_ms, -score(r)))
    elif mode == "name":
        out.sort(key=lambda r: r.model.lower())
    elif mode == "free":
        out.sort(key=lambda r: (0 if r.free is True else 1, -score(r), r.latency_ms))
    else:
        out.sort(key=lambda r: (-score(r), r.latency_ms))
    return out


# ---------------------------------------------------------------- output

def status_text(status: str) -> str:
    label, color = STATUS_META.get(status, ("ERROR", "31"))
    return C.wrap(color, label)


def verdict_text(status: str) -> str:
    v, color = VERDICT.get(status, ("UNKNOWN", "magenta"))
    return C.wrap(color, v)


def pad_visible(text: str, width: int) -> str:
    """Pad based on visible length (ANSI codes do not count)."""
    visible = len(re.sub(r"\033\[[0-9;]*m", "", text))
    return text + " " * max(0, width - visible)


def print_table(results: list[ModelResult], show_response: bool = False) -> None:
    if not results:
        return
    w_model = max(12, min(46, max(len(r.model) for r in results)))
    rows = []
    for i, r in enumerate(results, 1):
        detail = (r.detail or "").replace("\n", " ")
        if len(detail) > 38:
            detail = detail[:37] + "…"
        rows.append((str(i), r.model, bench_text(r.bench), status_text(r.status),
                     verdict_text(r.status), f"{r.latency_ms:.0f}ms", detail, r))
    hdr = (f"{'#':>3}  {'MODEL':<{w_model}}  {'BENCH':<6}  {'STATUS':<12}  "
           f"{'VERDICT':<13}  {'TIME':>7}  DETAIL")
    print(C.bold(hdr))
    print(C.dim("-" * (len(hdr) + 4)))
    for num, model, bench, st, vd, tm, detail, r in rows:
        print(f"{num:>3}  {model:<{w_model}}  {pad_visible(bench, 6)}  "
              f"{pad_visible(st, 12)}  {pad_visible(vd, 13)}  {tm:>7}  {C.dim(detail)}")
        if show_response and r.response:
            print(f"     {C.green('> ' + r.response)}")


def summarize(results: list[ModelResult]) -> dict:
    counts: dict[str, int] = {}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    usable = [r for r in results if r.status == "ok"]
    throttled = [r for r in results if r.status == "ratelimit"]
    return {
        "total": len(results),
        "usable": len(usable),
        "throttled_but_usable": len(throttled),
        "counts": counts,
    }


def print_summary(results: list[ModelResult]) -> dict:
    s = summarize(results)
    print()
    print(C.bold("- Summary -"))
    for st, cnt in sorted(s["counts"].items(), key=lambda kv: -kv[1]):
        print(f"  {pad_visible(status_text(st), 20)} {cnt}")
    print()
    line = (f"  Usable: {C.green(str(s['usable']))}"
            f"   |  Throttled: {C.yellow(str(s['throttled_but_usable']))}"
            f"   |  Total: {C.bold(str(s['total']))}")
    print(line)
    usable_models = [r for r in results if r.status in ("ok", "ratelimit")]
    if usable_models:
        print(C.bold("\n  Usable models:"))
        for r in usable_models:
            bench = bench_text(r.bench)
            print(f"    {C.green('+')} {r.model}  {C.dim(bench)}  {C.dim(f'{r.latency_ms:.0f}ms')}")
    return s


def write_reports(p: Provider, results: list[ModelResult], args, summary: dict) -> list[str]:
    written = []
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = ts_slug()
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", p.name)
    payload = {
        "tool": f"modeltest/{APP_VERSION}",
        "generated_at": now_iso(),
        "provider": {"name": p.name, "base_url": p.base_url, "style": p.style},
        "sort": getattr(args, "sort", "bench"),
        "summary": summary,
        "results": [
            {
                "model": r.model,
                "status": r.status,
                "verdict": VERDICT.get(r.status, ["UNKNOWN"])[0],
                "free": r.free,
                "bench": {"score": r.bench[0], "source": r.bench[1]} if r.bench else None,
                "http_status": r.http_status,
                "latency_ms": round(r.latency_ms, 1),
                "detail": r.detail,
                "response": r.response,
                "endpoint": r.endpoint,
            }
            for r in results
        ],
    }
    jf = REPORT_DIR / f"{safe}-{stamp}.json"
    save_json(jf, payload)
    written.append(str(jf))
    return written


# ---------------------------------------------------------------- filters

def filter_models(models: list[tuple[str, str]], args) -> list[tuple[str, str]]:
    out = models
    if args.grep:
        try:
            rx = re.compile(args.grep, re.I)
        except re.error as e:
            print(C.red(f"  [invalid grep: {e}]"))
            rx = None
        if rx:
            out = [m for m in out if rx.search(m[0])]
    if args.skip:
        try:
            rx2 = re.compile(args.skip, re.I)
        except re.error as e:
            print(C.red(f"  [invalid skip: {e}]"))
            rx2 = None
        if rx2:
            out = [m for m in out if not rx2.search(m[0])]
    if not args.include_non_chat:
        out = [m for m in out if not NON_CHAT_RE.search(m[0])]
    if args.limit and args.limit > 0:
        out = out[:args.limit]
    return out


# ---------------------------------------------------------------- main

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="modeltest.py",
        description="Probe API models with base_url and api_key (OpenAI / Anthropic / Gemini / local)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python modeltest.py --base-url https://api.deepseek.com --api-key sk-xxx
  python modeltest.py --provider openai,openrouter --limit 40
  python modeltest.py --provider all
  python modeltest.py --base-url http://localhost:11434/v1 --api-key ollama --provider local
  python modeltest.py --base-url https://x/v1 --api-key k --model gpt-4o --model gpt-4o-mini
  python modeltest.py --providers
  python modeltest.py --set-key openai sk-xxxx
""")
    p.add_argument("--base-url", "-b", help="API base URL (e.g. https://api.deepseek.com/v1)")
    p.add_argument("--api-key", "-k", help="API key (falls back to env vars or keys.local.json)")
    p.add_argument("--provider", "-p", help="Provider name (comma separated, 'all' for every one)")
    p.add_argument("--providers", action="store_true", help="List known providers")
    p.add_argument("--style", choices=["openai", "anthropic", "gemini"],
                   help="API style (default: openai; also anthropic/gemini)")
    p.add_argument("--model", action="append", default=[],
                   help="Test only these models (repeatable) - no model list needed")
    p.add_argument("--list-only", action="store_true", help="Only list models, do not test")
    p.add_argument("--probe", action="store_true", help="Only check endpoint reachability")
    p.add_argument("--grep", help="Only models matching this regex")
    p.add_argument("--skip", help="Drop models matching this regex")
    p.add_argument("--limit", type=int, default=0, help="Max number of models to test")
    p.add_argument("--include-non-chat", action="store_true",
                   help="Also test non-chat models (embedding/image/...)")
    p.add_argument("--prompt", default=DEFAULT_PROMPT, help="Test prompt")
    p.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    p.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    p.add_argument("--workers", "-w", type=int, default=DEFAULT_WORKERS, help="Parallel requests")
    p.add_argument("--stream", action="store_true", help="Test with stream=true")
    p.add_argument("--direct", action="store_true", help="Bypass the system proxy")
    p.add_argument("--no-color", action="store_true")
    p.add_argument("--quiet", "-q", action="store_true", help="Summary only")
    p.add_argument("--show-response", action="store_true", help="Print model responses")
    p.add_argument("--json", dest="json_out", help="Write JSON output to this path")
    p.add_argument("--sort", choices=["bench", "speed", "name", "free"], default="bench",
                   help="Sort order: bench (default) | speed | name | free")
    p.add_argument("--rank-file", help="Custom benchmark scores as JSON: {\"model-id\": 1350}")
    p.add_argument("--no-report", action="store_true", help="Do not write reports")
    p.add_argument("--set-key", nargs=2, metavar=("PROVIDER", "KEY"),
                   help="Store a key in keys.local.json")
    p.add_argument("--config", default=str(PROVIDERS_FILE), help="Path to a custom providers file")
    return p


def cmd_list_providers(providers: dict) -> None:
    print(C.bold("\nKnown providers:\n"))
    print(f"  {'NAME':<14} {'STYLE':<10} {'BASE URL':<46} ENV")
    print(C.dim("  " + "-" * 92))
    for name, p in sorted(providers.items()):
        if not p.base_url:
            continue
        env = p.api_key_env or "-"
        has = "✔" if os.environ.get(p.api_key_env or "\0") else " "
        print(f"  {name:<14} {p.style:<10} {p.base_url:<46} {env} {has}")
    print(C.dim("\n  yes = an API key for that provider is present in the environment\n"))


def cmd_set_key(name: str, key: str) -> None:
    keys = load_json(KEYS_FILE, {}) or {}
    keys[name] = key
    save_json(KEYS_FILE, keys)
    print(f"  Stored key for \"{name}\" ({KEYS_FILE})")


def run_one_provider(p: Provider, key: str, args) -> list[ModelResult]:
    print(C.bold(f"\n--- {p.name}  ({p.base_url}) ---"))
    if not key:
        print(C.yellow("  ! No API key found - testing without authentication (fine for local servers)"))

    # 1) discover models
    models: list[tuple[str, str]] = []
    list_endpoint = ""
    if args.model:
        models = [(m, m) for m in args.model]
        print(f"  Manual model list: {len(models)}")
    else:
        models, list_endpoint, err = discover_models(p, key, args.timeout, args.direct)
        if list_endpoint:
            print(f"  Discovered {len(models)} models  ({redact(list_endpoint, key)})")
        else:
            print(C.yellow(f"  ! Could not fetch model list: {redact(err, key)}"))
            if p.default_models:
                models = [(m, m) for m in p.default_models]
                print(C.dim(f"  Using the default model list ({len(models)} models)"))

    if args.list_only:
        for mid, mref in models:
            score, source = lookup_benchmark(mid)
            tag = ""
            print(f"    {bench_text((score, source)):>8}  {mid}{tag}")
        if args.json_out:
            save_json(args.json_out, {"provider": p.name, "models": [m[0] for m in models]})
        return []

    models = filter_models(models, args)
    if not models:
        print(C.yellow("  Nothing left to test."))
        return []

    if not args.quiet:
        print(f"  Testing {len(models)} models with {args.workers} parallel workers ...\n")

    # 2) run the tests in parallel
    results: list[ModelResult] = []
    with cf.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(test_model, p, mid, mref, key, args): mid for mid, mref in models}
        for fut in cf.as_completed(futs):
            try:
                results.append(fut.result())
            except Exception as e:
                mid = futs[fut]
                results.append(ModelResult(p.name, mid, mid, "error", 0, 0.0,
                                           f"{type(e).__name__}: {e}"))

    for r in results:
        r.bench = lookup_benchmark(r.model)
        if r.free is None:
            r.free = detect_free(r.model)

    results = sort_results(results, getattr(args, "sort", "bench"))

    if not args.quiet:
        print_table(results, show_response=args.show_response)
    summary = print_summary(results)

    # 3) write the report
    if not args.no_report:
        files = write_reports(p, results, args, summary)
        if not args.quiet:
            print(C.dim(f"\n  Report: {', '.join(files)}"))
    if args.json_out:
        save_json(args.json_out, {
            "provider": p.name, "base_url": p.base_url,
            "sort": getattr(args, "sort", "bench"),
            "summary": summary,
            "results": [{"model": r.model, "status": r.status,
                         "verdict": VERDICT.get(r.status, ["UNKNOWN"])[0],
                         "free": r.free,
                         "bench": {"score": r.bench[0], "source": r.bench[1]} if r.bench else None,
                         "http_status": r.http_status,
                         "latency_ms": round(r.latency_ms, 1),
                         "detail": r.detail, "response": r.response}
                        for r in results],
        })
    return results


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    if args.no_color or not sys.stdout.isatty():
        C.enabled = False

    load_dotenv()
    providers = build_providers(Path(args.config))
    keys = load_json(KEYS_FILE, {}) or {}

    if args.set_key:
        cmd_set_key(args.set_key[0], args.set_key[1])
        return 0

    if args.providers:
        cmd_list_providers(providers)
        return 0

    if not args.base_url and not args.provider:
        build_parser().print_help()
        return 2

    # pick the providers
    targets: list[Provider] = []
    if args.base_url:
        style = args.style or "openai"
        p = Provider(name="custom", base_url=args.base_url.rstrip("/"), style=style,
                     api_key=args.api_key, source="cli")
        targets.append(p)
    else:
        names = [n.strip() for n in args.provider.split(",") if n.strip()]
        if names == ["all"]:
            names = [n for n, pr in providers.items() if pr.base_url]
        for n in names:
            if n not in providers:
                print(C.red(f"  Unknown provider: {n}  (use --providers to list them)"))
                continue
            targets.append(providers[n])

    all_results: list[ModelResult] = []
    for p in targets:
        key = resolve_key(p, keys, args.api_key if p.name == "custom" else "")
        res = run_one_provider(p, key, args)
        all_results.extend(res)

    if len(targets) > 1 and all_results:
        print(C.bold("\n\n=== All providers ==="))
        print_table(all_results, show_response=False)
        print_summary(all_results)

    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
