import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  detectFree,
  discoverModels,
  filterModels,
  parsePricing,
  probeProvider,
  testModel,
} from '../dist/index.js';
import { startMockServer } from './mock-server.js';

let mock;
const provider = () => ({ name: 'mock', baseUrl: mock.baseUrl, style: 'openai' });

before(async () => {
  mock = await startMockServer();
});

after(async () => {
  await mock.close();
});

describe('کشف مدل‌ها', () => {
  it('لیست مدل‌ها را از /models می‌گیرد', async () => {
    const { models, endpoint } = await discoverModels(provider(), mock.apiKey);
    assert.ok(endpoint, 'باید endpoint پیدا شود');
    assert.equal(models.length, 7);
    assert.ok(models.some((m) => m.id === 'gpt-4o'));
  });

  it('قیمت مدل‌ها را استخراج می‌کند', async () => {
    const { models } = await discoverModels(provider(), mock.apiKey);
    const gpt4o = models.find((m) => m.id === 'gpt-4o');
    assert.equal(gpt4o.pricing.promptPerMillion, 2.5);
    assert.equal(gpt4o.pricing.completionPerMillion, 10);
  });

  it('مدل رایگان (قیمت صفر) را تشخیص می‌دهد', async () => {
    const { models } = await discoverModels(provider(), mock.apiKey);
    const free = models.find((m) => m.id === 'some-model:free');
    assert.equal(free.free, true);
    const paid = models.find((m) => m.id === 'gpt-4o');
    assert.equal(paid.free, false);
  });

  it('کلید اشتباه را تشخیص می‌دهد', async () => {
    const { models, error } = await discoverModels(provider(), 'wrong-key');
    assert.equal(models.length, 0);
    assert.match(error, /invalid api key/i);
  });
});

describe('تست مدل‌ها', () => {
  it('مدل سالم را OK برمی‌گرداند', async () => {
    const model = { id: 'gpt-4o', requestId: 'gpt-4o', free: null };
    const result = await testModel(provider(), model, mock.apiKey);
    assert.equal(result.status, 'ok');
    assert.equal(result.response, 'OK');
    assert.ok(result.latencyMs >= 0);
  });

  it('خطای اعتبار (401) را auth تشخیص می‌دهد', async () => {
    const model = { id: 'gpt-4o', requestId: 'gpt-4o', free: null };
    const result = await testModel(provider(), model, 'wrong-key');
    assert.equal(result.status, 'auth');
  });

  it('خطای بیلانس (429) را quota تشخیص می‌دهد', async () => {
    const model = { id: 'quota-model', requestId: 'quota-model', free: null };
    const result = await testModel(provider(), model, mock.apiKey);
    assert.equal(result.status, 'quota');
  });

  it('خطای محدودیت نرخ (429) را ratelimit تشخیص می‌دهد', async () => {
    const model = { id: 'rate-model', requestId: 'rate-model', free: null };
    const result = await testModel(provider(), model, mock.apiKey);
    assert.equal(result.status, 'ratelimit');
  });

  it('درخواست نامعتبر (400) را bad_request تشخیص می‌دهد', async () => {
    const model = { id: 'bad-model', requestId: 'bad-model', free: null };
    const result = await testModel(provider(), model, mock.apiKey);
    assert.equal(result.status, 'bad_request');
  });
});

describe('فیلترها', () => {
  it('مدل‌های غیرچت را حذف می‌کند', async () => {
    const { models } = await discoverModels(provider(), mock.apiKey);
    const filtered = filterModels(models, {});
    assert.ok(!filtered.some((m) => m.id === 'text-embedding-3-small'));
    assert.ok(filtered.some((m) => m.id === 'gpt-4o'));
  });

  it('با grep و limit کار می‌کند', async () => {
    const { models } = await discoverModels(provider(), mock.apiKey);
    const filtered = filterModels(models, { grep: 'gpt', limit: 1 });
    assert.equal(filtered.length, 1);
    assert.match(filtered[0].id, /gpt/);
  });

  it('فقط مدل‌های رایگان را نگه می‌دارد', async () => {
    const { models } = await discoverModels(provider(), mock.apiKey);
    const filtered = filterModels(models, { freeOnly: true });
    assert.ok(filtered.length >= 1);
    assert.ok(filtered.every((m) => m.free === true));
  });
});

describe('تشخیص رایگان بودن', () => {
  it('نام :free را تشخیص می‌دهد', () => {
    assert.equal(detectFree('x/y:free').free, true);
  });

  it('قیمت صفر را تشخیص می‌دهد', () => {
    assert.equal(detectFree('x/y', { promptPerMillion: 0, completionPerMillion: 0 }).free, true);
  });

  it('قیمت بالا را paid تشخیص می‌دهد', () => {
    assert.equal(detectFree('x/y', { promptPerMillion: 5 }).free, false);
  });

  it('بدون اطلاعات، نامشخص برمی‌گرداند', () => {
    assert.equal(detectFree('x/y').free, null);
  });

  it('قیمت‌های Azure را تبدیل می‌کند', () => {
    const pricing = parsePricing({ input_price_per_token: 0.000001, output_price_per_token: 0.000002 });
    assert.equal(pricing.promptPerMillion, 1);
    assert.equal(pricing.completionPerMillion, 2);
  });
});

describe('پروب کامل', () => {
  it('گزارش نهایی را می‌سازد', async () => {
    const report = await probeProvider(provider(), mock.apiKey, { concurrency: 4, retries: 0 });
    // ۷ مدل در لیست هست، یکی embedding است و فیلتر می‌شود
    assert.equal(report.results.length, 6);
    assert.equal(report.summary.usable, 3);
    assert.equal(report.summary.throttled, 1);
    assert.ok(report.summary.free >= 1);
    const usableFree = report.results.filter(
      (r) => r.free === true && (r.status === 'ok' || r.status === 'ratelimit'),
    );
    assert.ok(usableFree.length >= 1);
  });
});
