require("../src/Global");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// V25: a quest dialog is signed with the name of the NPC the player talks to.
// Q010 and Q404 once used invented or other NPCs' names, and five imported
// quests spelled names differently from the NPC data. Every speaker label
// (the first argument of page()/p()) of these quests must be the name of one
// of the quest's NPCs in the server's NPC data, optionally prefixed by a role
// ("Warehouse Chief Reed", "Beekeeper Jacob").
const DataCache = invoke("GameServer/DataCache");
DataCache.init();

const questDir = path.join(__dirname, "../src/GameServer/Quest/quests");
const quests = [
  ["Q010_IntoTheWorld", ["Balanki", "Warehouse Chief Reed", "Gerald"]],
  ["Q103_SpiritOfCraftsman", ["Cecktinon"]],
  ["Q152_ShardsOfGolem", ["Harrys"]],
  ["Q327_ReclaimTheLand", ["Piotur", "Trader Asha"]],
  ["Q330_AdeptOfTaste", ["Beekeeper Jacob", "Farmer Pano", "Glyvka", "Rollant"]],
  ["Q333_BlackLionHunt", ["Sophya"]],
  ["Q404_PathToWizard", ["Parina"]],
];
const names = new Map(DataCache.npcs.map((npc) => [Number(npc.selfId), npc.template.name]));
// Labels that are not an NPC speaking.
const generic = new Set(["Quest"]);

for (const [file, explicit] of quests) {
  const mod = require(path.join(questDir, file));
  const quest = mod.default || mod;
  const npcNames = (quest.npcs || []).map((id) => names.get(Number(id))).filter(Boolean);
  assert(npcNames.length >= 1, `${file}: no quest NPC found in the NPC data`);
  const source = fs.readFileSync(path.join(questDir, `${file}.js`), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const speakers = new Set();
  for (const [, , label] of source.matchAll(/\b(?:page|p)\(\s*(["'])((?:(?!\1).)+)\1/g)) speakers.add(label);
  // Q103 picks the label with a ternary: id === C ? "Cecktinon" : ...
  for (const [, , label] of source.matchAll(/\bid === \w+ \? (["'])((?:(?!\1).)+)\1/g)) speakers.add(label);
  assert(speakers.size >= 1, `${file}: no dialog speaker found`);
  for (const label of speakers) {
    if (generic.has(label)) continue;
    assert(
      npcNames.some((name) => label === name || label.endsWith(` ${name}`)),
      `${file}: dialog speaker "${label}" is not the name of a quest NPC (${npcNames.join(", ")})`,
    );
  }
  for (const label of explicit) {
    assert(speakers.has(label), `${file}: expected speaker "${label}" in the dialogs (found: ${[...speakers].join(", ")})`);
  }
}
console.log("Quest NPC name checks passed");
