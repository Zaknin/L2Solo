// A cold PvP encounter row says when the encounter runtime steps it next
// (its nextResolveAt), and the runtime's timer really steps it at that tick:
// with more fights running than a handful, and when a timer tick lands a few
// ms before a whole step since the last one.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
require('../src/GameServer/Bot/AI/TendencyRoll').roll = () => 0.49;
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Manager = invoke('GameServer/Bot/BotManager');
const Runtime = require('../src/GameServer/Bot/Population/PvpEncounterRuntime');
const Conflict = require('../src/GameServer/Bot/Population/ColdPartyConflict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-pvp-cadence-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const PAIRS = 6, ids = Array.from({ length: PAIRS * 2 }, (_, i) => i + 1);
const realNow = Date.now, realSessions = Manager.sessions;
let clock = realNow();
const base = { life: Life, owner: Owner, memory: Memory, parties: Parties, now: () => clock,
    personaFor: () => ({ traits: { empathy: 0, caution: 0, assertiveness: 1, commitment: 1, sociability: 1 } }),
    participantAllowed: () => true, contestContextAllowed: () => true, onState() {},
    pvpEnabled: () => true, incrementalPvp: true, onEncounter: Runtime.register, waitMs: 15000, cooldownMs: 600000, rng: () => 0.5 };
const actions = { ...base, canRun: () => true, recordPvpStep() {} };
function event(a, b) {
    const p = id => { const s = Life.cachedState(id); return { id, partyId: null, size: 1,
        revision: s.simulation.revision, memoryRevision: Memory.snapshot(id).revision }; };
    return { key: `cadence:${a}:${b}`, at: clock, pressure: 3, spotId: 'test', npcId: 10, actor: p(a), peer: p(b),
        action: 'contest', pvpIntent: true, willing: [true, true] };
}
async function persistedDue() {
    const rows = await DB.execute([`SELECT characterId, nextResolveAt FROM bot_life_state WHERE characterId <= ${ids.length} ORDER BY characterId`, []]);
    return rows.map(r => [r.characterId, Number(r.nextResolveAt)]);
}
async function main() {
    Date.now = () => clock;
    Manager.sessions = [];
    invoke('GameServer/DataCache').init(); DB.init();
    for (const id of ids) {
        // Untouchable fighters: every step leaves the fight going.
        const stats = { classId: 0, equipmentPlan: { status: 'active', next: { npcId: 10, spotId: 'test' } },
            coldCombat: { version: 1, classId: 0, cp: 2000, cpAt: clock,
                base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
                equipment: { weaponKind: 'Weapon.Sword', pAtk: 20, pAtkRnd: 0, mAtk: 10, atkSpd: 379,
                    critical: 0, accur: 50, pDef: 100000, mDef: 100000, evasion: 0 }, effects: [], skills: [] } };
        await DB.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_cad_${id}`, 'test']]);
        await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,hp,maxHp,mp,maxMp,cp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,40,1000,2000,300,1000,2000,0,0,0,0,0,0,0)`, [id, `bot_cad_${id}`, `Cadence${id}`]]);
        await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,lastResolvedAt,updatedAt,statsJson)
            VALUES (?,?,?,'cold','hunting','test',1000,2000,300,1000,40,?,?,?)`, [id, `bot_cad_${id}`, `Cadence${id}`, clock - 30000, clock, JSON.stringify(stats)]]);
    }
    await Life.init(); await Parties.init(); await Memory.ensureMany(ids);
    for (let i = 0; i < PAIRS; i++) {
        const started = await Conflict.apply({ ...base, event: event(ids[2 * i], ids[2 * i + 1]) });
        assert(started.ok && started.encounter, JSON.stringify(started));
    }
    assert.strictEqual(Runtime.encounters.size, PAIRS);

    // One step after the fights began, every row has come due: the timer
    // steps them all, not only the first few it holds.
    clock += 1000;
    await Runtime.tick(actions);
    assert.deepStrictEqual(await persistedDue(), ids.map(id => [id, clock + 1000]),
        'every encounter due at this tick is stepped by it; its row says the next step');
    assert.strictEqual(Life.coldDueSummary(clock).due, 0, 'no encounter bot is left past its stamp');

    // The interval timer drifts: a tick lands a few ms before a whole step
    // since the last one. The row's stamp is that tick's, so it steps now,
    // not a second later.
    clock += 1000 - 5;
    await Runtime.tick(actions);
    assert.deepStrictEqual(await persistedDue(), ids.map(id => [id, clock + 1000]),
        'the tick nearest an encounter stamp steps it');

    // A tick soon after a step does not step the encounter again.
    const stamped = await persistedDue();
    clock += 200;
    await Runtime.tick(actions);
    assert.deepStrictEqual(await persistedDue(), stamped, 'a fight just stepped waits for its stamp');

    // Main has room for only half the fights at a tick: the pass stops there,
    // and the fights it left go first at the next tick, though the ones it
    // stepped are due again by then too.
    const HALF = PAIRS / 2, roomFor = steps => { let done = 0;
        return { ...actions, canRun: () => done < steps, recordPvpStep() { done++; } }; };
    clock += 800;
    const before = clock;
    await Runtime.tick(roomFor(HALF));
    const first = (await persistedDue()).filter(([, due]) => due === clock + 1000).map(([id]) => id);
    assert.strictEqual(first.length, HALF * 2, 'the pass steps the fights main has room for');
    assert((await persistedDue()).every(([id, due]) => first.includes(id) || due === before),
        'the fights left wait at their stamp');
    clock += 1000;
    await Runtime.tick(roomFor(HALF));
    assert.deepStrictEqual(await persistedDue(), ids.map(id => [id, first.includes(id) ? before + 1000 : clock + 1000]),
        'the next tick steps the fights left first, the longest waiting');

    // A slow main: each step takes 60 ms of wall time. The pass stops at its
    // wall budget and leaves the rest for the next tick, though main has room.
    clock += 1000;
    const slow = { ...actions, recordPvpStep() { clock += 60; } }, due = clock;
    Runtime.passPeak();
    await Runtime.tick(slow);
    const stepped = (await persistedDue()).filter(([, at]) => at > due + 1000 - 1).length / 2;
    assert(stepped > 0 && stepped < PAIRS, `the wall budget stops the pass (stepped ${stepped} of ${PAIRS})`);
    assert.strictEqual(Runtime.passPeak().left, PAIRS - stepped, 'the status counts the due fights left');
    console.log(`PvP encounter cadence: ${PAIRS} cold fights stepped at their stamps`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await Memory.events.flush(); await DB.close();
    Date.now = realNow; Manager.sessions = realSessions;
    Runtime.encounters.clear(); fs.rmSync(dir, { recursive: true, force: true });
});
