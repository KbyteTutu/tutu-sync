import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractHeaders, serializeHeaders, type MailHeaders } from '../services/gmail/headers.js';
import { prefilter, prefilterAnalysis } from '../services/gmail/prefilter.js';

function headers(overrides: Partial<MailHeaders> = {}): string {
  return serializeHeaders({
    listUnsubscribe: false,
    listId: false,
    precedence: null,
    autoSubmitted: null,
    feedbackId: false,
    xMailer: null,
    bulkHeaders: [],
    ...overrides,
  });
}

test('批量发信头 + ESP 标识 → 置信度 >= 80，直接过滤', () => {
  const verdict = prefilter({
    fromAddr: 'Opera.Australia@opera.org.au',
    fromName: 'Opera',
    subject: 'Tomorrow: Les Misérables Pre-sale',
    body: '...',
    headers: headers({
      listUnsubscribe: true,
      feedbackId: true,
      xMailer: 'ActiveCampaign Mailer',
      bulkHeaders: ['x-sending-engine'],
    }),
  });
  assert.equal(verdict.kind, 'spam');
  assert.ok(verdict.confidence >= 80, `confidence=${verdict.confidence}`);
  assert.equal(verdict.skipLlm, true);
  assert.match(verdict.reason, /List-Unsubscribe/);
});

test('Precedence: bulk 单独即可确认（>= 80）', () => {
  const verdict = prefilter({
    fromAddr: 'someone@example.com',
    fromName: null,
    subject: 'weekly digest',
    body: '',
    headers: headers({ precedence: 'bulk' }),
  });
  assert.equal(verdict.skipLlm, true);
  assert.equal(verdict.kind, 'spam');
});

test('普通私人邮件 → 置信度低，交给 LLM', () => {
  const verdict = prefilter({
    fromAddr: 'alice@example.com',
    fromName: 'Alice',
    subject: '周末一起吃饭？',
    body: '周六晚上有空吗，老地方见。',
    headers: headers(),
  });
  assert.equal(verdict.skipLlm, false);
  assert.equal(verdict.confidence, 0);
});

test('验证码类通知 → 归为通知并直接过滤', () => {
  const verdict = prefilter({
    fromAddr: 'no-reply@bank.example',
    fromName: null,
    subject: '你的验证码是 123456',
    body: '5 分钟内有效。',
    headers: headers(),
  });
  assert.equal(verdict.kind, 'noise');
  assert.equal(verdict.skipLlm, true);
});

test('安全提醒即使带批量头也不允许本地过滤', () => {
  const verdict = prefilter({
    fromAddr: 'no-reply@accounts.google.com',
    fromName: 'Google',
    subject: '安全提醒',
    body: '你的账号在一台新设备登录。',
    headers: headers({ feedbackId: true }),
  });
  assert.equal(verdict.skipLlm, false);
  assert.match(verdict.reason, /强制交给 LLM/);
});

test('账单/付款类邮件即使带 List-Unsubscribe 也交给 LLM', () => {
  const verdict = prefilter({
    fromAddr: 'billing@service.example',
    fromName: 'Billing',
    subject: '你的 10 月账单已生成',
    body: '本期应还金额 100 元，最后还款日 11-05。',
    headers: headers({ listUnsubscribe: true, feedbackId: true }),
  });
  assert.equal(verdict.skipLlm, false);
});

test('Auto-Submitted + 通知主题 → 通知置信度 >= 80，直接过滤', () => {
  const verdict = prefilter({
    fromAddr: 'no-reply@shop.example',
    fromName: null,
    subject: '订单已发货',
    body: '物流单号 SF123。',
    headers: headers({ autoSubmitted: 'auto-generated' }),
  });
  assert.equal(verdict.kind, 'noise');
  assert.equal(verdict.skipLlm, true);
});

test('正文不截断到 500 字：第 600 字后的退订特征仍生效', () => {
  const filler = 'x'.repeat(600);
  const verdict = prefilter({
    fromAddr: 'promo@example.com',
    fromName: null,
    subject: '本季新品',
    body: `${filler}退订请点击这里`,
    headers: headers(),
  });
  // 营销发件人 0.6 + 正文退订 0.5 → noisy-OR = 0.8
  assert.equal(verdict.skipLlm, true);
  assert.match(verdict.reason, /正文/);
});

test('extractHeaders 只提取判定需要的头', () => {
  const parsed = extractHeaders([
    { key: 'list-unsubscribe', line: 'List-Unsubscribe: <https://example.com/u>' },
    { key: 'feedback-id', line: 'Feedback-ID: 1:campaign' },
    { key: 'precedence', line: 'Precedence: bulk' },
    { key: 'x-mailer', line: 'X-Mailer: Mailchimp Mailer' },
    { key: 'x-sfmc-stack', line: 'X-SFMC-Stack: 1' },
    { key: 'subject', line: 'Subject: hi' },
  ]);
  assert.equal(parsed.listUnsubscribe, true);
  assert.equal(parsed.feedbackId, true);
  assert.equal(parsed.precedence, 'bulk');
  assert.equal(parsed.xMailer, 'Mailchimp Mailer');
  assert.deepEqual(parsed.bulkHeaders, ['x-sfmc-stack']);
});

test('prefilterAnalysis 生成可直接入库的占位分析', () => {
  const verdict = prefilter({
    fromAddr: 'newsletter@example.com',
    fromName: null,
    subject: '促销',
    body: '',
    headers: headers({ listUnsubscribe: true }),
  });
  const parsed = JSON.parse(prefilterAnalysis(verdict)) as Record<string, unknown>;
  assert.equal(parsed.category, '垃圾');
  assert.equal(parsed.priority, 'low');
  assert.equal((parsed.prefilter as Record<string, unknown>).kind, 'spam');
});
