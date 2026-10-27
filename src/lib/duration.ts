const UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  seconds: 1,
  m: 60,
  min: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
};

/** 解析 "30s" / "10m" / "2h" / "1d" 形式的时间字符串，返回秒数 */
export function parseDuration(input: string): number {
  const m = /^\s*(\d+)\s*(s|sec|seconds|m|min|minutes|h|hr|hours|d|day|days)\s*$/i.exec(input);
  if (!m) {
    throw new Error(`无效的时间格式: "${input}"（支持 "30s"、"10m"、"2h"、"1d"）`);
  }
  const unit = UNITS[m[2].toLowerCase()];
  return Number(m[1]) * unit;
}
