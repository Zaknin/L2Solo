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
    const handle = { id: nextHandle++, unref() { return this; }, ref() { return this; } };
    timers.set(handle.id, { at: now + Math.max(0, Number(ms) || 0), fn, args });
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
const ServerResponse = invoke('GameServer/Network/Response');
const Generics = invoke(path.actor);

const PLAYER_ID = 2000001;
const STOP = ServerResponse.autoAttackStop(PLAYER_ID);

function player() {
    const session = { packets: [], dataSendToMeAndOthers(data) { this.packets.push(data); } };
    const actor = {
        state: new State(),
        session,
        hp: 1000,
        fetchId: () => PLAYER_ID,
        fetchHp() { return this.hp; },
        setHp(value) { this.hp = value; },
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        statusUpdateVitals() {},
        automation: { replenishVitals() {}, aborted: 0, abortAll() { this.aborted++; } }
    };
    session.actor = actor;
    return actor;
}

const mob = { fetchKind: () => 'Monster', fetchId: () => 1000001 };

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
    victim.state.setHits(true);
    advanceTo(15000);
    assert.strictEqual(stops(victim), 0, 'an own swing keeps the stance');
    victim.state.setHits(false);
    advanceTo(29999);
    assert.strictEqual(stops(victim), 0);
    advanceTo(30000);
    assert.strictEqual(stops(victim), 1, 'the stance ends 15 s after the swing was seen');
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

console.log('test_combat_stance: ok');
