import os from 'node:os';

import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULT_DATABASE_URL, loadConfig } from '../../src/config.ts';

describe('loadConfig', () => {
  it('defaults to local mode on 127.0.0.1:7400 and the Compose database', () => {
    const config = loadConfig({ PROA_WEB_DIST: '' });
    expect(config).toEqual({
      port: 7400,
      host: '127.0.0.1',
      databaseUrl: DEFAULT_DATABASE_URL,
      authMode: 'local',
      webDist: null,
      migrateOnStart: true,
      originPorts: [7400, 7401],
      sessionSecret: null,
      ownerKeyFile: `${os.homedir()}/.local/state/proa/owner-key`,
      allowNonLoopback: false,
    });
  });

  it('reads the owner key file (XDG default, explicit path, or none)', () => {
    expect(loadConfig({ PROA_WEB_DIST: '', XDG_STATE_HOME: '/var/state' }).ownerKeyFile).toBe(
      '/var/state/proa/owner-key',
    );
    expect(
      loadConfig({ PROA_WEB_DIST: '', PROA_OWNER_KEY_FILE: '/run/proa/key' }).ownerKeyFile,
    ).toBe('/run/proa/key');
    expect(loadConfig({ PROA_WEB_DIST: '', PROA_OWNER_KEY_FILE: '' }).ownerKeyFile).toBeNull();
  });

  it('reads origin ports and the session secret', () => {
    const config = loadConfig({
      PROA_WEB_DIST: '',
      PROA_PORT: '8000',
      PROA_ORIGIN_PORTS: '8000, 9000',
      PROA_SESSION_SECRET: 'x'.repeat(32),
    });
    expect(config.originPorts).toEqual([8000, 9000]);
    expect(config.sessionSecret).toBe('x'.repeat(32));
    expect(loadConfig({ PROA_WEB_DIST: '', PROA_PORT: '8000' }).originPorts).toEqual([8000, 7401]);
    expect(() => loadConfig({ PROA_ORIGIN_PORTS: 'a,b' })).toThrow(ConfigError);
    expect(() => loadConfig({ PROA_SESSION_SECRET: 'short' })).toThrow(ConfigError);
  });

  it('reads the environment', () => {
    const config = loadConfig({
      PROA_PORT: '7999',
      PROA_HOST: '0.0.0.0',
      PROA_ALLOW_NON_LOOPBACK: '1',
      DATABASE_URL: 'postgresql://u:p@db:5432/x',
      PROA_WEB_DIST: '/srv/web',
      PROA_MIGRATE: 'off',
    });
    expect(config).toMatchObject({
      port: 7999,
      host: '0.0.0.0',
      allowNonLoopback: true,
      databaseUrl: 'postgresql://u:p@db:5432/x',
      webDist: '/srv/web',
      migrateOnStart: false,
    });
  });

  it('binds loopback only in local mode unless PROA_ALLOW_NON_LOOPBACK=1', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(loadConfig({ PROA_WEB_DIST: '', PROA_HOST: host }).host, host).toBe(host);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'proa.local', '128.0.0.1']) {
      expect(() => loadConfig({ PROA_WEB_DIST: '', PROA_HOST: host }), host).toThrow(
        /not a loopback address.*\n.*owner session[\s\S]*PROA_ALLOW_NON_LOOPBACK=1/,
      );
      expect(
        loadConfig({ PROA_WEB_DIST: '', PROA_HOST: host, PROA_ALLOW_NON_LOOPBACK: '1' }).host,
      ).toBe(host);
    }
    expect(() => loadConfig({ PROA_ALLOW_NON_LOOPBACK: 'yes' })).toThrow(ConfigError);
  });

  it('rejects invalid values with every problem listed', () => {
    expect(() =>
      loadConfig({ PROA_PORT: 'x', DATABASE_URL: 'mysql://a/b', PROA_AUTH: 'oidc' }),
    ).toThrow(ConfigError);
    try {
      loadConfig({ PROA_PORT: '70000', DATABASE_URL: 'nope' });
    } catch (err) {
      expect(String(err)).toMatch(/PROA_PORT/);
      expect(String(err)).toMatch(/DATABASE_URL/);
    }
  });
});
