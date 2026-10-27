import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { AuthStore, hashToken } from '../lib/auth.js';
import { migrate } from '../lib/db.js';

const MASTER = 'master-'.repeat(6);

function store(): { auth: AuthStore; db: Database.Database } {
  const db = new Database(':memory:');
  migrate(db);
  return { auth: new AuthStore(db, MASTER), db };
}

test('master 令牌解析为 master 角色', () => {
  const { auth } = store();
  assert.deepEqual(auth.resolve(MASTER), { role: 'master', host: null });
  assert.equal(auth.resolve(`${MASTER}x`), null);
  assert.equal(auth.resolve(''), null);
});

test('host 令牌只落摘要，可解析到主机名', () => {
  const { auth, db } = store();
  const token = auth.issueHost('work', '192.168.125.20');
  assert.deepEqual(auth.resolve(token), { role: 'host', host: 'work' });

  const row = db.prepare('SELECT token_hash FROM hosts WHERE name = ?').get('work') as {
    token_hash: string;
  };
  assert.equal(row.token_hash, hashToken(token));
  assert.notEqual(row.token_hash, token);
});

test('同名主机重注册会轮换令牌', () => {
  const { auth } = store();
  const first = auth.issueHost('work', null);
  const second = auth.issueHost('work', null);
  assert.equal(auth.resolve(first), null);
  assert.deepEqual(auth.resolve(second), { role: 'host', host: 'work' });
  assert.equal(auth.listHosts().length, 1);
});

test('注册码只能兑换一次', () => {
  const { auth } = store();
  const token = auth.createEnrollment('phone', '192.168.125.21', 60_000);
  assert.deepEqual(auth.consumeEnrollment(token), { hostName: 'phone', wgIp: '192.168.125.21' });
  assert.equal(auth.consumeEnrollment(token), null);
});

test('过期注册码拒绝兑换', () => {
  const { auth } = store();
  const token = auth.createEnrollment('phone', null, -1);
  assert.equal(auth.consumeEnrollment(token), null);
});

test('吊销主机后令牌立即失效', () => {
  const { auth } = store();
  const token = auth.issueHost('tmp', '192.168.125.22');
  const revoked = auth.revokeHost('tmp');
  assert.equal(revoked?.wg_ip, '192.168.125.22');
  assert.equal(auth.resolve(token), null);
  assert.equal(auth.revokeHost('tmp'), null);
});

test('master 令牌过短时拒绝构造', () => {
  const db = new Database(':memory:');
  migrate(db);
  assert.throws(() => new AuthStore(db, 'short'), /至少 32 字符/);
});
