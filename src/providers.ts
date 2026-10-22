import type { ApiStyle, Provider } from './types.js';

interface Builtin {
  baseUrl: string;
  style?: ApiStyle;
  apiKeyEnv?: string;
  docs?: string;
}

/**
 * پرووایدرهای از پیش تعریف‌شده.
 * هر کدام base_url و نام متغیر محیطی کلید را دارند.
 */
export const BUILTIN_PROVIDERS: Record<string, Builtin> = {
  // ---------- OpenAI-compatible ----------
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  together: { baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY' },
  xai: { baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY' },
  fireworks: { baseUrl: 'https://api.fireworks.ai/inference/v1', apiKeyEnv: 'FIREWORKS_API_KEY' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', apiKeyEnv: 'SILICONFLOW_API_KEY' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY' },
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', apiKeyEnv: 'ZAI_API_KEY' },
  dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  volcengine: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKeyEnv: 'ARK_API_KEY' },
  hunyuan: { baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', apiKeyEnv: 'HUNYUAN_API_KEY' },
  qianfan: { baseUrl: 'https://qianfan.baidubce.com/v2', apiKeyEnv: 'QIANFAN_API_KEY' },
  minimax: { baseUrl: 'https://api.minimax.chat/v1', apiKeyEnv: 'MINIMAX_API_KEY' },
  upstage: { baseUrl: 'https://api.upstage.ai/v1', apiKeyEnv: 'UPSTAGE_API_KEY' },
  sambanova: { baseUrl: 'https://api.sambanova.ai/v1', apiKeyEnv: 'SAMBANOVA_API_KEY' },
  deepinfra: { baseUrl: 'https://api.deepinfra.com/v1/openai', apiKeyEnv: 'DEEPINFRA_API_KEY' },
  hyperbolic: { baseUrl: 'https://api.hyperbolic.xyz/v1', apiKeyEnv: 'HYPERBOLIC_API_KEY' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY' },
  novita: { baseUrl: 'https://api.novita.ai/v3/openai', apiKeyEnv: 'NOVITA_API_KEY' },
  nebius: { baseUrl: 'https://api.studio.nebius.ai/v1', apiKeyEnv: 'NEBIUS_API_KEY' },
  github: { baseUrl: 'https://models.inference.ai.azure.com', apiKeyEnv: 'GITHUB_TOKEN' },

  // ---------- Anthropic-style ----------
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    style: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },

  // ---------- Gemini-style ----------
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    style: 'gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
  },

  // ---------- Local / self-hosted ----------
  ollama: { baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'OLLAMA_API_KEY' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', apiKeyEnv: 'LMSTUDIO_API_KEY' },
  llamacpp: { baseUrl: 'http://localhost:8080/v1', apiKeyEnv: 'LLAMACPP_API_KEY' },
  vllm: { baseUrl: 'http://localhost:8000/v1', apiKeyEnv: 'VLLM_API_KEY' },
  localai: { baseUrl: 'http://localhost:8080/v1', apiKeyEnv: 'LOCALAI_API_KEY' },
  newapi: { baseUrl: 'http://localhost:3000/v1', apiKeyEnv: 'NEWAPI_API_KEY' },
  oneapi: { baseUrl: 'http://localhost:3000/v1', apiKeyEnv: 'ONEAPI_API_KEY' },
  openwebui: { baseUrl: 'http://localhost:3000/v1', apiKeyEnv: 'OPENWEBUI_API_KEY' },
};

export function getBuiltinProvider(name: string): Provider | undefined {
  const key = name.toLowerCase().trim();
  const found = BUILTIN_PROVIDERS[key];
  if (!found) return undefined;
  return {
    name: key,
    baseUrl: found.baseUrl,
    style: found.style ?? 'openai',
    apiKeyEnv: found.apiKeyEnv,
    docs: found.docs,
  };
}

export function listBuiltinProviders(): Provider[] {
  return Object.entries(BUILTIN_PROVIDERS).map(([name, cfg]) => ({
    name,
    baseUrl: cfg.baseUrl,
    style: cfg.style ?? 'openai',
    apiKeyEnv: cfg.apiKeyEnv,
    docs: cfg.docs,
  }));
}
