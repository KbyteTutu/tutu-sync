/**
 * wg0.conf 的纯文本操作：解析 peer 块、分配 IP、增删改、渲染客户端配置。
 * 全部为纯函数，便于单元测试；文件 I/O 与 wg 命令在 manager.ts。
 */

export interface Peer {
  nickname: string;
  publicKey: string;
  allowedIps: string[];
  /** 块起始行（含 `# nickname:` 注释行，若有） */
  start: number;
  /** 块结束行（不含），指向下一个 section 或文件末尾 */
  end: number;
  /** `[Peer]` 行号 */
  header: number;
}

const NICKNAME_RE = /^#\s*nickname:\s*(.*)$/;
const PEER_RE = /^\[peer\]$/i;
const SECTION_RE = /^\[[a-z]+\]$/i;

/** 内网用途名：只能出现在注释里，禁止空白/#/换行，长度 ≤ 40 */
export function validateNickname(name: string): string {
  const trimmed = name.trim();
  if (!/^[^#\s]{1,40}$/.test(trimmed)) {
    throw new Error(`用途名不合法（禁止空白与 #，长度 1-40）: "${name}"`);
  }
  return trimmed;
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

export interface Cidr {
  network: number;
  prefix: number;
}

export function parseCidr(cidr: string): Cidr {
  const [addr, prefixRaw] = cidr.trim().split('/');
  const ip = parseIpv4(addr ?? '');
  const prefix = Number(prefixRaw);
  if (ip === null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
    throw new Error(`无效网段: "${cidr}"（需形如 192.168.125.0/24）`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ip & mask) >>> 0, prefix };
}

export function ipInCidr(ip: string, cidr: Cidr): boolean {
  const value = parseIpv4(ip);
  if (value === null) return false;
  const mask = (0xffffffff << (32 - cidr.prefix)) >>> 0;
  return ((value & mask) >>> 0) === cidr.network;
}

/** 网段内最小空闲 IP（跳过网络地址、广播地址与 reserved） */
export function allocateIp(cidr: Cidr, reserved: string[]): string | null {
  const taken = new Set<number>();
  for (const ip of reserved) {
    const value = parseIpv4(ip);
    if (value !== null) taken.add(value);
  }
  const size = 2 ** (32 - cidr.prefix);
  for (let offset = 1; offset < size - 1; offset++) {
    const value = (cidr.network + offset) >>> 0;
    if (!taken.has(value)) return formatIpv4(value);
  }
  return null;
}

/** `[Peer]` 之前紧邻（跳过空行）的 `# nickname:` 行作为块起点 */
function peerStart(lines: string[], header: number): number {
  let j = header - 1;
  while (j >= 0 && lines[j].trim() === '') j--;
  return j >= 0 && NICKNAME_RE.test(lines[j].trim()) ? j : header;
}

/** 解析所有 peer 块；块的结束位置是下一个 peer 的 nickname 行或下一个 section */
export function parsePeers(text: string): Peer[] {
  const lines = text.split('\n');
  const sections: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i].trim())) sections.push(i);
  }

  const peers: Peer[] = [];
  for (const header of sections) {
    if (!PEER_RE.test(lines[header].trim())) continue;
    const start = peerStart(lines, header);
    const next = sections.find((index) => index > header);
    // 下一个 section 是 peer 时，它的 nickname 行属于它自己（不能算进本块）
    const end =
      next === undefined
        ? lines.length
        : PEER_RE.test(lines[next].trim())
          ? peerStart(lines, next)
          : next;

    let publicKey = '';
    const allowedIps: string[] = [];
    for (let k = header + 1; k < end; k++) {
      const line = lines[k].trim();
      const pub = /^PublicKey\s*=\s*(\S+)$/i.exec(line);
      if (pub) publicKey = pub[1];
      const allowed = /^AllowedIPs\s*=\s*(.+)$/i.exec(line);
      if (allowed) {
        allowedIps.push(
          ...allowed[1]
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
      }
    }
    peers.push({ nickname: nicknameOf(lines, header), publicKey, allowedIps, start, end, header });
  }
  return peers;
}

function nicknameOf(lines: string[], header: number): string {
  const start = peerStart(lines, header);
  if (start === header) return '';
  return NICKNAME_RE.exec(lines[start].trim())?.[1].trim() ?? '';
}

/** peer 占用的 IP（去掉 /NN 后缀，只保留 IPv4） */
export function peerIps(peer: Peer): string[] {
  return peer.allowedIps
    .map((entry) => entry.split('/')[0]?.trim() ?? '')
    .filter((ip) => parseIpv4(ip) !== null);
}

export function allPeerIps(peers: Peer[]): string[] {
  return peers.flatMap(peerIps);
}

/** 追加 peer（只追加，不动既有内容） */
export function appendPeer(text: string, nickname: string, publicKey: string, ip: string): string {
  const body = text.replace(/\s+$/, '');
  const lead = body === '' ? '' : '\n\n';
  return `${body}${lead}# nickname: ${nickname}\n[Peer]\nPublicKey = ${publicKey}\nAllowedIPs = ${ip}/32\n`;
}

/** 删除整个 peer 块（含 nickname 注释与块内空行） */
export function removePeer(text: string, peer: Peer): string {
  const lines = text.split('\n');
  const kept = [...lines.slice(0, peer.start), ...lines.slice(peer.end)];
  return kept.join('\n').replace(/(?:\n[ \t]*)+$/, '\n');
}

/** 替换 peer 公钥（私钥丢失重建），其余内容逐字节保留 */
export function replacePeerKey(text: string, peer: Peer, publicKey: string): string {
  const lines = text.split('\n');
  for (let i = peer.header + 1; i < peer.end; i++) {
    if (/^PublicKey\s*=/i.test(lines[i].trim())) {
      lines[i] = `PublicKey = ${publicKey}`;
      return lines.join('\n');
    }
  }
  throw new Error('目标 peer 块缺少 PublicKey 行，拒绝改写');
}

export interface ClientConfigInput {
  privateKey: string;
  ip: string;
  subnet: string;
  serverPublicKey: string;
  endpoint: string;
  dns: string | null;
  dnsDomain: string;
  interface: string;
}

/** 客户端 wg0.conf：字段顺序固定，无行内注释 */
export function renderClientConfig(input: ClientConfigInput): string {
  const prefix = parseCidr(input.subnet).prefix;
  const lines = [
    '[Interface]',
    `PrivateKey = ${input.privateKey}`,
    `Address = ${input.ip}/${prefix}`,
  ];
  if (input.dns !== null) {
    lines.push(
      `PostUp = resolvectl dns ${input.interface} ${input.dns}; resolvectl domain ${input.interface} '${input.dnsDomain}'`,
      `PreDown = resolvectl domain ${input.interface} ''; resolvectl dns ${input.interface} ''`,
    );
  }
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.endpoint}`,
    `AllowedIPs = ${input.subnet}`,
    'PersistentKeepalive = 25',
    '',
  );
  return lines.join('\n');
}

/** WireGuard base64 密钥：43 数据字符 + '=' */
export function validateKey(key: string): string {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) {
    throw new Error('密钥格式非法（应为 44 字符 WireGuard base64）');
  }
  return key;
}
