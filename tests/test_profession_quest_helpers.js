const assert = require("assert");

require("../src/Global");

// U48: the hand-written profession quests share a collect step (Q401, Q406,
// Q408) and an exchange step (Q404, Q405). Pin the drop chance threshold,
// the default chance of Q401 and the partial-exchange behaviour on a failed
// take, so a shared helper keeps them exactly.
const QuestService = invoke("GameServer/Quest/QuestService");
const Q401 = require("../src/GameServer/Quest/quests/Q401_PathToWarrior");
const Q404 = require("../src/GameServer/Quest/quests/Q404_PathToWizard");
const Q405 = require("../src/GameServer/Quest/quests/Q405_PathToCleric");
const Q406 = require("../src/GameServer/Quest/quests/Q406_PathToElvenKnight");
const Q408 = require("../src/GameServer/Quest/quests/Q408_PathToElvenWizard");

const MIDDLE = "ItemSound.quest_middle";
const ITEM = "ItemSound.quest_itemget";

function harness() {
  const items = new Map();
  const sounds = [];
  const calls = [];
  let failTake = 0;
  const state = {
    session: {
      actor: {
        fetchClassId: () => 0,
        fetchLevel: () => 20,
        backpack: {
          fetchItemFromSelfId: (id) => {
            const amount = items.get(id) || 0;
            return amount ? { fetchAmount: () => amount } : null;
          },
          fetchPaperdollSelfId: () => 1142,
        },
      },
    },
    isStarted: () => true,
    isCompleted: () => false,
    cond: 0,
    values: {},
    getInt: (key) => key === "cond" ? state.cond : Number(state.values[key]) || 0,
    setState: async () => {},
    set: async (key, value) => { if (key === "cond") state.cond = Number(value); else state.values[key] = value; },
    exit: async () => {},
    playSound: (sound) => sounds.push(sound),
  };
  QuestService.giveItem = async (session, id, amount) => {
    calls.push(["give", id, amount]);
    items.set(id, (items.get(id) || 0) + amount);
  };
  QuestService.takeItem = async (session, id, amount = 1) => {
    calls.push(["take", id, amount]);
    if (id === failTake) return false;
    const current = items.get(id) || 0;
    if (current < amount) return false;
    items.set(id, current - amount);
    return true;
  };
  return { items, sounds, calls, state, failOn: (id) => { failTake = id; } };
}

async function withRandom(value, run) {
  const original = Math.random;
  Math.random = () => value;
  try { return await run(); } finally { Math.random = original; }
}

async function main() {
  const originals = { give: QuestService.giveItem, take: QuestService.takeItem };
  try {
    // Q406 Topaz: chance 0.7, a roll at the threshold drops nothing.
    let h = harness();
    h.state.cond = 1;
    await withRandom(0.7, () => Q406.onKill(h.state, { fetchSelfId: () => 35 }));
    assert.strictEqual(h.items.get(1205) || 0, 0, "a roll equal to the chance drops nothing");
    assert.deepStrictEqual(h.sounds, []);
    await withRandom(0.69, () => Q406.onKill(h.state, { fetchSelfId: () => 35 }));
    assert.strictEqual(h.items.get(1205), QuestService.questDropAmount(1, 20, 0), "a roll under the chance drops");
    assert.deepStrictEqual(h.sounds, [ITEM]);
    h.items.set(1205, 20);
    await withRandom(0, () => Q406.onKill(h.state, { fetchSelfId: () => 35 }));
    assert.strictEqual(h.items.get(1205), 20, "a full stack drops nothing more");
    assert.strictEqual(h.state.cond, 1, "an already full stack does not advance the step");

    // Q406 last piece completes the step.
    h = harness();
    h.state.cond = 1;
    h.items.set(1205, 19);
    await withRandom(0, () => Q406.onKill(h.state, { fetchSelfId: () => 35 }));
    assert.strictEqual(h.items.get(1205), 20);
    assert.strictEqual(h.state.cond, 2);
    assert.deepStrictEqual(h.sounds, [MIDDLE]);

    // Q408 Gold Leaves: chance 0.4.
    h = harness();
    h.items.set(1273, 1);
    await withRandom(0.4, () => Q408.onKill(h.state, { fetchSelfId: () => 19 }));
    assert.strictEqual(h.items.get(1223) || 0, 0);
    h.items.set(1223, 4);
    await withRandom(0.39, () => Q408.onKill(h.state, { fetchSelfId: () => 19 }));
    assert.strictEqual(h.items.get(1223), 5);
    assert.deepStrictEqual(h.sounds, [MIDDLE]);

    // Q401 spider legs: no chance argument, so any roll drops.
    h = harness();
    h.state.cond = 5;
    h.items.set(1142, 1);
    h.items.set(1144, 0);
    await withRandom(0.9999, () => Q401.onKill(h.state, { fetchSelfId: () => 38 }));
    assert.strictEqual(h.items.get(1144), QuestService.questDropAmount(1, 20, 0), "Q401 spider legs drop on every roll");

    // Q404 exchange: a failed second take keeps the first take, gives nothing,
    // keeps the step and plays no sound.
    h = harness();
    h.state.cond = 3;
    h.items.set(1280, 1);
    h.items.set(1281, 1);
    h.failOn(1281);
    await Q404.onTalk(h.state, { fetchSelfId: () => 7411 });
    assert.deepStrictEqual(h.calls, [["take", 1280, 1], ["take", 1281, 1]]);
    assert.strictEqual(h.items.get(1280), 0);
    assert.strictEqual(h.items.get(1282) || 0, 0);
    assert.strictEqual(h.state.cond, 3);
    assert.deepStrictEqual(h.sounds, []);

    // Q404 exchange success: takes in order, gives one, sets the step, middle sound.
    h = harness();
    h.state.cond = 3;
    h.items.set(1280, 1);
    h.items.set(1281, 1);
    await Q404.onTalk(h.state, { fetchSelfId: () => 7411 });
    assert.deepStrictEqual(h.calls, [["take", 1280, 1], ["take", 1281, 1], ["give", 1282, 1]]);
    assert.strictEqual(h.state.cond, 4);
    assert.deepStrictEqual(h.sounds, [MIDDLE]);

    // Q405 replace at Lionel: same contract.
    h = harness();
    h.state.cond = 5;
    h.items.set(1192, 1);
    h.items.set(1197, 1);
    h.failOn(1197);
    await Q405.onTalk(h.state, { fetchSelfId: () => 7408 });
    assert.deepStrictEqual(h.calls, [["take", 1197, 1]]);
    assert.strictEqual(h.items.get(1200) || 0, 0);
    assert.strictEqual(h.state.cond, 5);
    assert.deepStrictEqual(h.sounds, []);
    h.failOn(0);
    h.calls.length = 0;
    await Q405.onTalk(h.state, { fetchSelfId: () => 7408 });
    assert.deepStrictEqual(h.calls, [["take", 1197, 1], ["give", 1200, 1]]);
    assert.strictEqual(h.state.cond, 6);
    assert.deepStrictEqual(h.sounds, [MIDDLE]);
  } finally {
    QuestService.giveItem = originals.give;
    QuestService.takeItem = originals.take;
  }
  console.log("Profession quest helper checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
