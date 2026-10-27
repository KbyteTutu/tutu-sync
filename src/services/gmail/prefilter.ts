/**
 * 本地初筛（零 token）：SpamAssassin 式的加权规则 + noisy-OR 置信度。
 *
 * 判定只用本地已有数据：发件人、主题、完整正文（入库时最多 20k 字）、以及少量邮件头。
 * 只有「批量/营销/自动通知」置信度 >= 80% 时才直接过滤；其余（包括普通邮件）
 * 都交给 LLM 进一步分析——即用户要求的「不能完全确认才交给 LLM」。
 */
import { parseStoredHeaders } from './headers.js';

export type PrefilterKind = 'spam' | 'noise';

export interface PrefilterInput {
  fromAddr: string | null;
  fromName: string | null;
  subject: string | null;
  body: string | null;
  /** 入库时保存的邮件头 JSON */
  headers: string | null;
}

export interface PrefilterVerdict {
  kind: PrefilterKind;
  /** 批量/营销或自动通知的置信度（0-100） */
  confidence: number;
  /** 是否可以直接跳过 LLM（置信度 >= 80%） */
  skipLlm: boolean;
  reason: string;
  /** 写入 analysis 的分类 */
  category: string;
}

interface Signal {
  weight: number;
  reason: string;
}

const CONFIDENCE_THRESHOLD = 0.8;

const MARKETING_SENDER = /^(news|newsletter|marketing|promo|promotions?|campaign|mailer|ads?|deals?|offers?)@/i;
const NO_REPLY_SENDER = /^(no-?reply|do-?not-?reply)/i;
const AUTOMATED_SENDER = /^(notifications?|alerts?|service|system|billing|support|bounce)@/i;
const BULK_MAILER = /mailchimp|sendgrid|sendinblue|brevo|klaviyo|hubspot|salesforce|sfmc|activecampaign|mailgun|postmark|constantcontact|zuckmail|marketo|pardot|customer\.io/i;

const MARKETING_SUBJECT =
  /退订|unsubscribe|newsletter|webinar|促销|折扣|优惠|限时|秒杀|特价|清仓|返现|红包|优惠券|领券|中奖|抽奖|免费领|广告|推广/i;
const NOTIFICATION_SUBJECT = /验证码|verification code|one-?time|otp|发货|物流|签收|shipped|delivered/i;
/** 账单/安全/付款类即使带批量头也必须交给 LLM，不能被初筛静默丢掉 */
const ACTIONABLE_SUBJECT =
  /账单|发票|收据|receipt|invoice|statement|付款|支付|退款|续费|到期|逾期|安全提醒|security alert|异常登录|密码|登录提醒|sign-?in/i;
const MARKETING_BODY =
  /退订|unsubscribe|list-unsubscribe|点击.{0,8}(购买|领取|查看详情)|立即购买|立即抢购|优惠码|coupon|promo code|本邮件为营销|此邮件由.*发送/i;

export function prefilter(input: PrefilterInput): PrefilterVerdict {
  const headers = parseStoredHeaders(input.headers);
  const from = input.fromAddr ?? '';
  const subject = input.subject ?? '';
  const body = input.body ?? '';
  const spamSignals: Signal[] = [];
  const noiseSignals: Signal[] = [];

  // —— 批量投递头（SpamAssassin 的 BULK_* 思路，权重最高）——
  const precedence = (headers.precedence ?? '').toLowerCase();
  if (/bulk|list|junk/.test(precedence)) {
    spamSignals.push({ weight: 0.9, reason: `Precedence: ${precedence}` });
  }
  if (headers.listUnsubscribe) spamSignals.push({ weight: 0.85, reason: 'List-Unsubscribe' });
  if (headers.feedbackId) spamSignals.push({ weight: 0.75, reason: 'Feedback-ID' });
  if (headers.listId) spamSignals.push({ weight: 0.7, reason: 'List-Id/List-Post' });
  if (headers.xMailer && BULK_MAILER.test(headers.xMailer)) {
    spamSignals.push({ weight: 0.75, reason: `X-Mailer: ${headers.xMailer}` });
  }
  if (headers.bulkHeaders.length > 0) {
    spamSignals.push({ weight: 0.65, reason: `批量发信头: ${headers.bulkHeaders.join('/')}` });
  }
  if (headers.autoSubmitted && /auto-(generated|replied)/i.test(headers.autoSubmitted)) {
    noiseSignals.push({ weight: 0.8, reason: 'Auto-Submitted' });
  }

  // —— 发件人 ——
  if (MARKETING_SENDER.test(from)) spamSignals.push({ weight: 0.6, reason: '发件人是营销账号' });
  if (NO_REPLY_SENDER.test(from)) {
    spamSignals.push({ weight: 0.4, reason: 'no-reply 发件人' });
    noiseSignals.push({ weight: 0.4, reason: 'no-reply 发件人' });
  }
  if (AUTOMATED_SENDER.test(from)) noiseSignals.push({ weight: 0.55, reason: '自动通知发件人' });

  // —— 主题与完整正文（不截断到 500 字）——
  if (MARKETING_SUBJECT.test(subject)) spamSignals.push({ weight: 0.55, reason: '主题含营销词' });
  if (NOTIFICATION_SUBJECT.test(subject)) noiseSignals.push({ weight: 0.6, reason: '主题像自动通知' });
  if (MARKETING_BODY.test(body)) spamSignals.push({ weight: 0.5, reason: '正文含营销/退订特征' });

  const notificationSubject = NOTIFICATION_SUBJECT.test(subject);
  const actionableSubject = ACTIONABLE_SUBJECT.test(subject);

  const spamConfidence = noisyOr(spamSignals);
  const noiseConfidence = noisyOr(noiseSignals);
  // 通知主题是强证据：即使同时带批量头，也应归为通知而不是垃圾
  const confidence = Math.max(
    spamConfidence,
    noiseConfidence,
    notificationSubject ? CONFIDENCE_THRESHOLD : 0,
  );
  let kind: PrefilterKind = spamConfidence >= noiseConfidence ? 'spam' : 'noise';
  if (notificationSubject) kind = 'noise';
  const signals = kind === 'spam' ? spamSignals : noiseSignals;
  const reasons = signals.map((signal) => signal.reason);
  if (notificationSubject) reasons.push('主题是验证码/物流类通知');

  return {
    kind,
    confidence: Math.round(confidence * 100),
    // 账单/安全/付款类必须由 LLM 判断，不允许本地静默过滤
    skipLlm: !actionableSubject && confidence >= CONFIDENCE_THRESHOLD,
    reason: actionableSubject
      ? `主题含账单/安全/付款等需关注内容，强制交给 LLM${reasons.length > 0 ? '（' + reasons.join(' + ') + '）' : ''}`
      : reasons.length > 0
        ? reasons.join(' + ')
        : '未命中批量/通知规则（交给 LLM）',
    category: kind === 'spam' ? '垃圾' : '通知',
  };
}

/** 多个独立证据的 noisy-OR 组合：置信度随命中信号增加而升高 */
function noisyOr(signals: Signal[]): number {
  let remain = 1;
  for (const signal of signals) remain *= 1 - signal.weight;
  return 1 - remain;
}

/** 初筛直接过滤时的占位分析（不调用 LLM） */
export function prefilterAnalysis(verdict: PrefilterVerdict): string {
  return JSON.stringify({
    summary:
      verdict.kind === 'spam'
        ? `本地初筛判定为营销/垃圾邮件（置信度 ${verdict.confidence}%），未调用 LLM`
        : `本地初筛判定为自动通知（置信度 ${verdict.confidence}%），未调用 LLM`,
    category: verdict.category,
    priority: 'low',
    action_required: false,
    action: '',
    key_points: [],
    prefilter: {
      kind: verdict.kind,
      confidence: verdict.confidence,
      reason: verdict.reason,
    },
  });
}
