import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Logger } from '../lib/log.js';
import { Mutex } from '../lib/mutex.js';
import { WgManager } from '../services/wg/manager.js';
import type { WgConfig } from '../services/wg/config.js';

const noopLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const CONFIG: WgConfig = {
  config: '',
  interface: 'wg0',
  subnet: '192.168.125.0/24',
  server_ip: '192.168.125.1',
  server_public_key: 'Aw+eKGt/x+WmRLBvfX5fzHQLxtsuxDWhxIhYiZXbLxM=',
  endpoint: 'tutu.gold:60399',
  dns: '192.168.125.1',
  dns_domain: '~tu',
};

function managerWith(content: string): WgManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutu-wg-test-'));
  const file = path.join(dir, 'wg0.conf');
  fs.writeFileSync(file, content, { mode: 0o600 });
  return new WgManager({ ...CONFIG, config: file }, noopLog, new Mutex());
}

test('未配置 wg 段时报告不可用', () => {
  const manager = new WgManager(null, noopLog, new Mutex());
  const status = manager.status();
  assert.equal(status.available, false);
  assert.match(status.reason ?? '', /未配置 wg 段/);
});

test('拒绝把客户端配置当服务器配置（角色防护）', () => {
  const manager = managerWith('[Interface]\nPrivateKey = k\nAddress = 192.168.125.11/24\n');
  const status = manager.status();
  assert.equal(status.available, false);
  assert.match(status.reason ?? '', /不是服务器地址 192\.168\.125\.1/);
});

test('配置文件缺失时报告不可读写', () => {
  const manager = new WgManager(
    { ...CONFIG, config: path.join(os.tmpdir(), 'tutu-missing-dir', 'wg0.conf') },
    noopLog,
    new Mutex(),
  );
  assert.match(manager.status().reason ?? '', /不可读写/);
});
