const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
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
        const nextState = { ...state, inventory: { ...state.inventory,
            1463: { ...state.inventory[1463], amount: 0 } } };
        delete nextState.inventory[1060];
        // No base bag travels with a proposal: the step's emptied stacks reach
        // the commit as their own field.
        const entry = { revision: state.simulation.revision, nextState,
            proposal: InventorySummary.bagChange(state.inventory, nextState.inventory) };
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

        // No base bag travels: the step's own flag says whether the bag moved.
        // A step that left the bag as it was does not touch the physical rows,
        // even where they disagree with its summary (a trade moved them since).
        await Database.setItem(id, { selfId: 57, amount: 5, slot: 0 });
        const drifted = await world.amount(id, 57);
        const kept = Life.cachedState(id);
        const [quiet] = await Owner.commitBatch([{ revision: kept.simulation.revision, nextState: { ...kept },
            proposal: InventorySummary.bagChange(kept.inventory, kept.inventory) }], { timestamp: timestamp + 3 });
        assert(quiet.ok);
        assert.equal(await world.amount(id, 57), drifted, 'an unchanged bag must not rewrite the physical items');
        // A step that moved the bag writes it.
        const moved = Life.cachedState(id);
        const movedState = { ...moved, inventory: { ...moved.inventory, 57: { ...moved.inventory[57], amount: 700 } } };
        const [write] = await Owner.commitBatch([{ revision: moved.simulation.revision, nextState: movedState,
            proposal: InventorySummary.bagChange(moved.inventory, movedState.inventory) }], { timestamp: timestamp + 4 });
        assert(write.ok);
        assert.equal(await world.amount(id, 57), 700, 'a changed bag must be written physically');
        console.log('Cold owner exhausted inventory checks passed');
    } finally {
        await world.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
