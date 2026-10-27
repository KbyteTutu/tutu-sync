import type { Logger } from '../../lib/log.js';
import { errMsg } from '../../lib/log.js';
import { Mutex } from '../../lib/mutex.js';
import {
  ipInCidr,
  ipOf,
  parseCidr,
  parseIpv4,
  renderClientConfig,
  subnetString,
  validatePeerName,
  type Cidr,
} from './client-config.js';
import type { WgConfig } from './config.js';

/** WGDashboard 统一响应包 */
interface Envelope<T> {
  status: boolean;
  message: string | null;
  data: T;
}

/** getWireguardConfigurationInfo 的原始结构（字段名由面板决定，保持原样） */
interface RawPeer {
  id: string;
  name?: string;
  allowed_ip?: string;
  DNS?: string;
  keepalive?: number;
  mtu?: number;
  endpoint?: string;
  latest_handshake?: string;
  status?: string;
  private_key?: string;
}

interface RawConfiguration {
  Name?: string;
  Address?: string;
  ListenPort?: number | string;
  PublicKey?: string;
}

interface RawInfo {
  configurationInfo?: RawConfiguration;
  configurationPeers?: RawPeer[];
  configurationRestrictedPeers?: RawPeer[];
}

export interface WgPeer {
  /** 公钥，同时是 WGDashboard 的 peer id */
  id: string;
  name: string;
  /** 内网 IP（不含掩码） */
  ip: string;
  allowedIp: string;
  dns: string | null;
  keepalive: number | null;
  mtu: number | null;
  endpoint: string | null;
  latestHandshake: string | null;
  status: string;
  restricted: boolean;
}

export interface WgConfiguration {
  name: string;
  address: string;
  listenPort: number;
  publicKey: string;
}

export interface WgSnapshot {
  configuration: WgConfiguration;
  peers: WgPeer[];
}

export interface IssuedPeer {
  nickname: string;
  ip: string;
  publicKey: string;
  privateKey: string;
  clientConfig: string;
}

export interface WgAvailability {
  available: boolean;
  reason: string | null;
}

/** 客户端本机接口名固定为 wg0（init.sh 写入 /etc/wireguard/wg0.conf） */
const CLIENT_INTERFACE = 'wg0';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * WGDashboard 后端：节点的新增/删除/查询全部走面板 REST API。
 * 密钥由面板生成，IP 分配/冲突校验/配置落盘/热应用也由面板负责；
 * 本客户端只做参数校验、结果整形与客户端配置渲染。
 */
export class WgDashboard {
  private readonly base: string;
  private readonly mutex = new Mutex();

  constructor(
    private readonly cfg: WgConfig | null,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = (cfg?.dashboard.url ?? '').replace(/\/+$/, '');
  }

  /** 可用性：配置存在且面板可读该 configuration */
  async status(): Promise<WgAvailability> {
    if (!this.cfg) return { available: false, reason: '未配置 wg 段（WGDashboard）' };
    try {
      await this.snapshot();
      return { available: true, reason: null };
    } catch (e) {
      return { available: false, reason: errMsg(e) };
    }
  }

  async snapshot(): Promise<WgSnapshot> {
    this.require();
    const data = await this.request<RawInfo>(
      `/api/getWireguardConfigurationInfo?configurationName=${encodeURIComponent(this.cfg!.configuration)}`,
    );
    const info = data?.configurationInfo;
    if (!info?.Address || !info.PublicKey) {
      throw new Error('WGDashboard 未返回配置信息（Address / PublicKey）');
    }
    const peers = [
      ...(data.configurationPeers ?? []).map((peer) => toPeer(peer, false)),
      ...(data.configurationRestrictedPeers ?? []).map((peer) => toPeer(peer, true)),
    ];
    return {
      configuration: {
        name: info.Name ?? this.cfg!.configuration,
        address: info.Address,
        listenPort: Number(info.ListenPort ?? 0),
        publicKey: info.PublicKey,
      },
      peers,
    };
  }

  /** 只读校验指定 IP 可签发（不创建节点） */
  async assertIpAvailable(ip: string): Promise<void> {
    const snapshot = await this.snapshot();
    this.assertAddress(ip, snapshot.configuration.address, snapshot.peers);
  }

  /** 签发节点：面板生成密钥并落盘，返回可直接使用的客户端配置 */
  issue(name: string, requestedIp?: string): Promise<IssuedPeer> {
    return this.mutex.run(async () => {
      const peerName = validatePeerName(name);
      const snapshot = await this.snapshot();
      const body: Record<string, unknown> = { name: peerName, notes: '' };
      if (requestedIp !== undefined) {
        this.assertAddress(requestedIp, snapshot.configuration.address, snapshot.peers);
        body.allowed_ips = [`${requestedIp}/32`];
      }
      const created = await this.add(body);
      return this.issued(created);
    });
  }

  /** 按用途名或 IP 删除节点 */
  remove(target: string): Promise<WgPeer> {
    return this.mutex.run(async () => {
      const peer = resolvePeer((await this.snapshot()).peers, target);
      await this.delete(peer.id);
      return peer;
    });
  }

  /** 轮换密钥：面板不允许改私钥，因此按同名同 IP 删除后重建 */
  rotate(target: string): Promise<IssuedPeer> {
    return this.mutex.run(async () => {
      const peer = resolvePeer((await this.snapshot()).peers, target);
      await this.delete(peer.id);
      let created: RawPeer;
      try {
        created = await this.add({ name: peer.name, allowed_ips: [peer.allowedIp], notes: '' });
      } catch (e) {
        throw new Error(`旧节点 ${peer.ip} 已删除，但重建失败，需重新签发: ${errMsg(e)}`);
      }
      return this.issued(created);
    });
  }

  // ---- 内部实现 ----

  private require(): WgConfig {
    if (!this.cfg) throw new Error('未配置 wg 段（WGDashboard）');
    return this.cfg;
  }

  private async request<T>(path: string, init: { method?: string; body?: string } = {}): Promise<T> {
    const cfg = this.require();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? 'GET',
        body: init.body,
        headers: {
          'content-type': 'application/json',
          'wg-dashboard-apikey': cfg.dashboard.api_key,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`WGDashboard 请求失败（${this.base}）: ${errMsg(e)}`);
    }
    const text = await res.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new Error(`WGDashboard 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok || envelope.status === false) {
      const message = typeof envelope.message === 'string' ? envelope.message.trim() : '';
      throw new Error(`WGDashboard: ${message || `HTTP ${res.status}`}`);
    }
    return envelope.data;
  }

  private async add(body: Record<string, unknown>): Promise<RawPeer> {
    const data = await this.request<RawPeer[] | RawPeer>(
      `/api/addPeers/${encodeURIComponent(this.require().configuration)}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    const peer = Array.isArray(data) ? data[0] : data;
    if (!peer?.id) throw new Error('WGDashboard 未返回新节点（IP 可能已被占用）');
    return peer;
  }

  private async delete(id: string): Promise<void> {
    await this.request(`/api/deletePeers/${encodeURIComponent(this.require().configuration)}`, {
      method: 'POST',
      body: JSON.stringify({ peers: [id] }),
    });
  }

  /** 用面板的权威数据渲染客户端配置；私钥只来自 add 响应 */
  private async issued(created: RawPeer): Promise<IssuedPeer> {
    const cfg = this.require();
    const snapshot = await this.snapshot();
    const peer = snapshot.peers.find((item) => item.id === created.id);
    if (!peer) throw new Error('节点已创建但未出现在配置中，请用 tutu_wg_peers 复核');
    const privateKey = created.private_key?.trim();
    if (!privateKey) {
      throw new Error('WGDashboard 未返回私钥，无法生成客户端配置（请到面板导出该节点）');
    }
    const cidr = parseCidr(snapshot.configuration.address);
    const issued: IssuedPeer = {
      nickname: peer.name,
      ip: peer.ip,
      publicKey: peer.id,
      privateKey,
      clientConfig: renderClientConfig({
        privateKey,
        ip: peer.ip,
        subnet: subnetString(cidr),
        serverPublicKey: snapshot.configuration.publicKey,
        endpoint: cfg.endpoint,
        dns: peer.dns,
        dnsDomain: cfg.dns_domain,
        keepalive: peer.keepalive,
        interface: CLIENT_INTERFACE,
      }),
    };
    this.log.info(
      `wg: ${cfg.configuration} 签发 ${issued.ip} (${issued.nickname})，已由 WGDashboard 落盘`,
    );
    return issued;
  }

  private assertAddress(ip: string, address: string, peers: WgPeer[]): void {
    if (parseIpv4(ip) === null) throw new Error(`IP 非法: ${ip}`);
    const cidr: Cidr = parseCidr(address);
    if (!ipInCidr(ip, cidr)) {
      throw new Error(`IP 不在网段 ${subnetString(cidr)} 内: ${ip}`);
    }
    if (ip === ipOf(address)) throw new Error(`IP 是服务器自身地址，不能分配: ${ip}`);
    if (peers.some((peer) => peer.ip === ip)) throw new Error(`IP 已被占用: ${ip}`);
  }
}

function toPeer(raw: RawPeer, restricted: boolean): WgPeer {
  return {
    id: raw.id,
    name: raw.name?.trim() || '(无名)',
    ip: ipOf(raw.allowed_ip ?? ''),
    allowedIp: raw.allowed_ip ?? '',
    dns: raw.DNS?.trim() || null,
    keepalive: typeof raw.keepalive === 'number' ? raw.keepalive : null,
    mtu: typeof raw.mtu === 'number' ? raw.mtu : null,
    endpoint: raw.endpoint && raw.endpoint !== 'N/A' ? raw.endpoint : null,
    latestHandshake:
      raw.latest_handshake && raw.latest_handshake !== 'N/A' ? raw.latest_handshake : null,
    status: raw.status ?? 'unknown',
    restricted,
  };
}

/** 按用途名或 IP 唯一定位节点 */
function resolvePeer(peers: WgPeer[], target: string): WgPeer {
  const trimmed = target.trim();
  const byName = peers.filter((peer) => peer.name === trimmed);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`节点名 "${target}" 匹配到多个节点，请改用 IP 指定`);
  }
  const byIp = peers.filter((peer) => peer.ip === ipOf(trimmed));
  if (byIp.length === 1) return byIp[0];
  const inventory = peers.map((peer) => `${peer.name}(${peer.ip})`).join(', ');
  throw new Error(`未找到节点: ${target}。现有节点: ${inventory || '无'}`);
}
