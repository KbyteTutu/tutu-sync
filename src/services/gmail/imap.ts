/** 消息主体解析（imapflow + mailparser），输出统一的 RawEmail 供入库与分析 */
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { htmlToText } from 'html-to-text';
import type { ImapConfig } from './schema.js';
import { errMsg, type Logger } from '../../lib/log.js';

export interface RawEmail {
  uid: number;
  seen: boolean;
  messageId: string | null;
  fromAddr: string | null;
  fromName: string | null;
  toAddr: string | null;
  subject: string | null;
  date: string | null;
  text: string;
  snippet: string;
}

export interface MailboxInfo {
  uidValidity: number;
  uidNext: number;
}

const SNIPPET_LEN = 200;

export class GmailImap {
  constructor(
    private readonly cfg: ImapConfig,
    private readonly log: Logger,
  ) {}

  /** 建立连接执行操作，结束后始终断开（普通退出走 LOGOUT，异常时直接关连接） */
  private async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure,
      auth: { user: this.cfg.user, pass: this.cfg.password },
      logger: false,
    });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      return await fn(client);
    } finally {
      try {
        if (connected) await client.logout();
        else client.close();
      } catch (e) {
        this.log.debug(`关闭 IMAP 连接时出错: ${errMsg(e)}`);
      }
    }
  }

  private static assertMailbox(client: ImapFlow): { uidValidity: number; uidNext: number } {
    const box = client.mailbox;
    if (!box || typeof box === 'boolean') {
      throw new Error('邮箱打开失败');
    }
    return { uidValidity: Number(box.uidValidity), uidNext: Number(box.uidNext) };
  }

  async mailboxInfo(mailbox: string): Promise<MailboxInfo> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        return GmailImap.assertMailbox(client);
      } finally {
        lock.release();
      }
    });
  }

  /**
   * 计算起始水位 uid：取 initial_days 内最早一封的前一个 uid；
   * 窗口内没有邮件则从当前 uidNext-1（即只收未来的新邮件）开始。
   */
  async resolveStartUid(mailbox: string, initialDays: number): Promise<number> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const info = GmailImap.assertMailbox(client);
        const since = new Date(Date.now() - initialDays * 86_400_000);
        const searched = await client.search({ since }, { uid: true });
        const uids = Array.isArray(searched) ? searched : [];
        if (uids.length === 0) return info.uidNext - 1;
        return Math.min(...uids) - 1;
      } finally {
        lock.release();
      }
    });
  }

  /** 拉取 uid > afterUid 的最早 limit 封，解析为 RawEmail */
  async fetchBatch(
    mailbox: string,
    afterUid: number,
    limit: number,
    maxBodyChars: number,
  ): Promise<RawEmail[]> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        GmailImap.assertMailbox(client);
        const searched = await client.search({ uid: `${afterUid + 1}:*` }, { uid: true });
        const uids = (Array.isArray(searched) ? searched : [])
          .filter((u) => u > afterUid)
          .sort((a, b) => a - b)
          .slice(0, limit);
        if (uids.length === 0) return [];

        const out: RawEmail[] = [];
        const fetchSet = uids.join(',');
        for await (const msg of client.fetch(fetchSet, { uid: true, source: true, flags: true }, { uid: true })) {
          // imapflow 的 flags/source 均可能为 undefined，逐一兜底
          const flags = msg.flags ?? new Set<string>();
          if (!msg.source) {
            this.log.warn(`邮件 uid=${msg.uid} 无正文数据，跳过`);
            continue;
          }
          out.push(await parseMessage(msg.uid, flags, msg.source, maxBodyChars));
        }
        out.sort((a, b) => a.uid - b.uid);
        return out;
      } finally {
        lock.release();
      }
    });
  }

  async markSeen(mailbox: string, uids: number[]): Promise<void> {
    if (uids.length === 0) return;
    await this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
      } finally {
        lock.release();
      }
    });
  }
}

async function parseMessage(
  uid: number,
  flags: Set<string>,
  source: Buffer,
  maxBodyChars: number,
): Promise<RawEmail> {
  const parsed = await simpleParser(source);
  // mailparser 的地址字段是 AddressObject | AddressObject[]，text/html 可能是 false，统一在此收敛
  const from = firstAddress(parsed.from);
  const to = firstAddress(parsed.to);
  const text = extractText(strOrNull(parsed.text), strOrNull(parsed.html), maxBodyChars);
  return {
    uid,
    seen: flags.has('\\Seen'),
    messageId: strOrNull(parsed.messageId),
    fromAddr: from?.address ?? null,
    fromName: from?.name || null,
    toAddr: to?.address ?? null,
    subject: strOrNull(parsed.subject),
    date: parsed.date?.toISOString() ?? null,
    text,
    snippet: text.slice(0, SNIPPET_LEN).replace(/\s+/g, ' ').trim(),
  };
}

interface Address {
  address?: string;
  name?: string;
}

function firstAddress(field: AddressObject | AddressObject[] | undefined): Address | null {
  const obj = Array.isArray(field) ? field[0] : field;
  return obj?.value?.[0] ?? null;
}

function strOrNull(v: string | false | null | undefined): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function extractText(text: string | null, html: string | null, maxBodyChars: number): string {
  let body = text?.trim();
  if (!body && html) {
    body = htmlToText(html, { wordwrap: false }).trim();
  }
  body = body || '';
  if (body.length > maxBodyChars) {
    body = `${body.slice(0, maxBodyChars)}…[正文超长已截断]`;
  }
  return body;
}
