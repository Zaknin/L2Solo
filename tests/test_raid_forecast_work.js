'use strict';
const assert = require('node:assert/strict');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Policy = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');
const fixture = require('./fixtures/raid_priority_world.json');
const byId = new Map(fixture.members.map(row => [row.characterId, { ...row,
    accountName: `bot_${row.characterId}`, phase: 'cold', party: {},
    stats: { ...row.stats, coldCombat: { ...row.captured,
        skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId, level]) => ({ selfId, level }))) } },
    inventory: Object.fromEntries(row.items.map(item => [item.selfId, item])) }]));
const roster = fixture.expected.map(id => byId.get(id));
const boss = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(`raid:${fixture.bossId}`);
const before = JSON.stringify(roster);
const resolve = Rules.resolve, cached = Rules.resolveCached;
let calls = 0;
const music = structuredClone(roster);
music[3].stats.classId = music[3].stats.coldCombat.classId = 21;
music[3].stats.coldCombat.skills = Combat.skillSnapshotsFromRecords([264, 267, 268].map(selfId => ({ selfId, level: 1 })));
const run = (members = roster) => {
    const preparation = Policy.prepared(members, fixture.at);
    return { preparation, assessment: Policy.assessment(members, boss,
        { timestamp: fixture.at, fundSupplies: true, preparation }) };
};
try {
    Rules.resolve = skill => { calls++; return resolve(skill); };
    Rules.resolveCached = skill => Rules.resolve(skill);
    const reference = [run(), run(music)], referenceCalls = calls;
    Rules.resolveCached = cached;
    run(); run(music); // The same finite rule cache used by a running worker.
    calls = 0;
    const actual = [run(), run(music)];
    assert.deepEqual(actual, reference,
        'cached rules preserve all prepared buffs, MP, timing, combat stats and admission criteria');
    assert(calls * 3 < referenceCalls,
        `preparation must avoid repeated rule expansion: ${calls} expansions versus ${referenceCalls}`);
    assert.equal(JSON.stringify(roster), before, 'shared semantics never leak mutations into the next forecast');
    assert(actual[1].preparation.states.some(s => s.stats.coldCombat.effects.some(e => e.id === 264)),
        'equivalence includes actual music casts and their effects');
    const changed = structuredClone(roster);
    changed[1].stats.coldCombat.skills = changed[1].stats.coldCombat.skills.filter(s => s.selfId !== 1068);
    changed[2].stats.coldCombat.skills = changed[2].stats.coldCombat.skills.filter(s => s.selfId !== 1068);
    assert.equal(Policy.assessment(changed, boss, { timestamp: fixture.at, fundSupplies: true }).ready, false,
        'a warmed rule cache cannot retain a removed learned party skill');
    console.log(`Raid preparation equivalence and reduced rule expansion passed (${calls}/${referenceCalls})`);
} finally { Rules.resolve = resolve; Rules.resolveCached = cached; }
