'use strict';
// L75 memo group: each reuse returns what a fresh calculation returns, and a
// changed input (rate, timestamp, state, option) is read again.
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();

// 1. TendencyRoll: the index-loop hash equals the for-of reference on any
// text (surrogate pairs, lone surrogates) and roll() equals the joined seed.
{
    const Tendency = invoke('GameServer/Bot/AI/TendencyRoll');
    const reference = seed => {
        let h = 2166136261;
        for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
        return () => { h += 0x6D2B79F5; let t = Math.imul(h ^ h >>> 15, 1 | h); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    };
    let r = 7;
    const next = () => { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return r; };
    const units = [0x41, 0x3A, 0xE9, 0x4E2D, 0xD83D, 0xDE00, 0xD800, 0xDBFF, 0xDC00, 0xDFFF, 0];
    const text = () => Array.from({ length: next() % 9 }, () => String.fromCharCode(next() % 3 ? units[next() % units.length] : next() % 0x10000)).join('');
    const part = () => [text, () => next() % 100000, () => (next() % 1000) / 7, () => null, () => undefined, () => true,
        () => ({ toString: () => 'o\uD83D' })][next() % 7]();
    for (let i = 0; i < 20000; i++) {
        const seed = text(), a = reference(seed), b = Tendency.seeded(seed);
        assert.deepEqual([b(), b(), b()], [a(), a(), a()], `seeded ${JSON.stringify(seed)}`);
        const parts = Array.from({ length: next() % 5 }, part);
        assert.equal(Tendency.roll(...parts), reference(parts.join(':'))(), 'roll equals the joined seed');
    }
    const iterable = ['ab', 'c'];
    assert.equal(Tendency.seeded(iterable)(), reference(iterable)(), 'a non-string seed keeps the for-of hash');
    assert.equal(Tendency.roll('spot-income', 123, 'spot_1'), reference('spot-income:123:spot_1')());
    console.log('PASS tendency roll: same seed hash and roll as the joined for-of reference');
}

// 2. One rate read per spot value: a rate change between calls (environment
// or an in-place [General] key) still reaches the table and the reward
// revision.
{
    const Rates = invoke('GameServer/ProgressionRates');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Rewards = invoke('GameServer/Bot/Economy/SpotRewardExpectation');
    const previous = process.env.L2NODE_PROGRESSION_RATE, adena = options.default.General?.adenaRate;
    try {
        process.env.L2NODE_PROGRESSION_RATE = 'x10';
        const row = Table.best('dps', 30, true, 'income');
        assert(row?.spotId, 'a dps spot at level 30');
        const x10 = Table.value(row.spotId, 'dps', 30, true);
        const revision = Rewards.revision();
        assert.equal(Rewards.revision(Rates.profile()), revision, 'the same profile keeps the revision');
        process.env.L2NODE_PROGRESSION_RATE = 'x1';
        const x1 = Table.value(row.spotId, 'dps', 30, true);
        assert.notEqual(Rewards.revision(), revision, 'a rate change opens a new reward revision');
        assert(x1.adena < x10.adena && x1.exp < x10.exp, 'x1 values below x10');
        options.default.General.adenaRate = Number(adena ?? 1) * 3;
        const tripled = Table.value(row.spotId, 'dps', 30, true);
        assert(tripled.adena > x1.adena, 'an in-place [General] rate change is read');
        options.default.General.adenaRate = adena;
        process.env.L2NODE_PROGRESSION_RATE = 'x10';
        assert.deepEqual(Table.value(row.spotId, 'dps', 30, true), x10, 'back at x10, the x10 value');
    } finally {
        if (previous === undefined) delete process.env.L2NODE_PROGRESSION_RATE; else process.env.L2NODE_PROGRESSION_RATE = previous;
        if (adena === undefined) delete options.default.General.adenaRate; else options.default.General.adenaRate = adena;
    }
    console.log('PASS rates: one read per spot value, runtime rate changes still read');
}

// 3. The profile scope of one economy build: one build per state and
// timestamp, equal to a fresh build, a private top-level copy per caller.
{
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const fixture = require('./fixtures/wish_spot_native_state.json');
    const timestamp = 1791335800000;
    const counted = () => {
        const state = structuredClone(fixture), stats = state.stats;
        let reads = 0;
        state.stats = new Proxy(stats, { get(target, key) { if (key === 'coldCombat') reads++; return target[key]; } });
        return { state, reads: () => reads };
    };
    const fresh = Profile.profileFor(structuredClone(fixture), timestamp);
    const probe = counted(); Profile.profileFor(probe.state, timestamp);
    const perBuild = probe.reads();
    assert(perBuild > 0, 'a build reads coldCombat');
    const { state, reads } = counted();
    const [first, second, third] = Profile.withProfileScope(state, () => [Profile.profileFor(state, timestamp),
        Profile.profileFor(state, timestamp), Profile.profileFor(state, timestamp)]);
    assert.deepEqual(first, fresh); assert.deepEqual(second, fresh); assert.deepEqual(third, fresh);
    assert.equal(reads(), perBuild, 'one build for three reads of the same state and timestamp');
    assert(first !== second && second !== third, 'each caller gets its own top-level object');

    const other = counted();
    Profile.withProfileScope(other.state, () => {
        const a = Profile.profileFor(other.state, timestamp);
        a.maxLoad = -1; a.cp = -1;
        const b = Profile.profileFor(other.state, timestamp);
        assert.equal(b.maxLoad, fresh.maxLoad, 'a caller writing its copy does not reach the next caller');
        assert.equal(b.cp, fresh.cp);
        const later = Profile.profileFor(other.state, timestamp + 60000);
        assert.deepEqual(later, Profile.profileFor(structuredClone(fixture), timestamp + 60000), 'another timestamp builds');
        Profile.profileFor(other.state, timestamp + 60000, { onNightRead: () => {} });
        const unscoped = structuredClone(fixture);
        assert.deepEqual(Profile.profileFor(unscoped, timestamp), fresh, 'another state builds');
    });
    assert.equal(other.reads(), 3 * perBuild, 'timestamp change and options rebuild; the repeat does not');

    // Outside the scope nothing is held: an in-place change is read.
    const outside = structuredClone(fixture);
    Profile.withProfileScope(outside, () => Profile.profileFor(outside, timestamp));
    outside.level = Number(outside.level) + 5;
    const levelled = Profile.profileFor(outside, timestamp);
    assert.equal(levelled.level, Number(fixture.level) + 5, 'after the build the state is read again');
    assert.notDeepEqual(levelled, fresh);

    // Nested builds keep their own scope and restore the outer one.
    const outer = counted(), inner = structuredClone(fixture);
    Profile.withProfileScope(outer.state, () => {
        Profile.profileFor(outer.state, timestamp);
        Profile.withProfileScope(inner, () => Profile.profileFor(inner, timestamp));
        Profile.profileFor(outer.state, timestamp);
    });
    assert.equal(outer.reads(), perBuild, 'the outer build is held across a nested build');
    console.log('PASS profile scope: one build per state and timestamp, fresh values, private copies');
}

// 4. EconomyContext.forState opens the scope for its own build: its readers
// share one profile (fewer coldCombat reads) and the result is the same.
{
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const original = Profile.withProfileScope;
    const build = bypass => {
        const state = structuredClone(require('./fixtures/wish_spot_native_state.json')), stats = state.stats;
        let reads = 0;
        state.stats = new Proxy(stats, { get(target, key) { if (key === 'coldCombat') reads++; return target[key]; } });
        if (bypass) Profile.withProfileScope = (_state, work) => work();
        try { return { economy: Economy.forState(state, { timestamp: 1791335800000, rememberContext: false }), reads }; }
        finally { Profile.withProfileScope = original; }
    };
    build(false); // warm the shared module caches so both builds below start equal
    const plain = build(true), scoped = build(false);
    assert.deepEqual(scoped.economy.statsPacket, plain.economy.statsPacket, 'the scope does not change the build');
    assert(scoped.reads < plain.reads, `the build's readers share one profile (${scoped.reads} < ${plain.reads} reads)`);
    console.log(`PASS economy build: forState shares one profile (${scoped.reads} vs ${plain.reads} coldCombat reads)`);
}
