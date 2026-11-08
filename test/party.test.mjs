// Family party games (server/party.mjs): rules, scoring and the AI elf's fallback. No network, no timers left running.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Games } from '../server/games.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f), 'utf8'));

function room(n = 4, ai = null) {
  const app = {
    config: { roster: [], settings: {} }, saveConfig() { }, changed() { }, log() { }, sfx() { }, ai,
    state: { tv: {}, show: {} }, setTvScene() { },
    lights: { overlay() { }, clearOverlays() { } },
    content: { mostLikely: json('most-likely.json'), mindReader: json('mind-reader.json'), captions: json('captions.json') },
  };
  const games = new Games(app);
  const ids = ['Ada', 'Bo', 'Cy', 'Di', 'Ed'].slice(0, n).map(name => games.addLocal(name).id);
  return { games, ids, g: () => games.g, score: id => games.players.get(id).score, done: () => games.end() };
}

test('content: 40+ family-friendly items per game', () => {
  assert.ok(json('most-likely.json').length >= 40);
  assert.ok(json('mind-reader.json').length >= 40);
  assert.ok(json('captions.json').length >= 40);
  for (const m of json('mind-reader.json')) assert.ok(m.a && m.b && m.a !== m.b);
  for (const c of json('captions.json')) assert.ok(c.scene && c.ask);
});

test('games need enough players and never start with an unknown kind', () => {
  const r = room(2);
  assert.throws(() => r.games.start('most-likely'), /at least 3/);
  assert.throws(() => r.games.start('caption-chaos'), /at least 3/);
  r.games.start('mind-reader'); // two is enough
  assert.equal(r.g().kind, 'mind-reader');
  r.done();
});

test('most likely to: crowd pick scores, split vote scores nobody, no double votes', () => {
  const r = room(4); const [a, b, c, d] = r.ids;
  r.games.start('most-likely'); r.games.next();
  assert.equal(r.g().phase, 'vote');
  r.games.mlVote(a, c); r.games.mlVote(b, c); r.games.mlVote(c, a);
  r.games.mlVote(a, d); // second vote from Ada is ignored
  assert.equal(r.g().x.voted.length, 3);
  r.games.mlVote(d, c);
  r.games.mlReveal();
  assert.equal(r.g().phase, 'reveal');
  assert.deepEqual(r.g().x.winners, [c]);
  assert.equal(r.score(c), 150); // the title
  assert.equal(r.score(a), 100); assert.equal(r.score(b), 100); assert.equal(r.score(d), 100); // voted with the crowd
  // a round where everyone disagrees
  r.games.g.round = 1; r.games.next();
  r.games.mlVote(a, b); r.games.mlVote(b, c); r.games.mlVote(c, d); r.games.mlVote(d, a);
  r.games.mlReveal();
  assert.deepEqual(r.g().x.winners, []);
  assert.equal(r.score(c), 150);
  r.done();
});

test('mind reader: only the spotlight picks, only others guess, right guesses score both sides', () => {
  const r = room(4);
  r.games.start('mind-reader');
  assert.equal(r.g().total, 4); // 4 players: one spotlight each
  r.games.next();
  assert.equal(r.g().phase, 'turn');
  const spot = r.g().x.spot.id, others = r.ids.filter(id => id !== spot);
  assert.equal(r.g().x.a, null, 'choices stay hidden until the spotlight is ready');
  r.games.turnReady(r.g().round);
  assert.equal(r.g().phase, 'pick');
  r.games.mrPick(others[0], 'a'); // not the spotlight: ignored
  assert.equal(r.g().phase, 'pick');
  r.games.mrPick(spot, 'b');
  assert.equal(r.g().phase, 'guess');
  assert.equal(JSON.stringify(r.g()).includes('"pick":"b"'), false, 'the pick is not public before the reveal');
  r.games.mrGuess(spot, 'a'); // the spotlight cannot guess
  r.games.mrGuess(others[0], 'b'); r.games.mrGuess(others[1], 'a'); r.games.mrGuess(others[2], 'b');
  r.games.mrGuess(others[0], 'a'); // second guess ignored
  r.games.mrReveal();
  assert.equal(r.g().phase, 'reveal');
  assert.equal(r.g().x.pick, 'b');
  assert.equal(r.score(others[0]), 300); assert.equal(r.score(others[1]), 0); assert.equal(r.score(others[2]), 300);
  assert.equal(r.score(spot), 200);
  r.done();
});

test('mind reader: everyone gets the spotlight equally often', () => {
  const r = room(3);
  r.games.start('mind-reader');
  assert.equal(r.g().total, 6);
  const seen = {};
  for (let i = 0; i < 6; i++) { r.games.next(); seen[r.g().x.spot.id] = (seen[r.g().x.spot.id] || 0) + 1; }
  assert.deepEqual(Object.values(seen).sort(), [2, 2, 2]);
  r.done();
});

test('caption chaos: no voting for yourself; votes pay the author, the winner gets a bonus', () => {
  const r = room(3); const [a, b, c] = r.ids;
  r.games.start('caption-chaos'); r.games.next();
  assert.equal(r.g().phase, 'write');
  assert.equal(r.g().x.elf, false, 'no key, no elf');
  r.games.capSubmit(a, '  Not the   chimney again  ');
  r.games.capSubmit(b, 'I regret the cookies');
  r.games.capSubmit(c, '', true); // skipped
  r.games.capVoteStart();
  assert.equal(r.g().phase, 'vote');
  const entries = r.games.secret.entries, mine = entries.find(e => e.author === a);
  assert.equal(r.g().x.entries.length, 2);
  assert.ok(!JSON.stringify(r.g()).includes('"author"'), 'authors stay secret during the vote');
  assert.equal(mine.text, 'Not the chimney again');
  r.games.capVote(a, mine.id); // self vote ignored
  assert.equal(r.g().x.voted.length, 0);
  r.games.capVote(b, mine.id); r.games.capVote(c, mine.id);
  r.games.capReveal();
  assert.equal(r.g().phase, 'reveal');
  assert.equal(r.score(a), 2 * 200 + 300);
  assert.equal(r.score(b), 0);
  r.done();
});

test('caption chaos: the elf joins in when the key is set, and a failure just skips it', async () => {
  const ai = { configured: true, captionElf: async () => 'The elf wrote this one' };
  const r = room(3, ai);
  r.games.start('caption-chaos'); r.games.next();
  await new Promise(res => setImmediate(res));
  const [a, b, c] = r.ids;
  r.games.capSubmit(a, 'one'); r.games.capSubmit(b, 'two'); r.games.capSubmit(c, 'three');
  r.games.capVoteStart();
  assert.equal(r.g().x.entries.length, 4);
  const elf = r.games.secret.entries.find(e => e.author === 'elf');
  r.games.capVote(a, elf.id); r.games.capVote(b, elf.id);
  r.games.capReveal();
  assert.equal(r.g().x.entries[0].author, 'elf');
  assert.equal(Object.keys(r.g().x.gained).length, 0, 'the elf scores for nobody');
  r.done();

  const bad = room(3, { configured: true, captionElf: async () => { throw new Error('over budget'); } });
  bad.games.start('caption-chaos'); bad.games.next();
  await new Promise(res => setImmediate(res));
  bad.games.capSubmit(bad.ids[0], 'x'); bad.games.capSubmit(bad.ids[1], 'y'); bad.games.capSubmit(bad.ids[2], 'z');
  bad.games.capVoteStart();
  assert.equal(bad.g().x.entries.length, 3);
  bad.done();
});

test('the final reuses the solo podium for the family games', () => {
  const r = room(3);
  r.games.start('most-likely'); r.games.next();
  r.games.mlVote(r.ids[0], r.ids[2]); r.games.mlVote(r.ids[1], r.ids[2]);
  r.games.mlReveal();
  r.games.final();
  assert.equal(r.g().phase, 'final');
  assert.deepEqual(r.g().champs, [r.ids[2]]);
  r.done();
});
