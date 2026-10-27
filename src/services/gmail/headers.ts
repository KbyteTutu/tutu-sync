/**
 * 只保留判定「批量/营销/自动通知」需要的头。
 * 参考 SpamAssassin 的 HEADER 规则与 RFC 2369/2919、Google 批量发信人约定：
 *   List-Unsubscribe / List-Id、Precedence: bulk、Auto-Submitted、Feedback-ID、ESP 专有头。
 * 注意：Gmail 的「分类标签」（促销/社交/更新）不通过 IMAP 暴露，不能作为信号。
 */

export interface MailHeaders {
  listUnsubscribe: boolean;
  listId: boolean;
  precedence: string | null;
  autoSubmitted: string | null;
  feedbackId: boolean;
  xMailer: string | null;
  /** 命中的批量发信专有头（ESP / 营销平台） */
  bulkHeaders: string[];
}

/** 各家 ESP/营销平台用于批量投递的专有头（命中即视为批量） */
export const BULK_HEADER_KEYS = [
  'list-unsubscribe-post',
  'x-mailchimp-campaign',
  'x-campaign',
  'x-sfmc-stack',
  'x-kumoref',
  'x-sg-eid',
  'x-ses-outgoing',
  'x-sending-engine',
  'x-virtual-mta',
  'x-250ok-cid',
];

export const EMPTY_HEADERS: MailHeaders = {
  listUnsubscribe: false,
  listId: false,
  precedence: null,
  autoSubmitted: null,
  feedbackId: false,
  xMailer: null,
  bulkHeaders: [],
};

/** 从 mailparser 的 headerLines 提取；同名头只取第一条 */
export function extractHeaders(headerLines: readonly { key: string; line: string }[]): MailHeaders {
  const map = new Map<string, string>();
  for (const item of headerLines) {
    const key = item.key.toLowerCase();
    if (map.has(key)) continue;
    const colon = item.line.indexOf(':');
    map.set(key, colon >= 0 ? item.line.slice(colon + 1).trim() : '');
  }
  return {
    listUnsubscribe: map.has('list-unsubscribe'),
    listId: map.has('list-id') || map.has('list-post'),
    precedence: map.get('precedence') ?? null,
    autoSubmitted: map.get('auto-submitted') ?? null,
    feedbackId: map.has('feedback-id'),
    xMailer: map.get('x-mailer') ?? null,
    bulkHeaders: BULK_HEADER_KEYS.filter((key) => map.has(key)),
  };
}

export function serializeHeaders(headers: MailHeaders): string {
  return JSON.stringify(headers);
}

/** 从数据库里的 JSON 还原；损坏时退回空信号 */
export function parseStoredHeaders(json: string | null): MailHeaders {
  if (!json) return { ...EMPTY_HEADERS };
  try {
    const raw = JSON.parse(json) as Partial<MailHeaders>;
    return {
      ...EMPTY_HEADERS,
      ...raw,
      bulkHeaders: Array.isArray(raw.bulkHeaders) ? raw.bulkHeaders : [],
    };
  } catch {
    return { ...EMPTY_HEADERS };
  }
}
