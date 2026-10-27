import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../lib/log.js';
import { errMsg } from '../../lib/log.js';
import type { Mutex } from '../../lib/mutex.js';
import type { WgConfig } from './config.js';
import {
  allPeerIps,
  allocateIp,
  appendPeer,
  formatIpv4,
  ipInCidr,
  parseCidr,
  parseIpv4,
  parsePeers,
  peerIps,
  removePeer,
  renderClientConfig,
  replacePeerKey,
  validateKey,
  validateNickname,
  type Peer,
} from './peers.js';

export interface PeerStatus {
  nickname: string;
  ip: string;
  publicKey: string;
  endpoint: string | null;
  lastHandshake: string | null;
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

interface DumpPeer {
  publicKey: string;
  endpoint: string | null;
  allowedIps: string[];
  lastHandshake: number;
}

/**
 * wg 服务器端管理：只改 wg0.conf 的 peer 块，应用变更走 `wg syncconf`
 * （不重启接口、不断既有 peer）。所有写操作串行并先备份。
 */
export class WgManager {
  constructor(
    private readonly cfg: WgConfig | null,
    private readonly log: Logger,
    private readonly mutex: Mutex,
  ) {}

  status(): WgAvailability {
    if (!this.cfg) {
      return { available: false, reason: '未配置 wg 段（本服务不管理 WireGuard）' };
    }
    try {
      fs.accessSync(this.cfg.config, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      return {
        available: false,
        reason: `${this.cfg.config} 不可读写（compose 需挂载 /etc/wireguard）`,
      };
    }
    // 角色防护：只有 Address 等于 server_ip 的配置才是中心端，避免把客户端配置当服务器改
    let address: string | undefined;
    try {
      address = /^\s*Address\s*=\s*([0-9.]+)\/\d+/m.exec(
        fs.readFileSync(this.cfg.config, 'utf8'),
      )?.[1];
    } catch (e) {
      return { available: false, reason: `无法读取 ${this.cfg.config}: ${errMsg(e)}` };
    }
    if (address !== this.cfg.server_ip) {
      return {
        available: false,
        reason: `${this.cfg.config} 的 Address=${address ?? '?'} 不是服务器地址 ${this.cfg.server_ip}（本机不是 wg 服务器）`,
      };
    }
    try {
      this.exec('wg', ['show', this.cfg.interface]);
    } catch (e) {
      return {
        available: false,
        reason: `wg show ${this.cfg.interface} 失败（容器需 host 网络 + NET_ADMIN，且接口已启动）: ${errMsg(e)}`,
      };
    }
    try {
      this.exec('wg-quick', ['strip', this.cfg.config]);
    } catch (e) {
      return { available: false, reason: `wg-quick strip 失败（wireguard-tools 缺失或配置非法）: ${errMsg(e)}` };
    }
    return { available: true, reason: null };
  }

  private require(): WgConfig {
    const status = this.status();
    if (!status.available || !this.cfg) {
      throw new Error(`WireGuard 不可用: ${status.reason}`);
    }
    return this.cfg;
  }

  /** 配置中的 peer 清单叠加实时握手状态 */
  list(): PeerStatus[] {
    const cfg = this.require();
    const peers = parsePeers(fs.readFileSync(cfg.config, 'utf8'));
    const live = this.dump();
    return peers.flatMap((peer) => {
      const ips = peerIps(peer);
      if (ips.length === 0) return [];
      const ip = ips[0];
      const state = live.find((entry) => entry.allowedIps.some((a) => a.split('/')[0] === ip));
      return [
        {
          nickname: peer.nickname,
          ip,
          publicKey: peer.publicKey,
          endpoint: state?.endpoint ?? null,
          lastHandshake: state && state.lastHandshake > 0
            ? new Date(state.lastHandshake * 1000).toISOString()
            : null,
        },
      ];
    });
  }

  /** 只读校验：指定 IP 可用于签发（不改配置文件） */
  assertIpAvailable(ip: string): void {
    const cfg = this.require();
    const cidr = parseCidr(cfg.subnet);
    const used = new Set(allPeerIps(parsePeers(this.readConfig(cfg))));
    used.add(cfg.server_ip);
    this.validateIp(ip, cidr, used, cfg.server_ip);
  }

  /** 分配 IP 并签发 peer（私钥只在此次返回值中出现，不落盘到服务器） */
  issue(nickname: string, requestedIp?: string): Promise<IssuedPeer> {
    return this.mutex.run(() => {
      const cfg = this.require();
      const name = validateNickname(nickname);
      const cidr = parseCidr(cfg.subnet);
      const text = this.readConfig(cfg);
      const peers = parsePeers(text);
      const used = new Set(allPeerIps(peers));
      used.add(cfg.server_ip);

      const ip = requestedIp ? this.validateIp(requestedIp, cidr, used, cfg.server_ip) : this.allocate(cidr, used);
      const { privateKey, publicKey } = this.generateKeypair();

      this.writeConfig(cfg, appendPeer(text, name, publicKey, ip));
      this.apply(cfg);
      this.assertPresent(cfg, ip);

      return {
        nickname: name,
        ip,
        publicKey,
        privateKey,
        clientConfig: renderClientConfig({
          privateKey,
          ip,
          subnet: cfg.subnet,
          serverPublicKey: cfg.server_public_key,
          endpoint: cfg.endpoint,
          dns: cfg.dns,
          dnsDomain: cfg.dns_domain,
          interface: cfg.interface,
        }),
      };
    });
  }

  /** 删除 peer；target 可为 IP 或用途名 */
  remove(target: string): Promise<Peer> {
    return this.mutex.run(() => {
      const cfg = this.require();
      const text = this.readConfig(cfg);
      const peer = this.resolve(parsePeers(text), target);
      this.writeConfig(cfg, removePeer(text, peer));
      this.apply(cfg);
      for (const ip of peerIps(peer)) this.assertAbsent(ip);
      return peer;
    });
  }

  /** 换公钥（私钥丢失重建），返回新的客户端配置 */
  rotate(target: string): Promise<IssuedPeer> {
    return this.mutex.run(() => {
      const cfg = this.require();
      const text = this.readConfig(cfg);
      const peer = this.resolve(parsePeers(text), target);
      const ips = peerIps(peer);
      if (ips.length !== 1) throw new Error(`目标 peer 的 AllowedIPs 不是单一 /32，拒绝改写: ${peer.allowedIps.join(',')}`);
      const ip = ips[0];
      if (peer.nickname === '') throw new Error('目标 peer 缺少 `# nickname:` 注释，无法确定用途名');
      const { privateKey, publicKey } = this.generateKeypair();

      this.writeConfig(cfg, replacePeerKey(text, peer, publicKey));
      this.apply(cfg);
      this.assertPresent(cfg, ip);

      return {
        nickname: peer.nickname,
        ip,
        publicKey,
        privateKey,
        clientConfig: renderClientConfig({
          privateKey,
          ip,
          subnet: cfg.subnet,
          serverPublicKey: cfg.server_public_key,
          endpoint: cfg.endpoint,
          dns: cfg.dns,
          dnsDomain: cfg.dns_domain,
          interface: cfg.interface,
        }),
      };
    });
  }

  // ---- 内部实现 ----

  private exec(file: string, args: string[], input?: string): string {
    return execFileSync(file, args, {
      encoding: 'utf8',
      input,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  private readConfig(cfg: WgConfig): string {
    const text = fs.readFileSync(cfg.config, 'utf8');
    if (!/^\s*\[Interface\]/im.test(text)) {
      throw new Error(`${cfg.config} 不是有效的 wg 配置（缺少 [Interface]）`);
    }
    return text;
  }

  private backup(cfg: WgConfig): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '-').replace('Z', '');
    const target = `${cfg.config}.bak-${stamp}`;
    fs.copyFileSync(cfg.config, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
    return target;
  }

  /**
   * 先校验再落盘：wg-quick strip 只接受 `<name>.conf` 形式，
   * 所以在配置目录下的临时子目录里用 wg0.conf 这个名字校验新内容。
   * 校验失败时原配置保持不变。
   */
  private validate(content: string, dir: string): void {
    const work = fs.mkdtempSync(path.join(dir, '.validate-'));
    const file = path.join(work, 'wg0.conf');
    fs.writeFileSync(file, content, { mode: 0o600 });
    try {
      this.exec('wg-quick', ['strip', file]);
    } catch (e) {
      throw new Error(`新配置校验失败（未写入，原配置保持不变）: ${errMsg(e)}`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** 校验 → 备份 → 同目录临时文件 fsync → rename → 目录 fsync */
  private writeConfig(cfg: WgConfig, content: string): void {
    const info = fs.lstatSync(cfg.config);
    if (!info.isFile()) throw new Error(`${cfg.config} 必须是常规文件（不允许符号链接）`);
    const dir = path.dirname(cfg.config);
    this.validate(content, dir);
    this.backup(cfg);
    const tmp = path.join(dir, `.${path.basename(cfg.config)}.tmp-${process.pid}-${Date.now()}`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, cfg.config);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  /** 用 strip 后的配置覆盖运行态，不重启接口 */
  private apply(cfg: WgConfig): void {
    const stripped = this.exec('wg-quick', ['strip', cfg.config]);
    const tmp = path.join(path.dirname(cfg.config), `.wg-syncconf-${process.pid}-${Date.now()}.conf`);
    fs.writeFileSync(tmp, stripped, { mode: 0o600 });
    try {
      this.exec('wg', ['syncconf', cfg.interface, tmp]);
    } catch (e) {
      throw new Error(`wg syncconf 失败: ${errMsg(e)}`);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  private dump(): DumpPeer[] {
    const cfg = this.cfg;
    if (!cfg) return [];
    const raw = this.exec('wg', ['show', cfg.interface, 'dump']);
    const lines = raw.split('\n').slice(1).filter((line) => line.trim() !== '');
    return lines.map((line) => {
      const fields = line.split('\t');
      return {
        publicKey: fields[0] ?? '',
        endpoint: fields[2] && fields[2] !== '(none)' ? fields[2] : null,
        allowedIps: (fields[3] ?? '').split(',').filter(Boolean),
        lastHandshake: Number(fields[4] ?? 0),
      };
    });
  }

  /** 写入后以运行态为准校验：peer 必须真的出现在接口上 */
  private assertPresent(cfg: WgConfig, ip: string): void {
    const found = this.dump().some((peer) => peer.allowedIps.some((a) => a.split('/')[0] === ip));
    if (!found) throw new Error(`配置已写入，但 ${ip} 未出现在 wg show 中（syncconf 未生效）`);
    this.log.info(`${cfg.interface}: peer ${ip} 已生效`);
  }

  /** 删除后的反向校验：目标 IP 不得再出现在接口上 */
  private assertAbsent(ip: string): void {
    const found = this.dump().some((peer) => peer.allowedIps.some((a) => a.split('/')[0] === ip));
    if (found) throw new Error(`配置已写入，但 ${ip} 仍在 wg show 中（syncconf 未生效）`);
  }

  private generateKeypair(): { privateKey: string; publicKey: string } {
    const privateKey = validateKey(this.exec('wg', ['genkey']).trim());
    const publicKey = validateKey(this.exec('wg', ['pubkey'], privateKey).trim());
    return { privateKey, publicKey };
  }

  private allocate(cidr: ReturnType<typeof parseCidr>, used: Set<string>): string {
    const ip = allocateIp(cidr, [...used]);
    if (ip === null) throw new Error('网段内已无空闲 IP');
    return ip;
  }

  private validateIp(ip: string, cidr: ReturnType<typeof parseCidr>, used: Set<string>, serverIp: string): string {
    const value = parseIpv4(ip);
    if (value === null) throw new Error(`IP 非法: ${ip}`);
    if (!ipInCidr(ip, cidr)) throw new Error(`IP 不在网段 ${formatIpv4(cidr.network)}/${cidr.prefix} 内: ${ip}`);
    if (ip === serverIp) throw new Error(`IP 是服务器自身地址，不能分配: ${ip}`);
    if (used.has(ip)) throw new Error(`IP 已被占用: ${ip}`);
    return ip;
  }

  private resolve(peers: Peer[], target: string): Peer {
    const byName = peers.filter((peer) => peer.nickname === target);
    const byIp = peers.filter((peer) => peerIps(peer).includes(target));
    const matches = byName.length > 0 ? byName : byIp;
    if (matches.length === 0) {
      const inventory = peers.map((p) => `${p.nickname || '(无名)'} ${peerIps(p).join(',')}`).join('; ');
      throw new Error(`未找到节点: ${target}。现有节点: ${inventory || '无'}`);
    }
    if (matches.length > 1) {
      throw new Error(`节点名 "${target}" 匹配到多个 peer，请改用 IP 指定`);
    }
    return matches[0];
  }
}
