import { z } from 'zod';

/** 邮件服务（IMAP + OpenAI 兼容 LLM）。整段可选：未配置则不注册 gmail 工具。 */
export const GmailSchema = z.object({
  imap: z.object({
    host: z.string().min(1),
    port: z.number().int().positive().default(993),
    secure: z.boolean().default(true),
    user: z.string().min(1),
    password: z.string().min(1),
    mailbox: z.string().default('INBOX'),
  }),
  fetch: z.object({
    interval: z.string().default('30m'),
    initial_days: z.number().int().min(0).default(7),
    batch_size: z.number().int().positive().default(20),
    max_batches_per_run: z.number().int().positive().default(10),
    mark_seen: z.boolean().default(false),
  }),
  llm: z.object({
    base_url: z.url(),
    api_key: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).default(0.2),
    timeout: z.string().default('60s'),
    max_retries: z.number().int().min(0).default(1),
    max_body_chars: z.number().int().positive().default(8000),
    prompt: z.string().min(1),
  }),
});

export type GmailConfig = z.infer<typeof GmailSchema>;
export type ImapConfig = GmailConfig['imap'];
export type FetchConfig = GmailConfig['fetch'];
export type LlmConfig = GmailConfig['llm'];
