import assert from 'node:assert/strict';
import { test } from 'node:test';
import { funnelState } from '../src/expose.ts';

const web = (handlers: Record<string, { Proxy?: string }>, funnel = true) => ({
  TCP: { '443': { HTTPS: true } },
  Web: { 'box.tailnet.ts.net:443': { Handlers: handlers } },
  AllowFunnel: funnel ? { 'box.tailnet.ts.net:443': true } : undefined
});

test('nothing configured → free to take :443', () => {
  assert.deepEqual(funnelState({}, 8808), { kind: 'free' });
  assert.deepEqual(funnelState({ Web: { 'box.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }, 8808), { kind: 'free' });
});

test('our own proxy is recognised, public or tailnet-only', () => {
  assert.deepEqual(funnelState(web({ '/': { Proxy: 'http://127.0.0.1:8808' } }), 8808), { kind: 'ours', public: true });
  assert.deepEqual(funnelState(web({ '/': { Proxy: 'http://127.0.0.1:8808' } }, false), 8808), { kind: 'ours', public: false });
});

test("someone else's :443 handlers are never clobbered", () => {
  assert.equal(funnelState(web({ '/': { Proxy: 'http://127.0.0.1:3000' } }), 8808).kind, 'taken');
  assert.equal(funnelState(web({ '/': { Proxy: 'http://127.0.0.1:8808' }, '/app': { Proxy: 'http://127.0.0.1:3000' } }), 8808).kind, 'taken');
  assert.equal(funnelState(web({ '/': {} }), 8808).kind, 'taken');
});
