import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allocateIp,
  appendPeer,
  parseCidr,
  parsePeers,
  peerIps,
  removePeer,
  renderClientConfig,
  replacePeerKey,
  validateNickname,
} from '../services/wg/peers.js';

const CONF = `[Interface]
PrivateKey = cHJpdmF0ZWtleQ==
Address = 192.168.125.1/24
ListenPort = 60399

# nickname: 家里125
[Peer]
PublicKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
AllowedIPs = 192.168.125.11/32

# nickname: 手机
[Peer]
PublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
AllowedIPs = 192.168.125.12/32
`;

test('parsePeers 解析用途名、公钥与 IP', () => {
  const peers = parsePeers(CONF);
  assert.equal(peers.length, 2);
  assert.deepEqual(
    peers.map((peer) => [peer.nickname, peer.publicKey, peerIps(peer)]),
    [
      ['家里125', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', ['192.168.125.11']],
      ['手机', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=', ['192.168.125.12']],
    ],
  );
});

test('appendPeer 只追加，removePeer 可还原', () => {
  const appended = appendPeer(CONF, '工作笔记本', 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=', '192.168.125.13');
  assert.ok(appended.startsWith(CONF.trimEnd()));
  const peers = parsePeers(appended);
  assert.equal(peers.length, 3);
  assert.equal(peers[2].nickname, '工作笔记本');
  assert.deepEqual(peerIps(peers[2]), ['192.168.125.13']);

  const restored = removePeer(appended, peers[2]);
  assert.equal(restored, `${CONF.trimEnd()}\n`);
});

test('removePeer 删除首个 peer 不影响其余 peer', () => {
  const peers = parsePeers(CONF);
  const result = removePeer(CONF, peers[0]);
  const remaining = parsePeers(result);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].nickname, '手机');
  assert.match(result, /^\[Interface\]/);
});

test('replacePeerKey 只改目标 peer 的公钥行', () => {
  const peers = parsePeers(CONF);
  const replaced = replacePeerKey(CONF, peers[1], 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=');
  assert.match(replaced, /PublicKey = DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=/);
  assert.match(replaced, /PublicKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=/);
  assert.equal(parsePeers(replaced)[1].publicKey, 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=');
});

test('allocateIp 跳过服务器与已占用地址', () => {
  const cidr = parseCidr('192.168.125.0/24');
  assert.equal(allocateIp(cidr, ['192.168.125.1', '192.168.125.2']), '192.168.125.3');
  assert.equal(allocateIp(cidr, ['192.168.125.1', '192.168.125.11']), '192.168.125.2');
});

test('allocateIp 不越界到广播地址', () => {
  const cidr = parseCidr('10.0.0.0/29');
  const reserved = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6'];
  assert.equal(allocateIp(cidr, reserved), null);
  assert.equal(allocateIp(cidr, ['10.0.0.1']), '10.0.0.2');
});

test('validateNickname 拒绝空白与 #', () => {
  assert.equal(validateNickname(' 工作笔记本 '), '工作笔记本');
  assert.throws(() => validateNickname('a b'), /不合法/);
  assert.throws(() => validateNickname('a#b'), /不合法/);
  assert.throws(() => validateNickname('x'.repeat(41)), /不合法/);
});

test('renderClientConfig 按 DNS 配置决定是否写 resolvectl hook', () => {
  const base = {
    privateKey: 'cHJpdmF0ZWtleQ==',
    ip: '192.168.125.14',
    subnet: '192.168.125.0/24',
    serverPublicKey: 'SRVKEY=',
    endpoint: 'tutu.gold:60399',
    dnsDomain: '~tu',
    interface: 'wg0',
  };
  const withDns = renderClientConfig({ ...base, dns: '192.168.125.1' });
  assert.match(withDns, /^Address = 192\.168\.125\.14\/24$/m);
  assert.match(withDns, /PostUp = resolvectl dns wg0 192\.168\.125\.1; resolvectl domain wg0 '~tu'/);
  assert.match(withDns, /AllowedIPs = 192\.168\.125\.0\/24/);

  const withoutDns = renderClientConfig({ ...base, dns: null });
  assert.doesNotMatch(withoutDns, /PostUp|PreDown/);
});
