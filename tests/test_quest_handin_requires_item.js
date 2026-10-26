require("../src/Global");
const assert = require("assert");

// V24: a quest hand-in takes the item first and refuses, naming the item,
// when the player does not hold it (the form of Q167 Dwarven Kinship).
const QuestService = invoke("GameServer/Quest/QuestService");
const Q151 = require("../src/GameServer/Quest/quests/Q151_CureForFeverDisease");
const Q156 = require("../src/GameServer/Quest/quests/Q156_MillenniumLove");
const Q163 = require("../src/GameServer/Quest/quests/Q163_LegacyOfThePoet");

const originals = {
  give: QuestService.giveItem,
  take: QuestService.takeItem,
  adena: QuestService.rewardAdena,
  exp: QuestService.rewardExpSp,
};
const held = new Map();
const gave = [];
QuestService.giveItem = async (_, id, amount) => {
  gave.push(id);
  held.set(id, (held.get(id) || 0) + amount);
};
QuestService.rewardAdena = async (_, amount) => gave.push(["adena", amount]);
QuestService.rewardExpSp = async () => gave.push("expsp");
QuestService.takeItem = async (_, id, amount = 1) => {
  const have = held.get(id) || 0;
  if (!have || (amount !== -1 && have < amount)) return false;
  held.delete(id);
  return true;
};

let cond = 0;
let exited = false;
const state = {
  session: {
    actor: {
      backpack: {
        fetchItemFromSelfId: (id) =>
          held.has(id) ? { fetchAmount: () => held.get(id) } : undefined,
      },
    },
  },
  isStarted: () => true,
  isCompleted: () => false,
  getInt: () => cond,
  set: async (_, value) => { cond = Number(value); },
  playSound() {},
  exit: async () => { exited = true; },
};
const npc = (id) => ({ fetchSelfId: () => id });
const reset = (c) => {
  held.clear();
  gave.length = 0;
  cond = c;
  exited = false;
};

(async () => {
  try {
    // Q151 at Yohanes (cond 2): no Poison Sac -> refused, nothing changes.
    reset(2);
    let html = await Q151.onTalk(state, npc(7032));
    assert.ok(html.includes("Poison Sac"), html);
    assert.strictEqual(cond, 2);
    assert.deepStrictEqual(gave, []);
    held.set(703, 1);
    html = await Q151.onTalk(state, npc(7032));
    assert.ok(html.includes("Take the medicine to Elias"), html);
    assert.strictEqual(cond, 3);
    assert.strictEqual(held.has(703), false);
    assert.strictEqual(held.get(704), 1);

    // Q151 at Elias (cond 3): no Fever Medicine -> no Round Shield, no end.
    reset(3);
    html = await Q151.onTalk(state, npc(7050));
    assert.ok(html.includes("Fever Medicine"), html);
    assert.strictEqual(cond, 3);
    assert.strictEqual(exited, false);
    assert.deepStrictEqual(gave, []);
    held.set(704, 1);
    await Q151.onTalk(state, npc(7050));
    assert.strictEqual(exited, true);
    assert.deepStrictEqual(gave, [102]);
    assert.strictEqual(held.has(704), false);

    // Q156 at Baenedes (cond 1): single item taken first.
    reset(1);
    html = await Q156.onTalk(state, npc(7369));
    assert.ok(html.includes("Lilith's Letter"), html);
    assert.strictEqual(cond, 1);
    assert.deepStrictEqual(gave, []);
    held.set(1022, 1);
    await Q156.onTalk(state, npc(7369));
    assert.strictEqual(cond, 2);
    assert.strictEqual(held.get(1023), 1);

    // Q163 (cond 2): a hand-in of several items refuses before taking any.
    reset(2);
    for (const id of [1038, 1039, 1040]) held.set(id, 1);
    html = await Q163.onTalk(state);
    assert.ok(html.includes("Rumiel's Poems"), html);
    assert.strictEqual(exited, false);
    assert.deepStrictEqual(gave, []);
    assert.strictEqual(held.size, 3, "no poem is taken from a short set");
    held.set(1041, 1);
    await Q163.onTalk(state);
    assert.strictEqual(exited, true);
    assert.strictEqual(held.size, 0);
    assert.deepStrictEqual(gave, [["adena", 13890]]);

    console.log("Quest hand-ins refuse without the item and take it first");
  } finally {
    QuestService.giveItem = originals.give;
    QuestService.takeItem = originals.take;
    QuestService.rewardAdena = originals.adena;
    QuestService.rewardExpSp = originals.exp;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
