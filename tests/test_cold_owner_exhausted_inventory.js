const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const id = 730093;

(async () => {
    const world = await createWorld([{ id, classId: 50, level: 27 }], 'exhausted-cold-inventory');
    try {
        await Life.init();
        for (const item of [{ selfId: 57, amount: 1000000 }, { selfId: 1463, amount: 2 },
            { selfId: 1060, amount: 1 }, { selfId: 17, amount: 20 }]) {
            await Database.setItem(id, { ...item, slot: 0 });
        }
        const inventory = Life.inventorySummaryFromItems(await Database.fetchItems(id));
        delete inventory[17]; // Physical items outside this projection are not owned by the proposal.
        const state = await Life.upsertState({ characterId: id, name: 'ExhaustedInventory',
            accountName: 'quests', phase: 'cold', activity: 'hunting', level: 27,
            exp: Number(DataCache.experience[26]), adena: 1000000, currentRegion: 'Elven Ruins',
            spotId: '6_41', inventory, stats: { classId: 50 },
            loc: { locX: 41691, locY: 247407, locZ: -6456 },
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }
        }, 'exhausted_inventory_fixture');
        const timestamp = Date.now();
        const token = await Owner.claim(state, { timestamp, leaseMs: 60000 });
        assert(token.ok);
        const nextState = { ...state, inventory: { ...state.inventory,
            1463: { ...state.inventory[1463], amount: 0 } } };
        delete nextState.inventory[1060];
        const entry = { revision: token.revision, nextState, proposal: { baseState: state } };
        const [result] = await Owner.commitBatch([entry], { timestamp: timestamp + 1 });
        assert(result.ok);
        assert.equal(await world.amount(id, 1463), 0, 'the last consumed shots must be removed physically');
        assert.equal(await world.amount(id, 1060), 0, 'a removed projected item must also be removed physically');
        assert.equal(await world.amount(id, 17), 20, 'items outside the proposal must survive');
        assert.equal(await world.amount(id, 57), 1000000, 'retained projected items must survive');
        const stored = JSON.parse((await Database.execute([
            'SELECT inventorySummary FROM bot_life_state WHERE characterId=?', [id]
        ]))[0].inventorySummary);
        assert.equal(stored[1463], undefined, 'persisted summaries must remain free of empty stacks');
        assert.equal(Life.cachedState(id).inventory[1463], undefined, 'cached summaries must remain canonical');

        // A new native stack cannot be deleted by replaying an already committed proposal.
        await Database.setItem(id, { selfId: 1463, amount: 8, slot: 0 });
        const [replay] = await Owner.commitBatch([entry], { timestamp: timestamp + 2 });
        assert.equal(replay.ok, false);
        assert.equal(await world.amount(id, 1463), 8, 'rejected proposals must not delete physical items');
        console.log('Cold owner exhausted inventory checks passed');
    } finally {
        await world.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
