// A player hit by a mob without hitting back leaves the combat stance 15 s
// after the last received hit (C4 AttackStanceTaskManager), also when someone
// else kills the mob.
const assert = require('assert');

require('../src/Global');

// Edge stub: the clock. Only timers due by the fake time run.
let now = 0;
let nextHandle = 1;
const timers = new Map();
global.setTimeout = (fn, ms, ...args) => {
    const delay = Math.max(0, Number(ms) || 0);
    const handle = {
        id: nextHandle++,
        unref() { return this; },
        ref() { return this; },
        refresh() { timers.set(this.id, { at: now + delay, fn, args }); return this; }
    };
    timers.set(handle.id, { at: now + delay, fn, args });
    return handle;
};
global.clearTimeout = (handle) => { if (handle) timers.delete(handle.id); };
function advanceTo(time) {
    for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
            if (timer.at <= time && (!due || timer.at < due.timer.at)) due = { id, timer };
        }
        if (!due) break;
        timers.delete(due.id);
        now = due.timer.at;
        due.timer.fn(...due.timer.args);
    }
    now = time;
}

const State = invoke('GameServer/Model/State');
const Attack = invoke('GameServer/Actor/Attack');
const Npc = invoke('GameServer/Npc/Npc');
const ServerResponse = invoke('GameServer/Network/Response');
const Generics = invoke(path.actor);

const PLAYER_ID = 2000001;
const STOP = ServerResponse.autoAttackStop(PLAYER_ID);
const ATTACK_PACKET_ID = 0x05; // C4 Attack: marks when a swing starts

function player() {
    const session = {
        persistenceMode: 'ephemeral',
        packets: [],
        swingsAt: [],
        messagesAt: [],
        dataSendToMe() { this.messagesAt.push(now); },
        dataSendToMeAndOthers(data) {
            this.packets.push(data);
            if (data[0] === ATTACK_PACKET_ID) this.swingsAt.push(now);
        }
    };
    const actor = {
        state: new State(),
        session,
        hp: 1000,
        fetchId: () => PLAYER_ID,
        fetchHp() { return this.hp; },
        setHp(value) { this.hp = value; },
        fetchMaxHp: () => 1000,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchRadius: () => 8,
        fetchCollectiveAtkSpd: () => 333,
        fetchCollectiveEvasion: () => 0,
        fetchPvpFlag: () => 0, fetchKarma: () => 0, setPvpFlag() {},
        isDead() { return this.state.fetchDead(); },
        statusUpdateVitals() {},
        backpack: { fetchTotalWeaponKind: () => 'Weapon.DualFist' },
        attack: new Attack(),
        automation: { replenishVitals() {}, aborted: 0, abortAll() { this.aborted++; }, scheduleAction() {} }
    };
    session.actor = actor;
    return actor;
}

const mob = { fetchKind: () => 'Monster', fetchId: () => 1000001 };

// A live mob next to the player for the player's own swings.
function standingMob() {
    return {
        state: new State(),
        fetchKind: () => 'Monster',
        fetchId: () => 1000002,
        x: 30,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchRadius: () => 10,
        fetchCollectiveEvasion: () => 0,
        isDead() { return this.state.fetchDead(); }
    };
}

// Edge stub: the roll. Near 1 every swing misses (no damage path).
const originalRandom = Math.random;
function withMisses(run) {
    Math.random = () => 0.999;
    try { run(); } finally { Math.random = originalRandom; }
}

function stops(actor) {
    return actor.session.packets.filter((data) => Buffer.compare(data, STOP) === 0).length;
}

function hit(actor, time) {
    advanceTo(time);
    Generics.receivedHit(actor.session, actor, 10, { source: mob });
}

{
    now = 0;
    const victim = player();
    hit(victim, 0);
    assert.strictEqual(victim.state.fetchCombats(), true, 'a received hit enters the stance');
    advanceTo(14999);
    assert.strictEqual(stops(victim), 0, 'the stance holds until 15 s after the hit');
    advanceTo(15000);
    assert.strictEqual(stops(victim), 1, 'the victim gets AutoAttackStop 15 s after the last hit');
    assert.strictEqual(victim.state.fetchCombats(), false);
    assert.strictEqual(victim.automation.aborted, 0, 'the stance end does not stop movement or actions');
}

{
    now = 0;
    const victim = player();
    hit(victim, 0);
    hit(victim, 10000);
    advanceTo(15000);
    assert.strictEqual(stops(victim), 0, 'a later hit extends the stance');
    advanceTo(24999);
    assert.strictEqual(stops(victim), 0);
    advanceTo(25000);
    assert.strictEqual(stops(victim), 1, 'the stance ends 15 s after the second hit');
}

{
    now = 0;
    const victim = player();
    hit(victim, 0);
    advanceTo(5000);
    Generics.abortCombatState(victim.session, victim);
    assert.strictEqual(stops(victim), 1, 'the killer path ends the stance');
    advanceTo(60000);
    assert.strictEqual(stops(victim), 1, 'the timer does not send a second stop');
}

{
    now = 0;
    const victim = player();
    hit(victim, 0);
    victim.session.actor = null; // logged out
    advanceTo(15000);
    assert.strictEqual(stops(victim), 0, 'no stop for an actor that left its session');
}

{
    // Stun, sleep, petrify and fake death drop the flag without a packet; the
    // client still shows the stance until the timer sends the stop.
    now = 0;
    const victim = player();
    hit(victim, 0);
    victim.state.setCombats(false);
    advanceTo(15000);
    assert.strictEqual(stops(victim), 1, 'a silently dropped stance still gets its AutoAttackStop');
}

{
    // The player fights back with its own swing loop until the mob runs out of
    // reach and the player does not chase; the stance ends 15 s after the last
    // own swing.
    now = 0;
    const victim = player();
    const target = standingMob();
    hit(victim, 0);
    withMisses(() => {
        advanceTo(1000);
        victim.attack.meleeHit(victim.session, target);
        advanceTo(30000);
        target.x = 2000; // out of reach: the next swing turns into a chase the player drops
        advanceTo(40000);
    });
    const swings = victim.session.swingsAt;
    assert(swings.length > 5 && swings[swings.length - 1] > 15000, 'the own swing loop ran past the first 15 s');
    const lastSwing = swings[swings.length - 1];
    advanceTo(lastSwing + 14999);
    assert.strictEqual(stops(victim), 0, 'no stop before 15 s after the last own swing');
    advanceTo(lastSwing + 15000);
    assert.strictEqual(stops(victim), 1, 'the stance ends 15 s after the last own swing');
}

{
    // A mob miss is an exchange too: hit at 0 s, miss at 10 s, stop at 25 s.
    now = 0;
    const victim = player();
    const attacker = new Npc(900000, {
        selfId: 900000, kind: 'Monster', name: 'Stance Test Mob', title: '', level: 1, hostile: true,
        str: 1, dex: 30, con: 1, int: 1, wit: 1, men: 1, pAtk: 100, pAtkRnd: 0, pDef: 100, mAtk: 100,
        mDef: 100, accur: 4.75, atkSpd: 253, castSpd: 333, atkRadius: 40, walk: 60, run: 120,
        maxHp: 100, maxMp: 100, revHp: 1, revMp: 1, corpseTime: 7, radius: 10, size: 20, weapon: 0,
        shield: 0, reuseTime: 0, exp: 0, sp: 0, locX: 20, locY: 0, locZ: 0, head: 0
    });
    hit(victim, 0);
    advanceTo(10000);
    withMisses(() => attacker.meleeHit(victim.session, attacker, victim));
    advanceTo(10000 + 5000); // the miss lands at its draw point, well before 15 s
    assert.strictEqual(stops(victim), 0, 'no stop 15 s after the hit when a mob missed since');
    // The miss lands at the swing's draw point, where the player gets its
    // "missed" message.
    const missAt = victim.session.messagesAt[victim.session.messagesAt.length - 1];
    assert(missAt > 10000 && missAt < 15000, 'the mob swing missed the player');
    advanceTo(missAt + 14999);
    assert.strictEqual(stops(victim), 0);
    advanceTo(missAt + 15000);
    assert.strictEqual(stops(victim), 1, 'the stance ends 15 s after the mob miss');
}

console.log('test_combat_stance: ok');
