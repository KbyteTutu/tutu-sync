/** 单封邮件的 LLM 结构化分析（OpenAI 兼容 /chat/completions） */
import type { LlmConfig } from './schema.js';
import { errMsg } from '../../lib/log.js';
import { parseDuration } from '../../lib/duration.js';

export interface AnalyzeInput {
  fromAddr: string | null;
  fromName: string | null;
  subject: string | null;
  date: string | null;
  text: string;
}

export interface AnalysisOutcome {
  /** 成功时为 LLM 输出的规范化 JSON 字符串 */
  analysis: string | null;
  error: string | null;
}

export async function analyzeEmail(llm: LlmConfig, input: AnalyzeInput): Promise<AnalysisOutcome> {
  const from = input.fromName ? `${input.fromName} <${input.fromAddr}>` : input.fromAddr;
  const user = [
    `发件人: ${from ?? '未知'}`,
    `时间: ${input.date ?? '未知'}`,
    `主题: ${input.subject ?? '(无主题)'}`,
    '',
    '正文:',
    input.text,
  ].join('\n');

  const url = `${llm.base_url.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = parseDuration(llm.timeout) * 1000;
  let lastError = '';

  for (let attempt = 0; attempt <= llm.max_retries; attempt++) {
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
            { role: 'system', content: llm.prompt },
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
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('LLM 响应缺少 content');
      }
      const parsed = extractJson(content);
      if (typeof parsed.summary !== 'string') {
        throw new Error('LLM 输出缺少 summary 字段');
      }
      return { analysis: JSON.stringify(parsed), error: null };
    } catch (e) {
      lastError = errMsg(e);
    }
  }
  return { analysis: null, error: lastError };
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

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}
