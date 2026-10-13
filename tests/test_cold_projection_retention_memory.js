const assert = require('node:assert/strict');
const v8 = require('node:v8');
const vm = require('node:vm');
const { ColdProjectionRetention } = require('../src/GameServer/Bot/Population/ColdProjectionRetention');

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

// Two cold party members whose cached state objects are replaced every step,
// as accepted commits do. A projection keeps its party members' states for the
// identity check; a replaced member must not keep its own old projection, and
// with it the partner's older states, alive.
const current = new Map();
const party = { partyId: 7, leaderId: 1, memberIds: [1, 2] };
const retention = new ColdProjectionRetention({
    stateFor: id => current.get(id),
    epoch: () => 'epoch-1',
    dependencies: () => ({ partyGeneration: 1, catalog: null, physicalCatalog: null, pressure: [],
        memory: null, memoryRevision: undefined, party, clanId: 0, escrow: undefined, targetNpcId: undefined })
});
const history = [];

function step(characterId, revision) {
    const state = { characterId, phase: 'cold', activity: 'hunting', simulation: { revision },
        inventory: { items: [] }, stats: {}, vitals: { hp: 100, maxHp: 100 } };
    current.set(characterId, state);
    history.push(new WeakRef(state));
    const context = { party, isPartyLeader: characterId === 1,
        partyMembers: party.memberIds.map(id => current.get(id)).filter(Boolean) };
    retention.prepare(state, context, 1);
    assert.equal(retention.remember({ state, context }), true);
}

(async () => {
    current.set(2, { characterId: 2, phase: 'cold' });
    for (let revision = 1; revision <= 300; revision++) {
        step(1, revision);
        step(2, revision);
    }
    assert.equal(retention.get(2).ok, true, 'the latest projection with unchanged members replays');
    assert.equal(retention.get(1).reason, 'party_member_changed', 'a projection whose member moved on does not replay');

    await new Promise(resolve => setImmediate(resolve));
    gc();
    const alive = history.filter(ref => ref.deref()).length;
    assert.ok(alive <= 4, `historical party states retained after GC: ${alive} of ${history.length}`);

    step(2, 301);
    current.set(2, { ...current.get(2) });
    assert.equal(retention.get(2).reason, 'missing_projection', 'a replaced state without its own projection does not replay');
    current.delete(2);
    assert.equal(retention.get(2).reason, 'missing_state');
    retention.reset();
    assert.equal(retention.get(1).reason, 'missing_projection', 'reset drops every projection');
    console.log(`Cold projection retention memory tests passed (${alive} of ${history.length} states alive)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
