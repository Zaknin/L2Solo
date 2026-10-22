'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Policy = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');

const skills = ids => Combat.skillSnapshotsFromRecords(ids.map(selfId => ({ selfId, level: 1 })));
function member(characterId, classId, learned = []) {
    return { characterId, level: 49, clanId: 0,
        stats: { classId, coldCombat: { classId, skills: skills(learned) } } };
}
const party = [member(1, 20, [28]), member(2, 52, [1229, 1007, 1009]), member(3, 51, [1229]),
    ...Array.from({ length: 6 }, (_, i) => member(i + 4, 55))];
const before = JSON.stringify(party);
assert(Policy.composition(party).ready,
    'learned party chants supply physical attack and defense without the individual Might/Shield IDs');
assert.equal(JSON.stringify(party), before, 'composition does not cast buffs or change learned skills');

const individual = structuredClone(party);
individual[1].stats.coldCombat.skills = skills([1229, 1068, 1040]);
assert(Policy.composition(individual).ready, 'ordinary individual buffs still cover the whole party');
const mixed = structuredClone(party);
mixed[1].stats.coldCombat.skills = skills([1229, 1007]);
mixed[2].stats.coldCombat.skills = skills([1229, 1040]);
assert(Policy.composition(mixed).ready, 'different providers and native buff types can complete the package');

for (const missing of [1007, 1009]) {
    const unlearned = structuredClone(party);
    unlearned[1].stats.coldCombat.skills = unlearned[1].stats.coldCombat.skills.filter(s => s.selfId !== missing);
    assert(!Policy.composition(unlearned).ready, 'class eligibility and a warm cache cannot supply an unlearned chant');
}
const passive = structuredClone(individual);
passive[1].stats.coldCombat.skills.filter(s => [1068, 1040].includes(s.selfId)).forEach(s => { s.passive = true; });
assert(!Policy.composition(passive).ready, 'passive records cannot supply castable buffs');

const clan = structuredClone(party);
clan[1].stats.coldCombat.skills = skills([1229, 1003, 1005]);
assert(!Policy.composition(clan).ready, 'clanless characters cannot share Paagrio clan buffs');
clan.forEach(s => { s.clanId = 7; });
assert(Policy.composition(clan).ready, 'Paagrio buffs cover a complete same-clan roster');
clan[8].clanId = 8;
assert(!Policy.composition(clan).ready, 'buffing the tank alone does not cover a foreign-clan damage dealer');
clan[8].clanId = 7; clan[2].clanId = 8;
assert(!Policy.composition(clan).ready, 'foreign-clan support also needs access to the required buffs');
clan[2].stats.coldCombat.skills = skills([1229, 1003, 1005]);
assert(Policy.composition(clan).ready, 'complementary clan providers can cover their respective recipients');
clan.forEach(s => { s.stats.clanId = s.clanId; delete s.clanId; });
assert(Policy.composition(clan).ready, 'saved clan membership has the same recipient rules');

const noTank = structuredClone(party); noTank[0].stats.coldCombat.skills = [];
assert(!Policy.composition(noTank).ready, 'recognizing chants never bypasses learned tank aggression');
assert(!Policy.composition(party.slice(0, 8)).ready, 'the fixed nine-member composition is retained');

const fixture = require('./fixtures/raid_priority_world.json');
const byId = new Map(fixture.members.map(row => [row.characterId, { ...row,
    stats: { ...row.stats, coldCombat: { ...row.captured,
        skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId, level]) => ({ selfId, level }))) } },
    inventory: Object.fromEntries(row.items.map(item => [item.selfId, item])) }]));
const forecastParty = fixture.expected.map(id => byId.get(id));
const [overlord, warcryer] = forecastParty.slice(1, 3);
for (const [state, classId, records] of [[overlord, 51, [[1229, 4], [1003, 3], [1005, 3]]],
    [warcryer, 52, [[1229, 4], [1007, 1], [1009, 1]]]]) {
    state.stats.classId = state.stats.coldCombat.classId = classId;
    delete state.stats.coldCombat.base;
    state.stats.coldCombat.skills = Combat.skillSnapshotsFromRecords(records.map(([selfId, level]) => ({ selfId, level })));
}
forecastParty.forEach(s => { s.clanId = 0; });
overlord.clanId = forecastParty[0].clanId = 7;
assert(Policy.composition(forecastParty).ready, 'party chants cover the recipients outside the Overlord clan');
const physicalBefore = JSON.stringify(forecastParty);
const preparation = Policy.prepared(forecastParty, fixture.at);
assert(preparation.ready);
for (const state of preparation.states) {
    const effects = state.stats.coldCombat.effects;
    const sameClan = state.clanId === 7;
    assert.equal(effects.some(e => e.id === 1003), sameClan,
        'forecast Paagrio attack buffs must reach exactly the native clan recipients');
    assert.equal(effects.some(e => e.id === 1005), sameClan,
        'forecast Paagrio defense buffs must not inflate a foreign-clan fighter');
}
assert.equal(JSON.stringify(forecastParty), physicalBefore, 'recipient planning preserves the physical roster');
const partyOnly = structuredClone(forecastParty);
partyOnly[1].stats.coldCombat.skills = skills([1229]);
const partyPreparation = Policy.prepared(partyOnly, fixture.at);
assert(partyPreparation.ready && partyPreparation.states.every(state =>
    state.stats.coldCombat.effects.some(e => e.id === 1007)
    && state.stats.coldCombat.effects.some(e => e.id === 1009)),
    'party chants still reach the complete mixed-clan roster during actual preparation');
console.log('Raid buff families, learned chants and complete native recipient coverage passed');
