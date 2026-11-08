// Guards for the paid Claude key: one wrapper, a ledger, a hard cap. No network calls are made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI, PRICES, MODEL } from '../server/claude.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(m?js|html)$/.test(e.name) ? [p] : [];
  });
}

test('only server/claude.mjs talks to the Claude API', () => {
  const offenders = [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'web')), ...walk(path.join(ROOT, 'shared'))]
    .filter(f => !f.endsWith(path.join('server', 'claude.mjs')))
    .filter(f => /@anthropic-ai\/sdk|api\.anthropic\.com/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

function fakeApp(capUsd = 5) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ai-'));
  return { dataDir, config: { ai: { capUsd } }, state: {}, changed() { } };
}

test('no key: refuses before any network call', async () => {
  const ai = new AI(fakeApp());
  await assert.rejects(() => ai.askSanta({ question: 'hi' }), /API key/);
});

test('monthly cap is enforced from the ledger', async () => {
  const app = fakeApp(1);
  const ai = new AI(app);
  fs.writeFileSync(path.join(app.dataDir, 'secrets.json'), JSON.stringify({ anthropicKey: 'sk-ant-test-0000000000000000000000' }));
  fs.writeFileSync(ai.ledger, JSON.stringify({ time: new Date().toISOString(), feature: 'x', ok: true, cost: 1.2 }) + '\n');
  await assert.rejects(() => ai.askSanta({ question: 'hi' }), /budget/);
  assert.equal(ai.usage().month, 1.2);
});

test('cost comes from the dated price table', () => {
  const ai = new AI(fakeApp());
  const p = PRICES[MODEL];
  assert.ok(PRICES.date);
  assert.equal(+ai.cost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }).toFixed(6), +(p.input + p.output).toFixed(6));
});

test('key format is checked and never echoed into state', () => {
  const app = fakeApp();
  const ai = new AI(app);
  assert.throws(() => ai.setKey('hello'), /sk-ant-/);
  ai.setKey('sk-ant-test-0000000000000000000000');
  assert.equal(app.state.ai.configured, true);
  assert.ok(!JSON.stringify(app.state).includes('sk-ant'));
});
