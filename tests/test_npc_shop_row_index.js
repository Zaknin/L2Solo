const assert = require('assert');

require('../src/Global');

const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const DataCache = invoke('GameServer/DataCache');
const TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
DataCache.init();

function expectedRow(npcSelfId, selfId) {
    return NpcShopBuyLists.fetchForNpc(npcSelfId).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

const previousRate = process.env.L2NODE_PROGRESSION_RATE;
const indexedRow = NpcShopBuyLists.rowForNpc;
const cooper = TownServiceCatalog.rowsForTown('Giran', TownServiceCatalog.ROLES.SELLER)
    .find((row) => Number(row.npcSelfId) === 7829);
assert(cooper, 'consumer parity uses a real seller and origin');
function serviceSelections(reader, role, query) {
    NpcShopBuyLists.rowForNpc = reader;
    try {
        return {
            candidates: TownServiceCatalog.candidates(role, 'Giran', query),
            nearest: TownServiceCatalog.targetNear(role, query.from, query)
        };
    } finally { NpcShopBuyLists.rowForNpc = indexedRow; }
}
try {
    for (const rate of ['x1', 'x10', 'x50', 'x10']) {
        process.env.L2NODE_PROGRESSION_RATE = rate;
        let rows = 0;
        for (const npcSelfId of NpcShopBuyLists.npcIds()) {
            const list = NpcShopBuyLists.fetchForNpc(npcSelfId);
            for (const selfId of new Set(list.map((item) => Number(item.selfId)))) {
                assert.deepStrictEqual(NpcShopBuyLists.rowForNpc(npcSelfId, selfId), expectedRow(npcSelfId, selfId),
                    `row for item ${selfId} at NPC ${npcSelfId} (${rate})`);
                rows++;
            }
            assert.strictEqual(NpcShopBuyLists.rowForNpc(npcSelfId, -1), null);
        }
        assert(rows > 100, `the shop lists must have rows (${rate})`);
        // Pin both seller-presence consumers against their former list read,
        // using the actual service ordering and travel/exclusion rules.
        for (const role of [TownServiceCatalog.ROLES.SELLER, TownServiceCatalog.ROLES.GENERIC_MERCHANT]) {
            for (const selfId of [1, '2505', -1, 0]) {
                for (const exclusions of [[], ['7829']]) {
                    for (const maxDistance of [100, Infinity]) {
                        const query = { selfId, from: cooper, excludedNpcSelfIds: exclusions, maxDistance, worldSpawns: [] };
                        assert.deepStrictEqual(serviceSelections(indexedRow, role, query), serviceSelections(expectedRow, role, query),
                            `seller-presence selection for ${role}, item ${selfId}, rate ${rate}`);
                    }
                }
            }
        }
    }
    assert.strictEqual(NpcShopBuyLists.rowForNpc(-5, 57), null, 'an NPC without a shop has no rows');
    assert.strictEqual(NpcShopBuyLists.rowForNpc(undefined, 57), null);

    // Prices follow the progression rate.
    const [npcSelfId, row] = NpcShopBuyLists.npcIds().map((id) => [id, NpcShopBuyLists.fetchForNpc(id).find((item) => Number(item.price) > 100)])
        .find(([, item]) => item);
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    const cheap = NpcShopBuyLists.rowForNpc(npcSelfId, row.selfId).price;
    process.env.L2NODE_PROGRESSION_RATE = 'x50';
    assert(NpcShopBuyLists.rowForNpc(npcSelfId, row.selfId).price > cheap, 'a higher rate raises the NPC price');
} finally {
    if (previousRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = previousRate;
}

console.log('npc shop row index tests passed');
