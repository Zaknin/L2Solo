const assert = require('assert');
const Policy = require('../src/GameServer/Social/RevengePolicy');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const { ColdRevengeMonitor, MAX_ACTORS } = require('../src/GameServer/Bot/Population/ColdRevengeMonitor');
const { ColdCompetitionMonitor } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const at = 1800000000000;
const persona = { traits: { assertiveness: 1, caution: 0.1, empathy: 0.2, resilience: 0.2, commitment: 1 } };
const memory = new Memory();
function history(id, target, types, start = at) {
    let snapshot = P.empty(id);
    for (const [i, type] of types.entries()) snapshot = P.apply(snapshot, {
        key: `history:${id}:${i}`, sourceId: id, targetId: target, type, at: start }, start).snapshot;
    return snapshot;
}
memory.accept(history(1, 2, ['attacked', 'killed', 'killed']));
memory.accept(P.empty(2));
const assess = (when = at) => memory.assess({ id: 1 }, { id: 2 }, {}, when);
const social = assess(), chance = Policy.evaluate(social, persona).chance;
assert(chance > 0 && chance <= 0.35);
for (const absent of [undefined, null, {}, { traits: null }]) {
    assert.deepStrictEqual(Policy.evaluate(social, absent), Policy.evaluate(social, { traits: {} }),
        'an absent persona uses the existing neutral traits without losing a loaded grievance');
    assert.deepStrictEqual(Policy.evaluate({ ...social, ready: false }, absent), { chance: 0, reason: 'memory_unloaded' });
}
assert.deepStrictEqual(Policy.evaluate(social, persona), Policy.evaluate(social, JSON.parse(JSON.stringify(persona))),
    'normal traits do not depend on persona object identity');
assert.strictEqual(Policy.evaluate({ ...social, ready: false }, persona).chance, 0);
assert.strictEqual(Policy.evaluate({ ...social, affiliation: 'own' }, persona).chance, 0);
assert.strictEqual(Policy.evaluate({ ...social, personal: null, effective: social.personal }, persona).chance, 0,
    'collective hostility alone must not create a personal revenge campaign');
assert.strictEqual(Policy.evaluate(assess(at + 28 * 86400000), persona).chance, 0, 'old grievances cool down');
assert.strictEqual(Policy.evaluate({ ...social, effective: { ...social.personal, trust: 20, affinity: 20 } }, persona).chance, 0,
    'friendship and help can prevent revenge despite retained old hostile history');
assert(Policy.evaluate({ ...social, effective: { ...social.personal, fear: 30 } }, persona).chance < chance);
assert(Policy.evaluate({ ...social, clanSocial: { selfDiscipline: { stage: 'probation' } } }, persona).chance < chance);
assert(Policy.evaluate({ ...social, effective: { ...social.personal, hostility: 45, trust: -30 } }, persona).chance > chance);
const worker = new Memory();
worker.accept(JSON.parse(JSON.stringify(memory.snapshot(1))));
assert.deepStrictEqual(Policy.evaluate(worker.assess({ id: 1 }, { id: 2 }, {}, at), persona), Policy.evaluate(social, persona));
const entries = [1, 2].map(id => ({ state: { characterId: id, name: `Bot${id}`, phase: 'cold', activity: 'hunting',
    spotId: 'spot', loc: { locX: id * 10, locY: 0, locZ: 0 }, vitals: { hp: 100 }, stats: {}, simulation: { revision: 3 } } }));
const before = JSON.stringify(entries);
// The test override of the roll (() => 0) forces the outcome through the sampleActors seam.
const forced = (m, input, personaFor = () => persona, when = at) => m.sampleActors(input,
    id => input.find(e => e.state.characterId === id), memory, when, personaFor, () => 0);
const monitor = new ColdRevengeMonitor();
const events = forced(monitor, entries);
assert.strictEqual(events.length, 1, 'independent revenge does not require the same hunt objective or resource pressure');
assert.strictEqual(events[0].action, 'revenge');
assert.strictEqual(events[0].actor.id, 1);
assert.strictEqual(events[0].revengeRoll, 0);
const neutralEvents = forced(new ColdRevengeMonitor(), entries, () => ({ traits: {} }));
assert.strictEqual(neutralEvents.length, 1, 'missing-persona test reaches a real revenge decision');
for (const absent of [undefined, null, {}, { traits: null }]) {
    assert.deepStrictEqual(forced(new ColdRevengeMonitor(), entries, () => absent), neutralEvents,
        'native worker revenge uses the same fallback and preserves the accepted encounter');
}
assert.strictEqual(forced(monitor, entries, () => persona, at + 30000).length, 0, 'no repeated attempt each scan');
assert.strictEqual(JSON.stringify(entries), before, 'forecasts do not mutate physical state or memory');
const fresh = input => forced(new ColdRevengeMonitor(), input);
assert.strictEqual(fresh(entries.map(e => ({ ...e, state: { ...e.state, party: { partyId: 'same' } } }))).length, 0);
assert.strictEqual(fresh(entries.map(e => ({ ...e, state: { ...e.state, stats: { revengeUntil: at + 1 } } }))).length, 0);
assert.strictEqual(fresh(entries.map(e => ({ ...e, state: { ...e.state, loc: { ...e.state.loc, locX: e.state.characterId * 2000 } } }))).length, 0);
const bounded = new ColdRevengeMonitor();
bounded.sample(Array.from({ length: 2000 }, (_, i) => ({ ...entries[0], state: { ...entries[0].state, characterId: i + 100 } })), memory, at, () => persona);
assert.strictEqual(bounded.cursor, MAX_ACTORS, 'worker decision work has a fixed actor budget');
// Without the test override the roll is the grievance's own: one per (actor,
// peer, retry window), the same at any sample time inside the window.
const TendencyRoll = require('../src/GameServer/Bot/AI/TendencyRoll');
const unforced = t => new ColdRevengeMonitor().sampleActors(entries, id => entries.find(e => e.state.characterId === id),
    memory, t, () => persona).map(e => e.revengeRoll);
const ownRoll = TendencyRoll.roll('revenge', 1, 2, Math.floor(at / Policy.RETRY_MS));
const chanceOf = Policy.evaluate(memory.assess({ id: 1, clanId: 0, partyId: null }, { id: 2, clanId: 0, partyId: null }, {}, at), persona).chance;
assert.deepStrictEqual(unforced(at), ownRoll < chanceOf ? [ownRoll] : [], 'the roll is seeded by the grievance and its window');
assert.deepStrictEqual(unforced(at + 1000), unforced(at), 'a later sample in the same window reads the same roll');
// A grievance's roll does not depend on what other bots rolled before it in the
// same scan: other grievances placed first leave its roll as its own.
for (const [id, target] of [[3, 4], [5, 6]]) { memory.accept(history(id, target, ['attacked', 'killed', 'killed'])); memory.accept(P.empty(target)); }
const others = [3, 4, 5, 6].map(id => ({ ...entries[0], state: { ...entries[0].state, characterId: id, name: `Bot${id}`,
    loc: { locX: id * 10, locY: 0, locZ: 0 } } }));
let windowAt = at, firing = null;
for (let w = 0; w < 64 && !firing; w++, windowAt += Policy.RETRY_MS) {
    const own = TendencyRoll.roll('revenge', 1, 2, Math.floor(windowAt / Policy.RETRY_MS));
    if (own < Policy.evaluate(memory.assess({ id: 1, clanId: 0, partyId: null }, { id: 2, clanId: 0, partyId: null }, {}, windowAt), persona).chance) firing = own;
    else continue;
    const scan = input => {
        const m = new ColdCompetitionMonitor({ capacityForSpot: () => 100, personaFor: () => persona });
        m.sample(input, memory, windowAt - 30000); m.sample(input, memory, windowAt);
        return m.snapshot().events.filter(e => e.action === 'revenge' && e.actor.id === 1).map(e => e.revengeRoll);
    };
    assert.deepStrictEqual(scan(entries), [firing], 'the grievance fires on its own roll');
    assert.deepStrictEqual(scan([...others, ...entries]), [firing], 'grievances rolled before it leave its roll unchanged');
}
assert(firing !== null, 'a window where the grievance fires exists');
const slow = new ColdCompetitionMonitor({ capacityForSpot: () => 100, personaFor: () => persona });
const fast = new ColdCompetitionMonitor({ capacityForSpot: () => 100, personaFor: () => persona });
for (let t = at; t <= at + 120000; t += 1000) fast.sample(entries, memory, t);
for (let t = at; t <= at + 120000; t += 30000) slow.sample(entries, memory, t);
assert.deepStrictEqual(slow.snapshot(), fast.snapshot(), 'heartbeat frequency does not multiply revenge attempts');
console.log('Shared revenge policy: decay, reconciliation, fear, discipline, worker parity and bounded independent encounters passed');
