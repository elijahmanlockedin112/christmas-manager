// The ONLY place that talks to the Claude API (a test enforces this).
// Every call - success or failure - is appended to data/claude-spend.jsonl with tokens from the
// response's own `usage` and a cost from the dated price table below. A monthly $ cap is checked
// from that ledger before every call.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { ENGINES, ENGINE_IDS, MIN_ITEMS, cleanItems, cleanFacts } from './workshop.mjs';
import { previewFor } from './previews.mjs';

// One schema per game type, tied together by "engine". The numbers and lengths are checked after parsing
// (cleanItems), because the structured-output schema can't express them.
const triviaItem = z.object({ q: z.string(), choices: z.array(z.string()), answer: z.number().int(), fact: z.string(), category: z.string(), difficulty: z.number().int() });
const pairItem = z.object({ a: z.string(), b: z.string() });
const sceneItem = z.object({ scene: z.string(), ask: z.string() });
const wordItem = z.object({ word: z.string(), level: z.number().int() });
const songItem = z.object({ title: z.string(), artist: z.string(), year: z.number().int() });
const gameHead = { title: z.string().describe('a fun game title, max 40 characters'), tagline: z.string().describe('one short line, max 90 characters') };
const GAME_SCHEMA = z.object({
  game: z.discriminatedUnion('engine', [
    z.object({ engine: z.literal('trivia'), ...gameHead, items: z.array(triviaItem) }),
    z.object({ engine: z.literal('most-likely'), ...gameHead, items: z.array(z.string()) }),
    z.object({ engine: z.literal('mind-reader'), ...gameHead, items: z.array(pairItem) }),
    z.object({ engine: z.literal('caption-chaos'), ...gameHead, items: z.array(sceneItem) }),
    z.object({ engine: z.literal('would-you-rather'), ...gameHead, items: z.array(pairItem) }),
    z.object({ engine: z.literal('pictionary'), ...gameHead, items: z.array(wordItem) }),
    z.object({ engine: z.literal('telephone'), ...gameHead, items: z.array(z.string()) }),
    z.object({ engine: z.literal('name-that-song'), ...gameHead, items: z.array(songItem) }),
  ]),
});

export const MODEL ='claude-haiku-5-5';
// USD per 1M tokens. Source: Claude API model table, cached 2026-10-06 (prompts up to 100K tokens).
// Cache read/write for Haiku 5.5 aren't in that table; estimated at the usual 0.1x / 1.25x of input.
export const PRICES = { date: '2026-10-06', [MODEL]: { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 } };

const SYSTEM = `You write short, funny, warm Christmas entertainment for a family game night (kids, teens, parents and grandparents all watching on the TV together).
Rules: always kind and family-friendly; tease gently, never mean, never about bodies, weight, intelligence, money or anyone's real problems; no romance, no scary content, no brand names, no copyrighted song lyrics or characters other than Santa, Mrs. Claus, elves and reindeer.
Use the names and details you are given. Keep it punchy: short sentences that read well out loud. Plain text only (no markdown, no emoji).`;

export class AI {
  constructor(app) {
    this.app = app;
    this.ledger = path.join(app.dataDir, 'claude-spend.jsonl');
    this.secretFile = path.join(app.dataDir, 'secrets.json');
    this.client = null;
    this.busy = false;
  }
  get cap() { return Number(this.app.config.ai?.capUsd ?? 5); }
  key() { try { return JSON.parse(fs.readFileSync(this.secretFile, 'utf8')).anthropicKey || ''; } catch { return ''; } }
  get configured() { return !!this.key(); }
  setKey(k) {
    k = String(k || '').trim();
    if (k && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new Error("That doesn't look like a Claude API key (it starts with sk-ant-).");
    let s = {}; try { s = JSON.parse(fs.readFileSync(this.secretFile, 'utf8')); } catch { }
    if (k) s.anthropicKey = k; else delete s.anthropicKey;
    fs.writeFileSync(this.secretFile, JSON.stringify(s), { mode: 0o600 });
    this.client = null;
    this.push();
  }
  rows() {
    try { return fs.readFileSync(this.ledger, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
  }
  usage() {
    const rows = this.rows(), now = new Date();
    const month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
    const inMonth = rows.filter(r => r.time.startsWith(month));
    const sum = list => +list.reduce((a, r) => a + (r.cost || 0), 0).toFixed(6);
    const byFeature = {};
    for (const r of inMonth) byFeature[r.feature] = +((byFeature[r.feature] || 0) + (r.cost || 0)).toFixed(6);
    const daily = {};
    for (const r of inMonth) daily[r.time.slice(0, 10)] = +((daily[r.time.slice(0, 10)] || 0) + (r.cost || 0)).toFixed(6);
    return { month: sum(inMonth), today: sum(rows.filter(r => r.time.startsWith(day))), cap: this.cap, calls: inMonth.length, failed: inMonth.filter(r => !r.ok).length, byFeature, daily, recent: rows.slice(-12).reverse(), prices: PRICES };
  }
  push() {
    const u = this.usage();
    this.app.state.ai = { configured: this.configured, busy: this.busy, month: u.month, today: u.today, cap: u.cap, calls: u.calls };
    this.app.changed();
  }
  cost(usage) {
    const p = PRICES[MODEL];
    return ((usage.input_tokens || 0) * p.input + (usage.output_tokens || 0) * p.output + (usage.cache_read_input_tokens || 0) * p.cacheRead + (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
  }
  log(row) { fs.appendFileSync(this.ledger, JSON.stringify(row) + '\n'); }

  // One call, logged and capped. `schema` (zod) gives structured JSON back.
  async call({ feature, prompt, schema, maxTokens = 1500 }) {
    if (!this.configured) throw new Error('Add the Claude API key in Setup first.');
    const spent = this.usage().month;
    if (spent >= this.cap) throw new Error(`This month's AI budget ($${this.cap.toFixed(2)}) is used up. Raise it in Setup.`);
    if (this.busy) throw new Error('One moment, the elves are still writing the last one.');
    this.client ||= new Anthropic({ apiKey: this.key(), maxRetries: 1, timeout: 45000 });
    this.busy = true; this.push();
    const base = { time: new Date().toISOString(), script: 'server', feature, model: MODEL, effort: 'low' };
    try {
      const req = { model: MODEL, max_tokens: maxTokens, system: SYSTEM, output_config: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] };
      const res = schema
        ? await this.client.messages.parse({ ...req, output_config: { effort: 'low', format: zodOutputFormat(schema) } })
        : await this.client.messages.create(req);
      const u = res.usage || {};
      this.log({ ...base, ok: res.stop_reason !== 'refusal', stop: res.stop_reason, id: res.id, input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cost: +this.cost(u).toFixed(6) });
      if (res.stop_reason === 'refusal') throw new Error("The elves couldn't write that one. Try different words.");
      if (schema) { if (!res.parsed_output) throw new Error('The elves scrambled the letter. Try again.'); return res.parsed_output; }
      return res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    } catch (e) {
      // failed calls are logged too: they can still bill input tokens
      if (!e.message?.startsWith('The elves')) this.log({ ...base, ok: false, error: String(e.status || '') + ' ' + String(e.message || e).slice(0, 160), id: e.request_id || e.headers?.['request-id'] || null, input: 0, output: 0, cost: 0 });
      throw e.status === 401 ? new Error('Claude rejected the API key. Check it in Setup.') : e;
    } finally {
      this.busy = false; this.push();
    }
  }

  // ---------- the games ----------
  reportCard({ name, cookie, proud, confess }) {
    return this.call({
      feature: 'report-card',
      schema: z.object({
        title: z.string().describe('A funny official title for this person, max 6 words'),
        grades: z.array(z.object({ subject: z.string().describe('a silly North Pole school subject, max 4 words'), grade: z.string().describe('a letter grade like A+, B-, or a joke grade like "Gold Star"'), note: z.string().describe('one short funny teacher comment, max 16 words') })).describe('exactly 4 subjects'),
        santaNote: z.string().describe("Santa's warm, funny final verdict, 2 short sentences, max 40 words, ending on something kind"),
      }),
      prompt: `Write an Elf Report Card for ${name}.
Their favorite Christmas cookie: ${cookie || '(not given)'}
Something they did this year they're proud of: ${proud || '(not given)'}
A small, funny confession: ${confess || '(not given)'}
Make the subjects and comments specific to these answers. Roast gently, toast warmly.`,
    });
  }
  madlibs({ words, names }) {
    const list = Object.entries(words).filter(([, v]) => String(v).trim()).map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join('\n');
    return this.call({
      feature: 'mad-libs',
      schema: z.object({
        title: z.string().describe('a funny story title, max 7 words'),
        story: z.string().describe('the story, 110-150 words, every supplied word used exactly as given and wrapped in double square brackets like [[word]]'),
      }),
      prompt: `Write a silly Christmas Eve story starring this family: ${names.join(', ') || 'the family'}.
Use every one of these words exactly as written, wrapping each in [[double brackets]]:
${list}
Give it a beginning, a ridiculous middle and a happy ending at the tree.`,
      maxTokens: 2000,
    });
  }
  story({ names, words }) {
    return this.call({
      feature: 'story',
      schema: z.object({ title: z.string().describe('a funny story title, max 7 words'), story: z.string().describe('the story, 80-110 words, short sentences that read well aloud') }),
      prompt: `Tell a short, silly bedtime-style Christmas story starring this family: ${names.join(', ') || 'the family'}.
Work in these random things: ${words.join(', ')}.
A beginning, a ridiculous middle and a cozy happy ending at the Christmas tree.`,
      maxTokens: 1500,
    });
  }
  // Caption Chaos: the elf's own entry, mixed in anonymously with the family's captions
  async captionElf({ scene, ask }) {
    const out = await this.call({
      feature: 'caption-elf',
      schema: z.object({ caption: z.string().describe('one funny caption, max 14 words, in the voice of a character in the scene, no quotation marks') }),
      prompt: `A family party game shows this ridiculous scene: "${String(scene).slice(0, 200)}"
The prompt is: "${String(ask).slice(0, 80)}"
Write one short, genuinely funny caption that answers the prompt. Deadpan beats wacky. Do not explain the joke.`,
      maxTokens: 300,
    });
    return out.caption;
  }
  // Portrait Studio: the snooty art critic looks at one family drawing and reviews it, kindly
  async portraitCritic({ title, medium, artist, subject, png }) {
    const text = `You are a magnificently pompous, over-the-top art critic reviewing a family game night's drawing, hung in a gold frame in a gallery. The piece is titled "${String(title).slice(0, 40)}", ${String(medium).slice(0, 40)}, by ${String(artist).slice(0, 20)}. It is meant to be a portrait of ${String(subject).slice(0, 20)}, a real family member who is in the room.
Write the review in 1 or 2 sentences (max 45 words) that read well out loud. Be snooty, grand and funny about the ART: the lines, colours, composition, ambition, the bravery of the artist. Be affectionate. Never be mean, and never comment on anyone's real appearance, face, body, hair or age: the joke is the critic's pretension, not the subject. You may use the artist's name once.`;
    const prompt = png ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } }, { type: 'text', text }] : text;
    const out = await this.call({ feature: 'portrait-critic', schema: z.object({ review: z.string().describe('the critic\'s 1-2 sentence review, max 45 words, plain text') }), prompt, maxTokens: 300 });
    return out.review;
  }
  // Elf Workshop: one call picks the best engine for the request and writes the whole game in that engine's shape.
  // Everything the model returns is validated again here (server/workshop.mjs cleanItems); bad items are dropped.
  async buildGame({ request, players = [], facts = [], echoReady, findPreview }) {
    request = String(request || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!request) throw new Error('Tell the elves what game to make.');
    const names = players.map(n => String(n).slice(0, 20)).slice(0, 8);
    const notes = cleanFacts(facts);
    const catalog = ENGINE_IDS.map(id => `- ${id} (${ENGINES[id].name}): each item is ${ENGINES[id].shape}`).join('\n');
    const raw = await this.call({
      feature: 'workshop',
      schema: GAME_SCHEMA,
      maxTokens: 2500,
      prompt: `The family asks the elves to build this game: "${request}"
Players in the room: ${names.join(', ') || '(not given)'}.
${notes.length ? `Things the family told you about themselves (the ONLY facts you may use about them; never invent others):\n${notes.map(f => '- ' + f).join('\n')}` : 'You know nothing about the family beyond their names, so do not invent facts about them.'}

Pick the ONE game type below that fits the request best, then write the game. Match the request's theme closely.
${catalog}

Rules:
- "engine" must be exactly one of: ${ENGINE_IDS.join(', ')}.
- "title": a fun game title, max 40 characters. "tagline": one short line, max 90 characters.
- "items": 8 to 12 items, each in EXACTLY the shape of the chosen game type. No two items alike, nothing empty.
- Trivia answers must be actually true and checkable. For questions about the family, use ONLY the facts listed above. If the request is about the family and there are no facts, ask about the players' names and Christmas in general instead.
- Name That Song: only REAL, well-known Christmas or winter songs that were really recorded by that artist. Give 14 items so a few can be dropped.
- Never be mean about a real person. Keep it fun for kids and grandparents.
- Plain text only, no emoji.`,
    });
    const engine = String(raw?.game?.engine || '');
    if (!ENGINES[engine]) throw new Error("The elves couldn't pick a game for that one. Try describing it a different way.");
    let items = cleanItems(engine, raw.game.items);
    if (engine === 'name-that-song' && !(echoReady ?? this.app.alexa?.ready)) {
      // without the Echo the TV plays 30-second iTunes clips, so keep only the songs that really have one
      const find = findPreview || (h => previewFor(h, { dataDir: this.app.dataDir, log: this.app.log }));
      const found = await Promise.all(items.map(h => Promise.resolve(find(h)).then(Boolean, () => false)));
      items = items.filter((_, i) => found[i]);
    }
    if (items.length < MIN_ITEMS) throw new Error("The elves couldn't make enough good rounds for that one. Try different words.");
    const title = String(raw.game.title || '').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
    if (!title) throw new Error('The elves forgot to name the game. Try again.');
    return { engine, title, tagline: String(raw.game.tagline || '').replace(/\s+/g, ' ').trim().slice(0, 100), items };
  }
  askSanta({ question, asker }) {
    return this.call({
      feature: 'ask-santa',
      prompt: `${asker ? asker : 'Someone in the family'} asks Santa: "${String(question).slice(0, 300)}"
Answer as Santa Claus in 2-4 short sentences (max 60 words), jolly and specific, with one small fun detail about the North Pole. If the question isn't appropriate for a family, cheerfully change the subject to Christmas.`,
      maxTokens: 800,
    });
  }
}
