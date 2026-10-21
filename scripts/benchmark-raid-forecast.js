#!/usr/bin/env node
'use strict';

// Frozen x50 roster: CPU time of a complete forecast, without live SQL,
// purchases, actors or scheduler work. Run with: node scripts/benchmark-raid-forecast.js
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('../tests/helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init({ validate: false });
const assert = require('node:assert/strict');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Policy = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');
const { LIMITS } = require('../src/GameServer/Bot/Population/RaidSearchCounters');
const fixture = require('../tests/fixtures/raid_priority_world.json');
const byId = new Map(fixture.members.map(row => [row.characterId, { ...row,
    accountName: `bot_${row.characterId}`, phase: 'cold', party: {},
    stats: { ...row.stats, coldCombat: { ...row.captured,
        skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId, level]) => ({ selfId, level }))) } },
    inventory: Object.fromEntries(row.items.map(item => [item.selfId, item])) }]));
const roster = fixture.expected.map(id => byId.get(id));
const boss = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(`raid:${fixture.bossId}`);
const before = JSON.stringify(roster);
const forecast = () => Policy.assessment(roster, boss, { timestamp: fixture.at, fundSupplies: true });
const cpuScope = typeof process.threadCpuUsage === 'function' ? 'thread' : 'process';
const cpuUsage = cpuScope === 'thread' ? process.threadCpuUsage.bind(process) : process.cpuUsage.bind(process);
for (let i = 0; i < 25; i++) forecast();
const batches = [], cpu = cpuUsage();
let result;
for (let batch = 0; batch < 9; batch++) {
    const start = cpuUsage();
    for (let i = 0; i < 20; i++) result = forecast();
    const used = cpuUsage(start);
    batches.push((used.user + used.system) / 1000 / 20);
}
const used = cpuUsage(cpu);
batches.sort((a, b) => a - b);
assert(result.ready, JSON.stringify(result.reasons));
assert.equal(JSON.stringify(roster), before);
console.log(JSON.stringify({ node: process.version, cpuScope, forecasts: 180, medianCpuMs: batches[4],
    minCpuMs: batches[0], maxCpuMs: batches[8], totalCpuMs: (used.user + used.system) / 1000,
    fightSeconds: result.seconds, healing: result.healing, limits: LIMITS }, null, 2));
