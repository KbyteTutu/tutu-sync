import type { LlmConfig } from './schema.js';
import { parseDuration } from '../../lib/duration.js';
import { errMsg } from '../../lib/log.js';

export interface AnalyzeInput {
  fromAddr: string | null;
  fromName: string | null;
  subject: string | null;
  date: string | null;
  text: string;
  /** 本次分析的额外要求（追加到系统提示词尾部） */
  instruction?: string;
}

export interface LlmUsage {
  model: string;
  /** 实际发出的请求次数（含失败重试） */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AnalysisOutcome {
  /** 成功时为 LLM 输出的规范化 JSON 字符串 */
  analysis: string | null;
  error: string | null;
  usage: LlmUsage;
  category: string | null;
  spam: boolean;
}

const SPAM_CATEGORIES = ['垃圾', '垃圾邮件', 'spam', 'junk'];

/** 是否为垃圾邮件分类（模型可能输出中文或英文） */
export function isSpamCategory(category: string | null): boolean {
  if (!category) return false;
  const normalized = category.trim().toLowerCase();
  return SPAM_CATEGORIES.some((item) => normalized === item || normalized.includes('垃圾'));
}

export async function analyzeEmail(llm: LlmConfig, input: AnalyzeInput): Promise<AnalysisOutcome> {
  const from = input.fromName ? `${input.fromName} <${input.fromAddr}>` : input.fromAddr;
  const body = input.text.slice(0, llm.max_body_chars);
  const user = [
    `发件人: ${from ?? '未知'}`,
    `时间: ${input.date ?? '未知'}`,
    `主题: ${input.subject ?? '(无主题)'}`,
    '',
    '正文:',
    body,
  ].join('\n');

  const instruction = input.instruction?.trim();
  const system = instruction ? `${llm.prompt}\n\n本次额外要求（优先满足）：${instruction}` : llm.prompt;
  const url = `${llm.base_url.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = parseDuration(llm.timeout) * 1000;
  const usage: LlmUsage = {
    model: llm.model,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  let lastError = '';

  for (let attempt = 0; attempt <= llm.max_retries; attempt++) {
    usage.calls++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${llm.api_key}`,
        },
        body: JSON.stringify({
          model: llm.model,
          temperature: llm.temperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`LLM HTTP ${res.status}: ${body}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      accumulate(usage, data.usage);
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('LLM 响应缺少 content');
      }
      const parsed = extractJson(content);
      if (typeof parsed.summary !== 'string') {
        throw new Error('LLM 输出缺少 summary 字段');
      }
      const category = typeof parsed.category === 'string' ? parsed.category : null;
      return {
        analysis: JSON.stringify(parsed),
        error: null,
        usage,
        category,
        spam: isSpamCategory(category),
      };
    } catch (e) {
      lastError = errMsg(e);
    }
  }
  return { analysis: null, error: lastError, usage, category: null, spam: false };
}

function accumulate(usage: LlmUsage, raw: ChatUsage | undefined): void {
  if (!raw) return;
  usage.promptTokens += number(raw.prompt_tokens);
  usage.completionTokens += number(raw.completion_tokens);
  usage.totalTokens += number(raw.total_tokens);
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function extractJson(content: string): Record<string, unknown> {
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`LLM 输出中未找到 JSON: ${cleaned.slice(0, 100)}`);
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error(`LLM 输出不是合法 JSON: ${cleaned.slice(start, start + 100)}`);
  }
}

interface ChatUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: ChatUsage;
}
