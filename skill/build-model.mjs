// Regenerates skill/interaction-model.json from the vocab tables in server/alexa-skill.mjs.
// Run: node skill/build-model.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COLORS, EFFECTS, SONGS, SONG_SYNONYMS, GAMES, CHANNELS, TV_SCENES, slugify } from '../server/alexa-skill.mjs';

const slot = (name, type) => ({ name, type });
const intents = [
  { name: 'AMAZON.CancelIntent', samples: [] },
  { name: 'AMAZON.HelpIntent', samples: [] },
  { name: 'AMAZON.StopIntent', samples: [] },
  { name: 'AMAZON.FallbackIntent', samples: [] },
  { name: 'TellJokeIntent', samples: ['tell me a joke', 'tell me a christmas joke', 'give me a joke', 'joke', 'another joke', 'make me laugh', 'tell me a funny joke', 'i want a joke', 'say something funny', 'tell me another joke'] },
  { name: 'CountdownIntent', samples: ['how many days until christmas', 'how long until christmas', 'how many sleeps until christmas', 'how many days left', 'christmas countdown', 'countdown', 'how many days till christmas', 'how long till christmas', 'how many sleeps left', 'how many more sleeps'] },
  { name: 'SantaIntent', samples: ['where is santa', "where's santa", 'track santa', 'santa status', 'how far is santa', 'is santa coming', 'where is santa now', 'what is santa doing', 'has santa left the north pole', 'santa tracker'] },
  { name: 'TreeColorIntent', slots: [slot('color', 'TREE_COLOR')], samples: ['make the tree {color}', 'turn the tree {color}', 'set the tree color to {color}', 'change the tree color to {color}', 'color the tree {color}', 'paint the tree {color}', 'make the lights {color}', 'turn the lights {color}', 'set the lights to {color}'] },
  { name: 'TreeEffectIntent', slots: [slot('effect', 'EFFECT')], samples: ['set the tree to {effect}', 'set the tree effect to {effect}', 'switch the tree to {effect} mode', 'use the {effect} effect', 'change the pattern to {effect}', 'give the tree a {effect} effect', 'try {effect} mode', 'switch to the {effect} effect', 'put the tree in {effect} mode'] },
  { name: 'TreeOnIntent', samples: ['turn on the tree', 'turn the tree on', 'tree on', 'light the tree', 'switch on the tree', 'turn on the christmas tree', 'turn on the tree lights', 'light up the tree'] },
  { name: 'TreeOffIntent', samples: ['turn off the tree', 'turn the tree off', 'tree off', 'switch off the tree', 'turn off the christmas tree', 'turn off the tree lights', 'put out the tree'] },
  { name: 'LightShowIntent', slots: [slot('song', 'SONG')], samples: ['start a light show', 'play a light show', 'start the light show', 'play {song}', 'play {song} on the tree', 'light show {song}', 'start a light show of {song}', 'do a light show for {song}', 'put on a light show', 'surprise me with a light show'] },
  { name: 'StopShowIntent', samples: ['stop the show', 'stop the light show', 'end the show', 'stop the music', 'cancel the light show', 'end the light show', 'turn off the show', 'stop the song'] },
  { name: 'StartGameIntent', slots: [slot('game', 'GAME')], samples: ["let's play {game}", 'start {game}', 'start a game of {game}', 'play a game of {game}', 'launch {game}', 'i want to play {game}', 'game time', 'start a game', 'play a game'] },
  { name: 'AdventIntent', samples: ["what's today's advent", "open today's advent door", 'advent calendar', "what's behind today's door", "today's advent challenge", 'open the advent calendar', "what's in the advent calendar today", 'advent'] },
  { name: 'ElfNameIntent', slots: [slot('name', 'AMAZON.FirstName')], samples: ["what's my elf name", 'give me an elf name', 'my name is {name} what is my elf name', 'what is my elf name', 'what is the elf name for {name}', 'make me an elf name', 'tell me my elf name', 'i am {name} what is my elf name', 'elf name for {name}', 'elf name'] },
  { name: 'PartyIntent', samples: ['start the party', 'party mode', "let's party", 'throw a party', 'turn on party mode', "it's party time", 'party time', 'start party mode'] },
  { name: 'GoodnightIntent', samples: ['goodnight', 'good night', 'goodnight tree', 'say goodnight', 'time for bed', 'bedtime', 'good night santa', "it's bedtime", 'tuck in the tree'] },
  { name: 'YuleLogIntent', samples: ['light the yule log', 'yule log', 'put on the yule log', 'start the yule log', 'fireplace on the tv', 'show the yule log', 'burn the yule log', 'turn on the yule log'] },
  { name: 'RadioIntent', slots: [slot('channel', 'RADIO_CHANNEL')], samples: ['play christmas radio', 'play the radio', 'start the radio', 'turn on christmas music', 'play {channel} radio', 'put on the radio', 'play christmas music', 'tune the radio to {channel}'] },
  // AMAZON.SearchQuery needs a carrier phrase: "Alexa, ask North Pole: dear Santa, how do reindeer fly?"
  { name: 'AskSantaIntent', slots: [slot('question', 'AMAZON.SearchQuery')], samples: ['dear santa {question}', 'ask santa {question}', 'santa {question}', 'hey santa {question}', 'question for santa {question}', 'i want to ask santa {question}', 'tell santa {question}'] },
  { name: 'ReportCardIntent', slots: [slot('name', 'AMAZON.FirstName')], samples: ['report card for {name}', 'a report card for {name}', 'make a report card for {name}', 'elf report card for {name}', 'give {name} a report card', 'grade {name}', 'how did {name} do this year', "write {name}'s report card", "{name}'s report card"] },
  { name: 'StoryIntent', samples: ['tell us a story', 'tell a story', 'tell me a story', 'story time', 'tell us a christmas story', 'tell a christmas story', 'make up a story', 'christmas story', "it's story time", 'read us a story'] },
  { name: 'TvOnIntent', samples: ['turn on the tv', 'turn the tv on', 'tv on', 'switch on the tv', 'put it on the tv', 'start the tv', 'wake up the tv'] },
  { name: 'TvOffIntent', samples: ['turn off the tv', 'turn the tv off', 'tv off', 'switch off the tv', 'shut off the tv', 'put the tv to sleep'] },
  { name: 'TvSceneIntent', slots: [slot('scene', 'TV_SCENE')], samples: ['show the {scene} on the tv', 'put the {scene} on the tv', 'show {scene}', 'put on the {scene}', 'tv show the {scene}', 'switch the tv to the {scene}', 'show the {scene}'] },
];

const val = (id, name, syn = []) => ({ id, name: { value: name, ...(syn.length ? { synonyms: syn } : {}) } });
const types = [
  { name: 'TREE_COLOR', values: COLORS.map((c) => val(slugify(c.name), c.name, c.syn)) },
  { name: 'EFFECT', values: EFFECTS.map((e) => val(e.id, e.name, e.syn)) },
  { name: 'SONG', values: SONGS.map((s) => val(slugify(s), s, SONG_SYNONYMS[s] || [])) },
  { name: 'GAME', values: GAMES.map((g) => val(g.id, g.name, g.syn)) },
  { name: 'RADIO_CHANNEL', values: CHANNELS.map((c) => val(c.id, c.name, c.syn)) },
  { name: 'TV_SCENE', values: TV_SCENES.map((s) => val(s.id, s.name, s.syn)) },
];

const model = { interactionModel: { languageModel: { invocationName: 'north pole', intents, types } } };
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'interaction-model.json');
fs.writeFileSync(out, JSON.stringify(model, null, 2) + '\n');
console.log('wrote', out);
