'use strict';
// The cold worker resolves ordinary party hunts, which cast hunt buffs (F23) through PartyBuffLoadout.build;
// build looks up live summons. Inside the real worker module that lookup must stay within the boundary:
// SummonControl loads Network/Response and World at its top (2026-10-14: ~5.6 worker faults/s live).
const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');

const workerPath = path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
const workerCode = `
const { parentPort } = require('worker_threads');
require(${JSON.stringify(workerPath)});
const out = {};
try {
    const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
    const timestamp = 1750000000000;
    const member = (characterId, classId, role) => {
        const base = { characterId, name: 'Buff' + characterId, level: 40, activity: 'hunting',
            vitals: { hp: 2000, maxHp: 2000, mp: 1500, maxMp: 1500 }, stats: { classId }, inventory: {}, party: { role } };
        const snapshot = ColdCombatProfile.legacySnapshot(base, ColdCombatProfile.skillRecordsFromTree(classId, 40), timestamp);
        return { ...base, stats: { classId, coldCombat: { ...snapshot, effects: [] } } };
    };
    const result = BackgroundPartyResolver.resolve({
        party: { partyId: 'worker_hunt_buffs', cohesion: 1, risk: 0, roleCoverage: {}, stats: {} },
        members: [member(1, 17, 'buffer'), member(2, 1, 'tank'), member(3, 30, 'healer')],
        spot: { id: 'buff_field', name: 'Buff field', avgLevel: 1, density: 1, npcSelfIds: [],
            rewards: { exp: 10, sp: 2, adenaMin: 1, adenaMax: 1 }, mob: { hp: 100000, damage: 1 } },
        elapsedMs: 12000, timestamp, rng: () => 0.1
    });
    out.buffCasts = Number(result.debug?.partyBuffCasts || 0);
} catch (error) { out.error = String(error.stack || error).split('\\n').slice(0, 4).join(' | '); }
parentPort.postMessage({ probe: out });
process.exit(0);
`;

(async () => {
    const worker = new Worker(workerCode, { eval: true, name: 'cold-party-buff-boundary', workerData: { workerEpoch: 'test' } });
    const out = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('cold party buff boundary worker did not answer')), 30000);
        worker.on('message', value => { if (value?.probe) { clearTimeout(timeout); resolve(value.probe); } });
        worker.once('error', reject);
    });
    assert.strictEqual(out.error, undefined, `party hunt in the cold worker: ${out.error}`);
    assert.ok(out.buffCasts > 0, `the worker party cast no hunt buffs: ${JSON.stringify(out)}`);
    console.log(`cold worker party buff boundary ok (${out.buffCasts} casts)`);
})().catch(error => { console.error(error); process.exit(1); });
