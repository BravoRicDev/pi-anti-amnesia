import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// TypeScript and typebox live outside the repo (Pi installation, global).
// Resolving them with createRequire over several roots avoids hardcoding absolute
// paths in the test: the same file runs on different machines unchanged.
const require = createRequire(import.meta.url);

function resolveFrom(roots, name) {
  for (const root of roots) {
    try {
      return require.resolve(name, { paths: [root] });
    } catch { /* try the next root */ }
  }
  return null;
}

const searchRoots = [
  path.resolve(import.meta.dirname, '..'),
  path.resolve(import.meta.dirname, '..', '..'),
  process.env.PI_CODING_AGENT ?? '',
  // TypeScript may live in a global npm tree, in a harness separate
  // from the same Pi installation, or in ~/.pi/agent/npm. If we only search
  // under the Pi installation, the test does not start on machines where the two
  // trees are separate.
  path.join(process.env.HOME ?? '', '.hermes', 'hermes-agent', 'node_modules'),
  path.join(process.env.HOME ?? '', '.hermes', 'node', 'lib', 'node_modules'),
  path.join(process.env.HOME ?? '', '.pi', 'agent', 'npm', 'node_modules'),
  path.join(process.env.HOME ?? '', '.local', 'lib', 'node_modules'),
].filter(Boolean);

const tsPath = resolveFrom(searchRoots, 'typescript');
if (!tsPath) {
  throw new Error(
    'TypeScript not found. Set PI_CODING_AGENT=/path/to/pi-coding-agent, ' +
    'or install typescript where node can find it. Extend searchRoots in this file.',
  );
}
const ts = (await import(pathToFileURL(tsPath).href)).default;

// typebox is imported by the transpiled extension: resolved as an absolute URL.
const typeboxPath = resolveFrom(searchRoots, 'typebox');
const typeboxUrl = typeboxPath ? pathToFileURL(typeboxPath).href : null;

// Run the REAL extension in a disposable HOME. No LLM, external service or real card is touched.
const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');

async function harness() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-amnesia-test-'));
  const home = process.env.HOME;
  process.env.HOME = temp;
  try {
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
      .replace("from 'typebox'", typeboxUrl ? `from ${JSON.stringify(typeboxUrl)}` : "from 'typebox'");
    fs.writeFileSync(path.join(temp, 'index.mjs'), js);
    fs.copyFileSync(path.join(root, 'topic-scope.mjs'), path.join(temp, 'topic-scope.mjs'));
    // The extension resolves i18n as a sibling module: without these files in the
    // temporary dir the session does not start and every test dies on helperUnreadable.
    fs.copyFileSync(path.join(root, 'i18n.mjs'), path.join(temp, 'i18n.mjs'));
    fs.cpSync(path.join(root, 'i18n'), path.join(temp, 'i18n'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'config.json'), fs.readFileSync(path.join(root, 'config.json')));
    const handlers = new Map();
    const tools = new Map();
    const commands = new Map();
    const messages = [];
    const notifications = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      sendMessage(message) { messages.push(message); },
    };
    const { default: extension } = await import(pathToFileURL(path.join(temp, 'index.mjs')).href);
    extension(pi);
    const ctx = {
      cwd: temp, hasUI: false, ui: { notify(...args) { notifications.push(args); } }, sessionManager: { getSessionId: () => 'test-session-uuid' },
    };
    await handlers.get('session_start')({ reason: 'startup' }, ctx);
    return { temp, home, handlers, tools, commands, messages, notifications, ctx };
  } catch (error) {
    process.env.HOME = home;
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function cleanup(h) {
  process.env.HOME = h.home;
  fs.rmSync(h.temp, { recursive: true, force: true });
}

const card = '## Sempre valido\nRuolo dev.\n## Lavoro attivo\nRiparare API pagamenti; prossimo test invoice.\n## Topic: crm\nVecchia campagna CRM.';

// These tests deliberately run serially because HOME is process-global.
test('simultaneous periodic and random review inject the card once without nested labels', async () => {
  const previousRandom = Math.random;
  Math.random = () => 0;
  let h;
  try {
    h = await harness();
    await h.tools.get('memory_card').execute('id', { text: card, everyTurns: 1 }, undefined, undefined, h.ctx);
    await h.handlers.get('turn_end')();
    const response = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    const text = response.messages.at(-1).content;
    assert.match(text, /RIVEDI CARTA/);
    assert.equal(text.match(/Riparare API pagamenti/g)?.length, 1);
    assert.equal(text.match(/\[ANTI-AMNESIA ·/g)?.length, 1);
  } finally { Math.random = previousRandom; if (h) cleanup(h); }
});

test('archived topics require the current turn prompt, never a historical user message', async () => {
  const h = await harness();
  try {
    await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    await h.handlers.get('session_start')({ reason: 'resume' }, h.ctx);
    const historical = [{ role: 'user', content: 'CRM' }, { role: 'assistant', content: 'Vecchia risposta' }];
    const resumed = await h.handlers.get('context')({ messages: historical });
    assert.doesNotMatch(resumed.messages.at(-1).content, /Vecchia campagna CRM/);
    await h.handlers.get('before_agent_start')({ prompt: 'CRM', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    await h.commands.get('card').handler('now', h.ctx);
    const current = await h.handlers.get('context')({ messages: historical });
    assert.match(current.messages.at(-1).content, /Vecchia campagna CRM/);
    await h.handlers.get('agent_settled')();
    await h.commands.get('card').handler('now', h.ctx);
    const settled = await h.handlers.get('context')({ messages: historical });
    assert.doesNotMatch(settled.messages.at(-1).content, /Vecchia campagna CRM/);
    await h.handlers.get('before_agent_start')({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    await h.commands.get('card').handler('now', h.ctx);
    const unrelated = await h.handlers.get('context')({ messages: historical });
    assert.doesNotMatch(unrelated.messages.at(-1).content, /Vecchia campagna CRM/);
  } finally { cleanup(h); }
});

test('interval validation rejects ineffective values and rearms random review', async () => {
  const h = await harness();
  try {
    const tool = h.tools.get('memory_card');
    const invalid = await tool.execute('id', { text: card, everyTurns: 1001 }, undefined, undefined, h.ctx);
    assert.equal(invalid.details.error, 'invalid-interval');
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md')), false);
    await tool.execute('id', { text: card }, undefined, undefined, h.ctx);
    await h.commands.get('card').handler('every 1001', h.ctx);
    assert.match(h.notifications.at(-1)[0], /N fra 1 e 1000/);
    await h.commands.get('card').handler('every 1', h.ctx);
    await h.handlers.get('turn_end')();
    await h.handlers.get('turn_end')();
    const refresh = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(refresh.messages.at(-1).content, /RIVEDI CARTA/);
  } finally { cleanup(h); }
});

test('bootstrap retries replace earlier persisted bootstrap prompts instead of accumulating', async () => {
  const h = await harness();
  try {
    await h.handlers.get('before_agent_start')({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    const old = { role: 'custom', customType: 'anti-amnesia-bootstrap', content: 'OLD BOOTSTRAP' };
    const recent = { ...old, content: 'RECENT BOOTSTRAP' };
    const input = [{ role: 'user', content: 'continua' }, old, recent];
    const cleaned = await h.handlers.get('context')({ messages: input });
    assert.deepEqual(cleaned.messages, [input[0], recent]);
    for (let i = 0; i < 15; i++) await h.handlers.get('turn_end')();
    const retry = await h.handlers.get('context')({ messages: input });
    assert.equal(retry.messages.filter((m) => m.customType === 'anti-amnesia-bootstrap').length, 1);
    assert.doesNotMatch(JSON.stringify(retry.messages), /OLD BOOTSTRAP|RECENT BOOTSTRAP/);
  } finally { cleanup(h); }
});

test('a busy registry lock fails explicitly without replacing another writer', async () => {
  const h = await harness();
  try {
    const lockPath = path.join(h.temp, '.pi/anti-amnesia/registry.json.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // The lock must belong to a LIVE process: a dead pid is an orphan stall, and
    // since the stale-lock fix it gets broken instead of blocking persistence
    // forever. This process's own pid is alive by construction.
    const live = `${process.pid}\n`;
    fs.writeFileSync(lockPath, live);
    const blocked = await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    assert.equal(blocked.details.error, 'registry-failed');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), live);
    fs.unlinkSync(lockPath);
    const retried = await h.tools.get('memory_card').execute('retry', { text: card }, undefined, undefined, h.ctx);
    assert.equal(retried.details.ok, true);
  } finally { cleanup(h); }
});

test('a stale lock from a dead process is broken instead of blocking forever', async () => {
  const h = await harness();
  try {
    const lockPath = path.join(h.temp, '.pi/anti-amnesia/registry.json.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Non-existent pid: the old behaviour left the lock there forever,
    // disabling registry persistence with no recovery.
    fs.writeFileSync(lockPath, '999999\n');
    const wrote = await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    assert.equal(wrote.details.ok, true, 'an orphan stall must not prevent writing');
    assert.equal(fs.existsSync(lockPath), false, 'the stale lock must be removed');
  } finally { cleanup(h); }
});

test('concurrent processes preserve both session entries in the registry', async () => {
  const h = await harness();
  try {
    const workerPath = path.join(h.temp, 'registry-worker.mjs');
    fs.writeFileSync(workerPath, `import extension from './index.mjs';
const handlers = new Map(); let tool;
const pi = { on: (name, fn) => handlers.set(name, fn), registerTool: (entry) => { if (entry.name === 'memory_card') tool = entry; }, registerCommand() {} };
extension(pi);
const ctx = { cwd: process.env.HOME, hasUI: false, sessionManager: { getSessionId: () => process.argv[2] } };
await handlers.get('session_start')({ reason: 'startup' }, ctx);
for (let i = 0; i < 8; i++) {
  const result = await tool.execute('id', { text: '## Lavoro attivo\\nTask ' + process.argv[2] + ' #' + i }, undefined, undefined, ctx);
  if (!result.details.ok) throw new Error(JSON.stringify(result.details));
}`);
    const launch = (id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, id], { env: { ...process.env, HOME: h.temp } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${id}: ${stderr}`)));
    });
    await Promise.all([launch('session-one'), launch('session-two')]);
    const registry = JSON.parse(fs.readFileSync(path.join(h.temp, '.pi/anti-amnesia/registry.json'), 'utf8'));
    assert.ok(registry.cards['session-one']);
    assert.ok(registry.cards['session-two']);
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/registry.json.lock')), false);
  } finally { cleanup(h); }
});

test('first prompt bootstraps, a saved card survives short prompts and an immediate compaction retry', async () => {
  const h = await harness();
  try {
    const before = h.handlers.get('before_agent_start');
    const context = h.handlers.get('context');
    const first = await before({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    assert.match(first.message.content, /BOOTSTRAP/);
    const saved = await h.tools.get('memory_card').execute('id', { text: card, role: 'dev' }, undefined, undefined, h.ctx);
    assert.equal(saved.details.ok, true);
    assert.equal(h.messages.length, 0);
    const input = [{ role: 'user', content: 'continua' }];
    const next = await context({ messages: input });
    assert.equal(next, undefined); // no scheduled reminder yet
    await h.handlers.get('session_compact')({ reason: 'overflow' }, h.ctx);
    const retry = await context({ messages: input });
    assert.match(retry.messages.at(-1).content, /Riparare API pagamenti/);
    assert.doesNotMatch(retry.messages.at(-1).content, /Vecchia campagna CRM/);
    assert.equal(h.messages.length, 0); // no delayed nextTurn injection
    assert.equal(await context({ messages: input }), undefined); // one shot
  } finally { cleanup(h); }
});

test('checkpoint update replaces only current work and preserves archived notes', async () => {
  const h = await harness();
  try {
    const tool = h.tools.get('memory_card');
    assert.equal((await tool.execute('a', { text: card }, undefined, undefined, h.ctx)).details.ok, true);
    const updated = await tool.execute('b', { activeWork: 'Obiettivo: pagamenti; test refund ora.' }, undefined, undefined, h.ctx);
    assert.equal(updated.details.ok, true);
    const saved = fs.readFileSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md'), 'utf8');
    assert.match(saved, /test refund ora/);
    assert.doesNotMatch(saved, /prossimo test invoice/);
    assert.match(saved, /Vecchia campagna CRM/);
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md.tmp')), false);
  } finally { cleanup(h); }
});

test('a resumed card is delivered on the very first autonomous LLM call', async () => {
  const h = await harness();
  try {
    await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    await h.handlers.get('session_start')({ reason: 'resume' }, h.ctx);
    const first = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(first.messages.at(-1).content, /ripresa sessione/);
    assert.match(first.messages.at(-1).content, /prossimo test invoice/);
    assert.doesNotMatch(first.messages.at(-1).content, /Vecchia campagna CRM/);
    assert.equal(await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] }), undefined);
  } finally { cleanup(h); }
});

test('reload refreshes the ESM helper rather than keeping a stale cached copy', async () => {
  const h = await harness();
  try {
    const helper = path.join(h.temp, 'topic-scope.mjs');
    await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    const old = fs.readFileSync(helper, 'utf8');
    // The probe targets the TAIL of the permanent-section list, not the whole line: the list
    // grew when the objective, plan and todo blocks were added, and a probe pinned to the old
    // one-line form breaks for a reason that has nothing to do with the helper being re-read.
    assert.match(old, /\.\.\.scope\.todo,/);
    fs.writeFileSync(helper, old.replace(
      '...scope.todo,',
      "...scope.todo, 'HELPER UPDATED',",
    ));
    await h.handlers.get('session_start')({ reason: 'reload' }, h.ctx);
    const fresh = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(fresh.messages.at(-1).content, /HELPER UPDATED/);
  } finally { cleanup(h); }
});

test('missing card retries bootstrap instead of silently disabling recovery', async () => {
  const h = await harness();
  try {
    const before = h.handlers.get('before_agent_start');
    const options = { prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } };
    assert.match((await before(options)).message.content, /BOOTSTRAP/);
    assert.equal(await before(options), undefined);
    for (let i = 0; i < 15; i++) await h.handlers.get('turn_end')();
    const autonomous = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(autonomous.messages.at(-1).content, /BOOTSTRAP/);
    assert.equal(await before(options), undefined); // no duplicate on the next model request
  } finally { cleanup(h); }
});

test('regenerate archives old card and resume cannot resurrect it', async () => {
  const h = await harness();
  try {
    const file = path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md');
    await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    await h.commands.get('card').handler('regenerate', h.ctx);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), card);
    await h.handlers.get('session_start')({ reason: 'resume' }, h.ctx);
    const boot = await h.handlers.get('before_agent_start')({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    assert.match(boot.message.content, /BOOTSTRAP/);
    const old = { role: 'custom', customType: 'anti-amnesia', content: 'OLD WRONG TASK' };
    const context = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'nuovo compito' }, old] });
    assert.deepEqual(context.messages, [{ role: 'user', content: 'nuovo compito' }]);
  } finally { cleanup(h); }
});

test('explicit shared draft never enters model as active memory', async () => {
  const h = await harness();
  try {
    const draftPath = path.join(h.temp, 'PiAgent/prompts/carta-anti-amnesia.md');
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, 'BOZZA DA PERSONALIZZARE');
    await h.commands.get('card').handler('bootstrap', h.ctx);
    const first = await h.handlers.get('before_agent_start')({ prompt: 'ok', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    assert.match(first.message.content, /BOOTSTRAP/);
    assert.equal(await h.handlers.get('context')({ messages: [{ role: 'user', content: 'ok' }] }), undefined);
  } finally { cleanup(h); }
});

test('failed registry write is reported without corrupting the saved card', async () => {
  const h = await harness();
  try {
    const registry = path.join(h.temp, '.pi/anti-amnesia/registry.json');
    fs.mkdirSync(registry, { recursive: true }); // rename over directory must fail
    const result = await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, 'registry-failed');
    assert.equal(result.details.cardSaved, true);
    await h.commands.get('card').handler('every 4', h.ctx);
    assert.match(h.notifications.at(-2)[0], /Registro non salvabile/);
    assert.equal(fs.readFileSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md'), 'utf8'), card);
    assert.deepEqual(fs.readdirSync(path.dirname(registry)).filter((name) => name.includes('.tmp')), []);
  } finally { cleanup(h); }
});

test('delete blocks traversal and invalidates the active memory', async () => {
  const h = await harness();
  try {
    const sentinel = path.join(h.temp, '.pi/foreign.md');
    fs.writeFileSync(sentinel, 'must survive');
    await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    await h.commands.get('card').handler('delete ../../foreign', h.ctx);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must survive');
    await h.commands.get('card').handler('delete test-session-uuid', h.ctx);
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md')), false);
    const bootstrap = await h.handlers.get('before_agent_start')({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    assert.match(bootstrap.message.content, /BOOTSTRAP/);
    assert.equal((await h.tools.get('memory_card').execute('read', {}, undefined, undefined, h.ctx)).details.chars, 0);
  } finally { cleanup(h); }
});

test('purge invalidates an old active card and never interprets unsafe registry keys as paths', async () => {
  const h = await harness();
  try {
    await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    const registry = path.join(h.temp, '.pi/anti-amnesia/registry.json');
    const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
    data.cards['test-session-uuid'].updatedAt = Date.now() - 7200_000;
    data.cards['../../foreign'] = { ...data.cards['test-session-uuid'] };
    fs.writeFileSync(registry, JSON.stringify(data));
    await h.commands.get('card').handler('purge 1', h.ctx);
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md')), false);
    assert.equal((await h.tools.get('memory_card').execute('read', {}, undefined, undefined, h.ctx)).details.chars, 0);
  } finally { cleanup(h); }
});

test('unknown structured headings do not leak into active checkpoint injections', async () => {
  const h = await harness();
  try {
    const mixed = '## Sempre valido\nRuolo dev\n## Lavoro attivo\nProssimo test invoice\n## Dettagli clienti\nNon diffondere il contatto';
    await h.tools.get('memory_card').execute('id', { text: mixed }, undefined, undefined, h.ctx);
    for (let i = 0; i < 5; i++) await h.handlers.get('turn_end')();
    const heartbeat = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(heartbeat.messages.at(-1).content, /Prossimo test invoice/);
    assert.doesNotMatch(heartbeat.messages.at(-1).content, /Non diffondere il contatto/);
  } finally { cleanup(h); }
});

test('old persistent card messages are removed from model context and manual refresh is fresh', async () => {
  const h = await harness();
  try {
    await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    const old = { role: 'custom', customType: 'anti-amnesia', content: 'OLD WRONG TASK' };
    const input = [{ role: 'user', content: 'continua' }, old];
    const cleaned = await h.handlers.get('context')({ messages: input });
    assert.deepEqual(cleaned.messages, [input[0]]);
    await h.commands.get('card').handler('now', h.ctx);
    const refreshed = await h.handlers.get('context')({ messages: input });
    assert.doesNotMatch(JSON.stringify(refreshed.messages), /OLD WRONG TASK/);
    assert.match(refreshed.messages.at(-1).content, /Riparare API pagamenti/);
    assert.equal(h.messages.length, 0);
  } finally { cleanup(h); }
});

test('short autonomous heartbeat repeats active checkpoint before the full refresh', async () => {
  const h = await harness();
  try {
    await h.tools.get('memory_card').execute('id', { text: card }, undefined, undefined, h.ctx);
    for (let i = 0; i < 5; i++) await h.handlers.get('turn_end')();
    const heartbeat = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'ok' }] });
    assert.match(heartbeat.messages.at(-1).content, /CHECKPOINT LAVORO ATTIVO/);
    assert.match(heartbeat.messages.at(-1).content, /prossimo test invoice/);
    assert.doesNotMatch(heartbeat.messages.at(-1).content, /Vecchia campagna CRM/);
    assert.equal(await h.handlers.get('context')({ messages: [{ role: 'user', content: 'ok' }] }), undefined);
  } finally { cleanup(h); }
});

test('scheduled refresh and review run without fresh user keywords', async () => {
  const h = await harness();
  try {
    await h.tools.get('memory_card').execute('id', { text: card, everyTurns: 1 }, undefined, undefined, h.ctx);
    await h.handlers.get('turn_end')();
    const next = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'ok' }] });
    assert.match(next.messages.at(-1).content, /refresh periodico/);
    assert.match(next.messages.at(-1).content, /prossimo test invoice/);
    assert.doesNotMatch(next.messages.at(-1).content, /Vecchia campagna CRM/);
    await h.handlers.get('turn_end')(); // random target between 1 and 2 turns
    const review = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(review.messages.at(-1).content, /RIVEDI CARTA/);
    assert.match(review.messages.at(-1).content, /prossimo test invoice/);
  } finally { cleanup(h); }
});

// ---- i18n: the bootstrap prompt must be complete in every language ----
// The catalogs are loaded at session_start, so the language must be forced BEFORE
// the harness. If an array key is wrong, without these tests the prompt would
// lose lines silently.

async function bootstrapIn(lang) {
  const previous = process.env.PI_ANTI_AMNESIA_LANG;
  process.env.PI_ANTI_AMNESIA_LANG = lang;
  try {
    const h = await harness();
    try {
      const before = h.handlers.get('before_agent_start');
      const res = await before({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
      return res.message.content;
    } finally { cleanup(h); }
  } finally {
    if (previous === undefined) delete process.env.PI_ANTI_AMNESIA_LANG;
    else process.env.PI_ANTI_AMNESIA_LANG = previous;
  }
}

test('the bootstrap prompt is complete in Italian', async () => {
  const out = await bootstrapIn('it');
  assert.doesNotMatch(out, /missing i18n key/, 'no i18n key must be missing');
  assert.match(out, /Lavoro attivo/, 'section title in Italian');
  assert.match(out, /memory_card\(\{/, 'invocation example present');
  assert.match(out, /## Sempre valido/, 'instruction on the stable section present');
  assert.match(out, /## Lavoro attivo/, 'instruction on the checkpoint present');
  assert.match(out, /## Topic/, 'instruction on topics present');
  assert.match(out, /annebbiato/, 'closing present');
});

test('the bootstrap prompt is complete in English', async () => {
  const out = await bootstrapIn('en');
  assert.doesNotMatch(out, /missing i18n key/, 'no i18n key must be missing');
  assert.match(out, /Active work/, 'section title in English');
  assert.doesNotMatch(out, /Lavoro attivo/, 'no Italian leftovers');
  assert.match(out, /## Always valid/, 'instruction on the stable section present');
  assert.match(out, /## Active work/, 'instruction on the checkpoint present');
  assert.match(out, /## Topic/, 'instruction on topics present');
});

test('both languages produce the same number of prompt lines', async () => {
  const it = (await bootstrapIn('it')).split('\n');
  const en = (await bootstrapIn('en')).split('\n');
  assert.equal(it.length, en.length, 'one language must not lose lines against the other');
});

// ---- The block API, driven THROUGH THE TOOL ----------------------------------------------
// The pure functions behind it are proved in topic-scope.test.mjs. What can still break here is
// the WIRING: a perfect function connected to the wrong parameter, or to none at all. These
// tests exist for that gap, and that is why they live in this file and not in that one.

const BASE_CARD =
  '## Sempre valido\nRegola A.\n\n## Lavoro attivo\nTask 1.\n\n## Topic: db\nNota sul db.';

async function readCard(tool, h, id = 'read') {
  const res = await tool.execute(id, {}, undefined, undefined, h.ctx);
  return res.content[0].text;
}

test('block + value rewrites ONE section and leaves the others untouched', async () => {
  const h = await harness();
  try {
    const tool = h.tools.get('memory_card');
    assert.equal((await tool.execute('a', { text: BASE_CARD }, undefined, undefined, h.ctx)).details.ok, true);

    const written = await tool.execute('b', { block: 'active', value: 'Task 2.' }, undefined, undefined, h.ctx);
    assert.equal(written.details.ok, true, 'writing one block must succeed');

    const card = await readCard(tool, h);
    assert.match(card, /Task 2\./, 'the new body must be in the card');
    assert.doesNotMatch(card, /Task 1\./, 'the old body must be gone');
    assert.match(card, /Regola A\./, 'the stable section must be intact');
    assert.match(card, /Nota sul db\./, 'the topic must be intact');
  } finally { cleanup(h); }
});

test('a block that does not exist yet is APPENDED, not refused', async () => {
  const h = await harness();
  try {
    const tool = h.tools.get('memory_card');
    await tool.execute('a', { text: BASE_CARD }, undefined, undefined, h.ctx);
    const written = await tool.execute('b', { block: 'todo', value: '- [ ] primo' }, undefined, undefined, h.ctx);
    assert.equal(written.details.ok, true, 'a missing section must be created, not rejected');
    const card = await readCard(tool, h);
    assert.match(card, /## Todo/, 'the new section must exist');
    assert.match(card, /- \[ \] primo/, 'with the body it was given');
    assert.match(card, /Regola A\./, 'and the rest must still be there');
  } finally { cleanup(h); }
});

test('todoItem has three states through the tool, and a boolean still works', async () => {
  const h = await harness();
  try {
    const tool = h.tools.get('memory_card');
    await tool.execute('a', { text: `${BASE_CARD}\n\n## Todo\n- [ ] scrivere i test\n- [ ] leggere il codice` }, undefined, undefined, h.ctx);

    const working = await tool.execute('b', { todoItem: 1, todoStatus: 'in_progress' }, undefined, undefined, h.ctx);
    assert.equal(working.details.ok, true, 'todoStatus must be accepted by the tool');
    let card = await readCard(tool, h);
    assert.match(card, /- \[~\] scrivere i test/, 'in_progress must be visible');
    assert.match(card, /- \[ \] leggere il codice/, 'the other item must not move');

    // THE BOOLEAN KEEPS ITS OLD MEANING: this is what makes the change an extension and not a
    // break. If this ever fails, every caller written before todoStatus existed is broken.
    await tool.execute('c', { todoItem: 1, todoDone: true }, undefined, undefined, h.ctx);
    card = await readCard(tool, h);
    assert.match(card, /- \[x\] scrivere i test/, 'a boolean true must still mean completed');

    await tool.execute('d', { todoItem: 1, todoDone: false }, undefined, undefined, h.ctx);
    card = await readCard(tool, h);
    assert.match(card, /- \[ \] scrivere i test/, 'a boolean false must still mean not done');
  } finally { cleanup(h); }
});

test('an unknown block is REFUSED and the refusal names the allowed ones', async () => {
  const h = await harness();
  try {
    const tool = h.tools.get('memory_card');
    await tool.execute('a', { text: BASE_CARD }, undefined, undefined, h.ctx);
    const bad = await tool.execute('b', { block: 'Spartito', value: 'x' }, undefined, undefined, h.ctx);
    assert.equal(bad.details.ok, false, 'an unknown block must never be guessed into an existing one');
    assert.equal(bad.details.error, 'unknown-block');
    assert.deepEqual(bad.details.allowed, ['always', 'active', 'objective', 'plan', 'todo']);
  } finally { cleanup(h); }
});

test('block and todoItem need a card: without one they are refused, not silently ignored', async () => {
  const h = await harness();
  try {
    const tool = h.tools.get('memory_card');
    const noCard = await tool.execute('a', { block: 'todo', value: 'x' }, undefined, undefined, h.ctx);
    assert.equal(noCard.details.ok, false, 'writing a block with no card must be refused');
    assert.equal(noCard.details.error, 'card-missing');

    const noTodo = await tool.execute('b', { todoItem: 1, todoDone: true }, undefined, undefined, h.ctx);
    assert.equal(noTodo.details.ok, false, 'checking an item with no card must be refused');
  } finally { cleanup(h); }
});
