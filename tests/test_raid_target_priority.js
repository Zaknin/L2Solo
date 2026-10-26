'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Priority = require('../src/GameServer/Bot/Population/RaidRosterPriority');
const Items = require('../src/GameServer/Item/ItemTemplateIndex');
const Minions = require('../data/Npcs/Minions/c4_raid_bosses.json');
const templates = invoke('GameServer/DataCache').npcs;
const score = id => Priority.targetScore({ raidBossTemplateId: id });
const profile = id => Combat.npcCombatStats(Items.find(templates, id));
const before = JSON.stringify(Minions);
const kraven = profile(10418), golem = profile(10431);
assert.equal(kraven.maxHp * kraven.pDef * kraven.pAtk * kraven.atkSpd,
    golem.maxHp * golem.pDef * golem.pAtk * golem.atkSpd, 'the old boss-only scores tie');
assert(score(10431) < score(10418), 'the golem with weaker guards must rank ahead of Kraven');
assert(score(10394) < score(10170), 'guardless Premo ranks ahead of the smaller boss with dangerous archers');
const premo = profile(10394);
assert.equal(score(10394), premo.maxHp * premo.pDef * premo.pAtk * premo.atkSpd,
    'guardless bosses retain the original hint');

const native = Combat.npcCombatStats;
try {
    // This native encounter has two guard types, each spawning 1..2 actors.
    // Identical small profiles make omitting either group or using min visible.
    const p = profile(10176);
    Combat.npcCombatStats = npc => [10177, 10178].includes(npc.selfId)
        ? { maxHp: 10, pDef: 10, pAtk: 5, atkSpd: 4 } : native(npc);
    assert.equal(score(10176), (p.maxHp * p.pDef + 400) * (p.pAtk * p.atkSpd + 80),
        'both guard types count at the maximum native spawn size');
    Combat.npcCombatStats = npc => {
        const p = native(npc);
        return npc.selfId === 10432 ? { ...p, maxHp: p.maxHp * 2, pAtk: p.pAtk * 2 } : p;
    };
    const strongerGuards = score(10431);
    Combat.npcCombatStats = native;
    assert(strongerGuards > score(10431), 'guard changes affect ordering without a stale score cache');
    assert.equal(score(-1), Infinity, 'missing bosses are never preferred');
    const find = Items.find;
    try {
        Items.find = (rows, id) => Number(id) === 10432 ? undefined : find(rows, id);
        assert.equal(score(10431), Infinity, 'incomplete guard data cannot look easier');
    } finally { Items.find = find; }
} finally { Combat.npcCombatStats = native; }
assert.equal(JSON.stringify(Minions), before, 'target ordering never changes authored guard groups');
console.log('Native guard pressure, durability, counts and guardless raid target ordering passed');
