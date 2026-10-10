import os from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_DATABASE_URL,
  loadConfig,
  parseDemoLink,
  parsePublicOrigins,
} from '../../src/config.ts';

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
      // Issue #3: local mode is no demo.
      demo: null,
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

describe('loadConfig: the read-only demo (PROA_DEMO=readonly, issue #3)', () => {
  const demo = {
    PROA_WEB_DIST: '',
    PROA_DEMO: 'readonly',
    PROA_PUBLIC_ORIGIN: 'https://proa-demo.fly.dev',
  };

  it('reads the public origins, binds any host without an opt-in and runs no migrations', () => {
    const config = loadConfig({ ...demo, PROA_HOST: '0.0.0.0', PROA_PORT: '8080' });
    expect(config).toEqual({
      port: 8080,
      host: '0.0.0.0',
      databaseUrl: DEFAULT_DATABASE_URL,
      authMode: 'local',
      webDist: null,
      migrateOnStart: false,
      originPorts: [],
      sessionSecret: null,
      ownerKeyFile: null,
      allowNonLoopback: false,
      demo: { publicOrigins: ['https://proa-demo.fly.dev'] },
    });
    expect(
      loadConfig({
        ...demo,
        PROA_PUBLIC_ORIGIN:
          'https://proa.example.org, https://proa-demo.fly.dev,https://proa.example.org',
        PROA_OWNER_KEY_FILE: '',
        PROA_MIGRATE: 'off',
      }).demo,
    ).toEqual({ publicOrigins: ['https://proa.example.org', 'https://proa-demo.fly.dev'] });
    // http only on a loopback host: the demo image run locally.
    expect(
      loadConfig({
        ...demo,
        PROA_PUBLIC_ORIGIN: 'http://127.0.0.1:7480,http://localhost:7480,http://[::1]:7480',
      }).demo?.publicOrigins,
    ).toEqual(['http://127.0.0.1:7480', 'http://localhost:7480', 'http://[::1]:7480']);
  });

  it('needs the public origins, each a bare canonical https origin', () => {
    expect(() => loadConfig({ PROA_WEB_DIST: '', PROA_DEMO: 'readonly' })).toThrow(
      /PROA_PUBLIC_ORIGIN is required/,
    );
    for (const bad of [
      'http://proa-demo.fly.dev',
      'https://proa-demo.fly.dev/',
      'https://proa-demo.fly.dev/app',
      'https://proa-demo.fly.dev?x=1',
      'https://PROA-demo.fly.dev',
      'https://proa-demo.fly.dev:443',
      'proa-demo.fly.dev',
      'https://a.example,',
      'ftp://proa-demo.fly.dev',
      ' ',
    ]) {
      expect(() => loadConfig({ ...demo, PROA_PUBLIC_ORIGIN: bad }), bad).toThrow(ConfigError);
    }
    expect(parsePublicOrigins('https://a.example/,http://10.0.0.1').problems).toEqual([
      'https://a.example/: write the bare origin https://a.example (no path, no trailing slash)',
      'http://10.0.0.1: must be https (http only on a loopback host)',
    ]);
    expect(() => loadConfig({ ...demo, PROA_DEMO: 'writable' })).toThrow(/PROA_DEMO/);
  });

  it('refuses everything that would let a visitor write or act as the owner, listing all', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ PROA_OWNER_KEY_FILE: '/var/lib/proa/owner-key' }, /PROA_OWNER_KEY_FILE/],
      [{ PROA_ORIGIN_PORTS: '7400' }, /PROA_ORIGIN_PORTS/],
      [{ PROA_ALLOW_NON_LOOPBACK: '1' }, /PROA_ALLOW_NON_LOOPBACK/],
      [{ PROA_MIGRATE: 'auto' }, /PROA_MIGRATE=auto/],
    ];
    for (const [extra, message] of cases) {
      expect(() => loadConfig({ ...demo, ...extra }), JSON.stringify(extra)).toThrow(message);
    }
    expect(() => loadConfig({ ...demo, PROA_OWNER_KEY_FILE: '/k', PROA_MIGRATE: 'auto' })).toThrow(
      /PROA_OWNER_KEY_FILE[\s\S]*PROA_MIGRATE=auto/,
    );
  });

  it('reads the operator’s optional legal links, each an absolute https URL', () => {
    const imprint = 'https://example.org/impressum';
    const privacy = 'https://example.org/datenschutz/';
    expect(
      loadConfig({ ...demo, PROA_DEMO_IMPRINT_URL: imprint, PROA_DEMO_PRIVACY_URL: privacy }).demo,
    ).toEqual({
      publicOrigins: ['https://proa-demo.fly.dev'],
      imprintUrl: imprint,
      privacyUrl: privacy,
    });
    // Each one alone; unset, the demo has none (and the object no such key).
    expect(loadConfig({ ...demo, PROA_DEMO_PRIVACY_URL: privacy }).demo).toEqual({
      publicOrigins: ['https://proa-demo.fly.dev'],
      privacyUrl: privacy,
    });
    expect(Object.keys(loadConfig(demo).demo ?? {})).toEqual(['publicOrigins']);
    // Normalized as the browser would: host case, surrounding blanks, an empty path.
    expect(
      loadConfig({ ...demo, PROA_DEMO_IMPRINT_URL: ' https://Example.ORG ' }).demo?.imprintUrl,
    ).toBe('https://example.org/');
    for (const [bad, problem] of [
      ['http://example.org/impressum', /must be https/],
      ['javascript:alert(1)', /must be https/],
      ['/impressum', /not an absolute URL/],
      ['', /empty: not an absolute URL/],
      ['https://user:secret@example.org/', /must not carry a user name or password/],
      [`https://example.org/${'x'.repeat(2048)}`, /longer than 2048 characters/],
    ] as const) {
      for (const name of ['PROA_DEMO_IMPRINT_URL', 'PROA_DEMO_PRIVACY_URL']) {
        expect(() => loadConfig({ ...demo, [name]: bad }), `${name}=${bad}`).toThrow(
          new RegExp(`${name}: .*${problem.source}`),
        );
      }
    }
    expect(parseDemoLink('https://user:secret@example.org/')).toEqual({
      problem: 'example.org: must not carry a user name or password',
    });
    // Listed with every other problem of the demo configuration.
    expect(() =>
      loadConfig({
        ...demo,
        PROA_MIGRATE: 'auto',
        PROA_DEMO_IMPRINT_URL: 'http://a.example',
        PROA_DEMO_PRIVACY_URL: 'ftp://a.example',
      }),
    ).toThrow(/PROA_MIGRATE=auto[\s\S]*PROA_DEMO_IMPRINT_URL[\s\S]*PROA_DEMO_PRIVACY_URL/);
  });

  it('keeps local mode as it was: no legal links without the demo', () => {
    for (const name of ['PROA_DEMO_IMPRINT_URL', 'PROA_DEMO_PRIVACY_URL']) {
      expect(() => loadConfig({ PROA_WEB_DIST: '', [name]: 'https://example.org/' })).toThrow(
        new RegExp(`^${name} is set without PROA_DEMO=readonly`),
      );
      // Even empty: a demo setting outside the demo is a mistake worth a word.
      expect(() => loadConfig({ PROA_WEB_DIST: '', [name]: '' })).toThrow(ConfigError);
    }
    expect(() =>
      loadConfig({
        PROA_WEB_DIST: '',
        PROA_DEMO_IMPRINT_URL: 'https://example.org/i',
        PROA_DEMO_PRIVACY_URL: 'https://example.org/p',
      }),
    ).toThrow(/PROA_DEMO_IMPRINT_URL and PROA_DEMO_PRIVACY_URL are set without PROA_DEMO=readonly/);
    expect(loadConfig({ PROA_WEB_DIST: '' }).demo).toBeNull();
  });

  it('keeps local mode as it was: no public origin without the demo', () => {
    expect(() =>
      loadConfig({ PROA_WEB_DIST: '', PROA_PUBLIC_ORIGIN: 'https://proa-demo.fly.dev' }),
    ).toThrow(/only the read-only demo has a public origin/);
    expect(() =>
      loadConfig({
        PROA_WEB_DIST: '',
        PROA_HOST: '0.0.0.0',
        PROA_PUBLIC_ORIGIN: 'https://proa-demo.fly.dev',
        PROA_ALLOW_NON_LOOPBACK: '1',
      }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ PROA_WEB_DIST: '', PROA_HOST: '0.0.0.0' })).toThrow(
      /not a loopback address/,
    );
  });
});
