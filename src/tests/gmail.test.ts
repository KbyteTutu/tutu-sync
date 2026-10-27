import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../lib/db.js';
import {
  countPending,
  insertEmail,
  listEmails,
  listPending,
  setAnalysis,
  stats,
  type EmailInsert,
} from '../services/gmail/store.js';

const USAGE = {
  model: 'ds/deepseek-flash',
  calls: 2,
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
};

function emptyDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function mail(uid: number): EmailInsert {
  return {
    uidvalidity: 1,
    uid,
    message_id: `<${uid}@example.com>`,
    from_addr: 'sender@example.com',
    from_name: 'Sender',
    to_addr: 'tukechao@gmail.com',
    subject: `subject ${uid}`,
    date: `2026-10-0${uid}T00:00:00Z`,
    seen: false,
    snippet: `snippet ${uid}`,
    body_text: `body ${uid}`,
    headers: '{}',
  };
}

test('insertEmail 幂等：同一 (uidvalidity, uid) 不会重复入库', () => {
  const db = emptyDb();
  insertEmail(db, mail(1));
  insertEmail(db, mail(1));
  assert.equal(stats(db).total, 1);
  db.close();
});

test('stats 汇总清单、分析状态、垃圾邮件与 LLM 用量', () => {
  const db = emptyDb();
  insertEmail(db, mail(1));
  insertEmail(db, mail(2));
  insertEmail(db, mail(3));
  setAnalysis(db, 1, 1, {
    analysis: JSON.stringify({ summary: 'ok', category: '垃圾', priority: 'low' }),
    error: null,
    usage: USAGE,
    spam: true,
  });
  setAnalysis(db, 1, 2, { analysis: null, error: 'LLM HTTP 500', usage: USAGE, spam: false });

  const result = stats(db);
  assert.equal(result.total, 3);
  assert.equal(result.analyzed, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.spam, 1);
  assert.equal(result.unread, 3);
  assert.deepEqual(result.models, ['ds/deepseek-flash']);
  assert.equal(result.usage.calls, 4);
  assert.equal(result.usage.promptTokens, 20);
  assert.equal(result.usage.completionTokens, 10);
  assert.equal(result.usage.totalTokens, 30);
  assert.deepEqual(result.categories, [{ category: '垃圾', count: 1 }]);
  db.close();
});

test('listPending 按 UID 从旧到新，retryFailed 才包含失败项', () => {
  const db = emptyDb();
  insertEmail(db, mail(1));
  insertEmail(db, mail(2));
  insertEmail(db, mail(3));
  setAnalysis(db, 1, 2, { analysis: null, error: 'boom', usage: USAGE, spam: false });

  assert.deepEqual(listPending(db, 10, false).map((row) => row.uid), [1, 3]);
  assert.deepEqual(listPending(db, 10, true).map((row) => row.uid), [1, 2, 3]);
  assert.deepEqual(listPending(db, 2, false).map((row) => row.uid), [1, 3]);
  assert.equal(countPending(db), 2);
  db.close();
});

test('listEmails 支持分析状态过滤，未分析邮件默认可见', () => {
  const db = emptyDb();
  insertEmail(db, mail(1));
  insertEmail(db, mail(2));
  insertEmail(db, mail(3));
  setAnalysis(db, 1, 1, {
    analysis: JSON.stringify({ summary: 'ok', category: '安全', priority: 'high' }),
    error: null,
    usage: USAGE,
    spam: false,
  });
  setAnalysis(db, 1, 2, { analysis: null, error: 'boom', usage: USAGE, spam: false });

  const uids = (state: 'all' | 'processed' | 'pending' | 'failed') =>
    listEmails(db, { limit: 10, state }).map((row) => row.uid);

  assert.deepEqual(uids('all'), [3, 2, 1]);
  assert.deepEqual(uids('processed'), [1]);
  assert.deepEqual(uids('pending'), [3]);
  assert.deepEqual(uids('failed'), [2]);

  assert.deepEqual(
    listEmails(db, { limit: 10, category: '安全' }).map((row) => row.uid),
    [1],
  );
  db.close();
});

// ---- digest：本地初筛 + 仅低置信度交给 LLM ----

import { serializeHeaders } from '../services/gmail/headers.js';
import type { GmailConfig } from '../services/gmail/schema.js';
import { GmailService } from '../services/gmail/service.js';
import type { AnalyzeFn } from '../services/gmail/service.js';

const CFG: GmailConfig = {
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    user: 'tukechao@gmail.com',
    password: 'x',
    mailbox: 'INBOX',
  },
  fetch: {
    interval: '30m',
    initial_days: 7,
    batch_size: 20,
    max_batches_per_run: 10,
    mark_seen: false,
  },
  llm: {
    base_url: 'http://127.0.0.1:1/v1',
    api_key: 'x',
    model: 'ds/deepseek-flash',
    temperature: 0.2,
    timeout: '5s',
    max_retries: 0,
    max_body_chars: 8000,
    prompt: 'p',
  },
};

const noopLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

test('digest 只把低置信度邮件交给 LLM，其余本地过滤', async () => {
  const db = emptyDb();
  const promoHeaders = serializeHeaders({
    listUnsubscribe: true,
    listId: false,
    precedence: 'bulk',
    autoSubmitted: null,
    feedbackId: true,
    xMailer: 'ActiveCampaign Mailer',
    bulkHeaders: [],
  });
  insertEmail(db, { ...mail(1), from_addr: 'newsletter@shop.example', subject: '限时促销', headers: promoHeaders });
  insertEmail(db, { ...mail(2), from_addr: 'alice@example.com', from_name: 'Alice', subject: '周末吃饭？', body_text: '周六老地方见。', headers: '{}' });
  insertEmail(db, {
    ...mail(3),
    from_addr: 'no-reply@shop.example',
    subject: '订单已发货',
    body_text: '物流单号 SF123',
    headers: serializeHeaders({
      listUnsubscribe: false,
      listId: false,
      precedence: null,
      autoSubmitted: 'auto-generated',
      feedbackId: false,
      xMailer: null,
      bulkHeaders: [],
    }),
  });

  const calls: number[] = [];
  const fakeAnalyze: AnalyzeFn = async (_llm, input) => {
    calls.push(1);
    assert.equal(input.subject, '周末吃饭？');
    return {
      analysis: JSON.stringify({
        summary: 'Alice 约周末吃饭',
        category: '个人',
        priority: 'medium',
        action_required: true,
        action: '回复周六是否有空',
        key_points: [],
      }),
      error: null,
      usage: { model: 'ds/deepseek-flash', calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      category: '个人',
      spam: false,
    };
  };

  const service = new GmailService(CFG, db, noopLog, fakeAnalyze);
  const summary = await service.digest({ limit: 10 });

  assert.equal(calls.length, 1, '只有私人邮件应进入 LLM');
  assert.equal(summary.processed, 3);
  assert.equal(summary.skippedSpam, 1);
  assert.equal(summary.skippedNoise, 1);
  assert.equal(summary.analyzed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.usage.totalTokens, 15);
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].uid, 2);
  assert.equal(summary.items[0].actionRequired, true);

  const result = stats(db);
  assert.equal(result.prefiltered, 2);
  assert.equal(result.llmAnalyzed, 1);
  assert.equal(result.spam, 1);
  assert.equal(result.spamByPrefilter, 1);
  assert.equal(result.spamByLlm, 0);

  const kinds = db
    .prepare('SELECT uid, prefilter_kind FROM gmail_emails ORDER BY uid')
    .all() as { uid: number; prefilter_kind: string | null }[];
  assert.deepEqual(kinds, [
    { uid: 1, prefilter_kind: 'spam' },
    { uid: 2, prefilter_kind: 'valuable' },
    { uid: 3, prefilter_kind: 'noise' },
  ]);
  db.close();
});

test('digest 全部是垃圾时返回空 items 且不调用 LLM', async () => {
  const db = emptyDb();
  const bulk = serializeHeaders({
    listUnsubscribe: true,
    listId: false,
    precedence: 'bulk',
    autoSubmitted: null,
    feedbackId: true,
    xMailer: null,
    bulkHeaders: [],
  });
  insertEmail(db, { ...mail(1), from_addr: 'marketing@brand.example', subject: '双十一大促', headers: bulk });
  insertEmail(db, { ...mail(2), from_addr: 'newsletter@brand.example', subject: '本周精选', headers: bulk });

  let called = 0;
  const fakeAnalyze: AnalyzeFn = async () => {
    called++;
    throw new Error('不应调用');
  };
  const service = new GmailService(CFG, db, noopLog, fakeAnalyze);
  const summary = await service.digest({ limit: 10 });

  assert.equal(called, 0);
  assert.equal(summary.items.length, 0);
  assert.equal(summary.skippedSpam, 2);
  assert.equal(summary.processed, 2);
  assert.equal(summary.remaining, 0);
  db.close();
});
