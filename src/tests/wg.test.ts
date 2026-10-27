import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from '../lib/log.js';
import { WgDashboard } from '../services/wg/dashboard.js';
import type { WgConfig } from '../services/wg/config.js';

const noopLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const WG: WgConfig = {
  dashboard: { url: 'http://192.168.125.1:10086/', api_key: 'test-key' },
  configuration: 'wg0',
  endpoint: 'tutu.gold:60399',
  dns_domain: '~tu',
};

interface Call {
  url: string;
  method: string;
  apiKey: string | undefined;
  body: string | undefined;
}

type Reply = { status?: number; body: unknown };

function fakeFetch(replies: Reply[]): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      apiKey: (init?.headers as Record<string, string> | undefined)?.['wg-dashboard-apikey'],
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request: ${String(input)}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function info(peers: unknown[] = [], restricted: unknown[] = []): Reply {
  return {
    body: {
      status: true,
      message: null,
      data: {
        configurationInfo: {
          Name: 'wg0',
          Address: '192.168.125.1/24',
          ListenPort: '60399',
          PublicKey: 'SERVERKEY=',
        },
        configurationPeers: peers,
        configurationRestrictedPeers: restricted,
      },
    },
  };
}

function peer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'PUB1=',
    name: '手机',
    allowed_ip: '192.168.125.20/32',
    DNS: '192.168.125.1',
    keepalive: 21,
    mtu: 1420,
    endpoint: '1.2.3.4:5',
    latest_handshake: '0:00:42',
    status: 'running',
    private_key: 'PRIVATE1=',
    ...overrides,
  };
}

test('snapshot 映射节点字段与服务器配置', async () => {
  const { impl } = fakeFetch([info([peer()], [peer({ id: 'P2=', name: '受限', allowed_ip: '192.168.125.21/32' })])]);
  const wg = new WgDashboard(WG, noopLog, impl);
  const snapshot = await wg.snapshot();
  assert.equal(snapshot.configuration.publicKey, 'SERVERKEY=');
  assert.equal(snapshot.configuration.listenPort, 60399);
  assert.equal(snapshot.peers.length, 2);
  assert.deepEqual(
    snapshot.peers.map((p) => [p.ip, p.name, p.restricted, p.status]),
    [
      ['192.168.125.20', '手机', false, 'running'],
      ['192.168.125.21', '受限', true, 'running'],
    ],
  );
});

test('issue 指定 IP：传给面板并在返回中渲染客户端配置', async () => {
  const { impl, calls } = fakeFetch([
    info([]),
    { body: { status: true, message: null, data: [peer({ private_key: 'PRIVATE1=' })] } },
    info([peer()]),
  ]);
  const wg = new WgDashboard(WG, noopLog, impl);
  const issued = await wg.issue('手机', '192.168.125.20');

  assert.equal(issued.ip, '192.168.125.20');
  assert.equal(issued.privateKey, 'PRIVATE1=');
  assert.equal(calls[1].url, 'http://192.168.125.1:10086/api/addPeers/wg0');
  assert.equal(calls[1].apiKey, 'test-key');
  assert.deepEqual(JSON.parse(calls[1].body ?? '{}'), {
    name: '手机',
    notes: '',
    allowed_ips: ['192.168.125.20/32'],
  });

  assert.match(issued.clientConfig, /PrivateKey = PRIVATE1=/);
  assert.match(issued.clientConfig, /^Address = 192\.168\.125\.20\/24$/m);
  assert.match(issued.clientConfig, /^PublicKey = SERVERKEY=$/m);
  assert.match(issued.clientConfig, /^Endpoint = tutu\.gold:60399$/m);
  assert.match(issued.clientConfig, /^AllowedIPs = 192\.168\.125\.0\/24$/m);
  assert.match(issued.clientConfig, /resolvectl dns wg0 192\.168\.125\.1; resolvectl domain wg0 '~tu'/);
  assert.match(issued.clientConfig, /^PersistentKeepalive = 21$/m);
});

test('issue 省略 IP 时交给面板自动分配', async () => {
  const { impl, calls } = fakeFetch([
    info([]),
    { body: { status: true, message: null, data: [peer({ allowed_ip: '192.168.125.30/32' })] } },
    info([peer({ allowed_ip: '192.168.125.30/32' })]),
  ]);
  const wg = new WgDashboard(WG, noopLog, impl);
  const issued = await wg.issue('新设备');
  assert.equal(issued.ip, '192.168.125.30');
  assert.deepEqual(JSON.parse(calls[1].body ?? '{}'), { name: '新设备', notes: '' });
});

test('issue 拒绝占用/服务器/越界 IP', async () => {
  const cases = [
    { ip: '192.168.125.20', message: /已被占用/ },
    { ip: '192.168.125.1', message: /服务器自身地址/ },
    { ip: '10.0.0.5', message: /不在网段/ },
    { ip: 'abc', message: /IP 非法/ },
  ];
  for (const item of cases) {
    const { impl, calls } = fakeFetch([info([peer()])]);
    const wg = new WgDashboard(WG, noopLog, impl);
    await assert.rejects(() => wg.issue('x', item.ip), item.message);
    assert.equal(calls.length, 1, '校验失败时不应调用 addPeers');
  }
});

test('remove 支持按名字与 IP 定位', async () => {
  for (const target of ['手机', '192.168.125.20']) {
    const { impl, calls } = fakeFetch([
      info([peer()]),
      { body: { status: true, message: null, data: null } },
    ]);
    const wg = new WgDashboard(WG, noopLog, impl);
    const removed = await wg.remove(target);
    assert.equal(removed.ip, '192.168.125.20');
    assert.equal(calls[1].url, 'http://192.168.125.1:10086/api/deletePeers/wg0');
    assert.deepEqual(JSON.parse(calls[1].body ?? '{}'), { peers: ['PUB1='] });
  }
});

test('remove 名字重复时必须改用 IP', async () => {
  const dup = peer({ id: 'P2=', allowed_ip: '192.168.125.21/32' });
  const { impl } = fakeFetch([info([peer(), dup])]);
  const wg = new WgDashboard(WG, noopLog, impl);
  await assert.rejects(() => wg.remove('手机'), /匹配到多个节点/);
});

test('rotate 删除后用同名同 IP 重建并返回新私钥', async () => {
  const { impl, calls } = fakeFetch([
    info([peer()]),
    { body: { status: true, message: null, data: null } },
    {
      body: {
        status: true,
        message: null,
        data: [peer({ id: 'PUB2=', private_key: 'PRIVATE2=' })],
      },
    },
    info([peer({ id: 'PUB2=', private_key: 'PRIVATE2=' })]),
  ]);
  const wg = new WgDashboard(WG, noopLog, impl);
  const issued = await wg.rotate('192.168.125.20');
  assert.equal(issued.privateKey, 'PRIVATE2=');
  assert.match(issued.clientConfig, /PrivateKey = PRIVATE2=/);
  assert.equal(calls[1].url, 'http://192.168.125.1:10086/api/deletePeers/wg0');
  assert.deepEqual(JSON.parse(calls[2].body ?? '{}'), {
    name: '手机',
    allowed_ips: ['192.168.125.20/32'],
    notes: '',
  });
});

test('status 在面板报错或不可达时给出原因', async () => {
  const denied = fakeFetch([
    { status: 401, body: { status: false, message: 'Unauthorized access.', data: null } },
  ]);
  const wg1 = new WgDashboard(WG, noopLog, denied.impl);
  const s1 = await wg1.status();
  assert.equal(s1.available, false);
  assert.match(s1.reason ?? '', /Unauthorized access/);

  const offline = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as typeof fetch;
  const wg2 = new WgDashboard(WG, noopLog, offline);
  const s2 = await wg2.status();
  assert.equal(s2.available, false);
  assert.match(s2.reason ?? '', /ECONNREFUSED/);
});

test('未配置 wg 段时状态为不可用且操作被拒绝', async () => {
  const wg = new WgDashboard(null, noopLog, fetch);
  const status = await wg.status();
  assert.equal(status.available, false);
  assert.match(status.reason ?? '', /未配置 wg 段/);
  await assert.rejects(() => wg.snapshot(), /未配置 wg 段/);
});

test('assertIpAvailable 只读校验不创建节点', async () => {
  const { impl, calls } = fakeFetch([info([])]);
  const wg = new WgDashboard(WG, noopLog, impl);
  await wg.assertIpAvailable('192.168.125.40');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /getWireguardConfigurationInfo/);
});
