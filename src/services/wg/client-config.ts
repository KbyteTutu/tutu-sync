/**
 * 与 WGDashboard 无关的纯逻辑：IPv4/网段校验、节点名校验、客户端 wg0.conf 渲染。
 */

export interface Cidr {
  network: number;
  prefix: number;
}

export function parseIpv4(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function formatIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** 解析 WGDashboard 的 Address（如 192.168.125.1/24），主机位被掩掉 */
export function parseCidr(cidr: string): Cidr {
  const [addr, prefixRaw] = cidr.trim().split('/');
  const ip = parseIpv4(addr ?? '');
  const prefix = Number(prefixRaw);
  if (ip === null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
    throw new Error(`WGDashboard 配置的 Address 非法: "${cidr}"`);
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ip & mask) >>> 0, prefix };
}

export function ipInCidr(ip: string, cidr: Cidr): boolean {
  const value = parseIpv4(ip);
  if (value === null) return false;
  const mask = (0xffffffff << (32 - cidr.prefix)) >>> 0;
  return ((value & mask) >>> 0) === cidr.network;
}

export function subnetString(cidr: Cidr): string {
  return `${formatIpv4(cidr.network)}/${cidr.prefix}`;
}

/** "192.168.125.2/32" -> "192.168.125.2"；无法解析时原样返回 */
export function ipOf(allowedIp: string): string {
  return allowedIp.split('/')[0]?.trim() ?? allowedIp;
}

/** 节点名：WGDashboard 允许空格，这里只拒绝控制字符并限长，便于按名字定位 */
export function validatePeerName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > 64) {
    throw new Error('节点名不能为空且不超过 64 字符');
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('节点名不能包含控制字符或换行');
  }
  return trimmed;
}

export interface ClientConfigInput {
  privateKey: string;
  /** 客户端内网 IP（不含掩码） */
  ip: string;
  subnet: string;
  serverPublicKey: string;
  endpoint: string;
  dns: string | null;
  dnsDomain: string;
  keepalive: number | null;
  interface: string;
}

/** 客户端 wg0.conf：字段顺序固定，无行内注释 */
export function renderClientConfig(input: ClientConfigInput): string {
  const prefix = parseCidr(input.subnet).prefix;
  const lines = ['[Interface]', `PrivateKey = ${input.privateKey}`, `Address = ${input.ip}/${prefix}`];
  const dnsServers = (input.dns ?? '').split(/[,\s]+/).filter(Boolean);
  if (dnsServers.length > 0) {
    lines.push(
      `PostUp = resolvectl dns ${input.interface} ${dnsServers.join(' ')}; resolvectl domain ${input.interface} '${input.dnsDomain}'`,
      `PreDown = resolvectl domain ${input.interface} ''; resolvectl dns ${input.interface} ''`,
    );
  }
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.endpoint}`,
    `AllowedIPs = ${input.subnet}`,
  );
  if (input.keepalive !== null && input.keepalive > 0) {
    lines.push(`PersistentKeepalive = ${input.keepalive}`);
  }
  lines.push('');
  return lines.join('\n');
}
