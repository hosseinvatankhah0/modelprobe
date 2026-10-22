import { createServer } from 'node:http';

const API_KEY = 'test-key';

const MODELS = [
  { id: 'gpt-4o-mini', pricing: { prompt: '0.00000015', completion: '0.0000006' } },
  { id: 'gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
  { id: 'some-model:free', pricing: { prompt: '0', completion: '0' } },
  { id: 'text-embedding-3-small', pricing: { prompt: '0.00000002' } },
  { id: 'quota-model', pricing: { prompt: '0' } },
  { id: 'rate-model' },
  { id: 'bad-model' },
];

/** یک سرور شبیه‌ساز OpenAI-compatible برای تست‌ها */
export async function startMockServer(port = 0) {
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    const authorized = auth === `Bearer ${API_KEY}`;

    const send = (code, payload) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.url?.endsWith('/models')) {
      if (!authorized) {
        return send(401, { error: { message: 'invalid api key', type: 'authentication_error' } });
      }
      return send(200, {
        object: 'list',
        data: MODELS.map((m) => ({ id: m.id, object: 'model', owned_by: 'mock', ...m })),
      });
    }

    if (req.url?.endsWith('/chat/completions')) {
      if (!authorized) {
        return send(401, { error: { message: 'invalid api key', type: 'authentication_error' } });
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let model = '';
        try {
          model = JSON.parse(body).model ?? '';
        } catch {
          /* noop */
        }
        if (model === 'quota-model') {
          return send(429, {
            error: { message: 'You have insufficient balance', type: 'quota_error' },
          });
        }
        if (model === 'rate-model') {
          return send(429, { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } });
        }
        if (model === 'bad-model') {
          return send(400, {
            error: { message: 'Invalid request: unsupported temperature', type: 'invalid_request_error' },
          });
        }
        return send(200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
      });
      return;
    }

    send(404, { error: { message: 'not found' } });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    apiKey: API_KEY,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
