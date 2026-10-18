const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');

// E234: one failed buffered write must not poison the shared write chain.
// The failed snapshot goes back to the queue (fields merged since then win)
// and later flushes, and the work that waits on them, reach the database.
const originalApply = Database.applyBufferedCharacterState;
const originalApplyBatch = Database.applyBufferedCharacterStates;
const originalIsReady = Database.isReady;

const writes = [];
const failures = [];
let gate = null;
function attempt(record) {
    const failure = failures.shift();
    const run = () => {
        if (failure) return Promise.reject(new Error('injected buffered write failure'));
        writes.push(record);
        return Promise.resolve(record);
    };
    if (!gate) return run();
    const waiting = gate;
    gate = null;
    return waiting.then(run);
}
Database.applyBufferedCharacterState = (characterId, state) => attempt({ characterId, state: clone(state) });
Database.applyBufferedCharacterStates = (entries) => attempt({ batch: entries.map(([id, state]) => [id, clone(state)]) });
Database.isReady = () => true;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

async function rejects(promise, message) {
    await assert.rejects(promise, /injected buffered write failure/, message);
}

(async () => {
    // 1. A failed timer batch keeps its snapshot and the next flush writes it.
    CharacterWriteQueue.experience(50, 10, 100, 5);
    failures.push(true);
    await rejects(CharacterWriteQueue.flushAll(), 'the failed batch reports its error');
    assert.strictEqual(CharacterWriteQueue.pendingCount(), 1, 'a failed snapshot must stay queued for the next flush');
    await CharacterWriteQueue.flushAll();
    assert.deepStrictEqual(writes.pop(), {
        batch: [[50, { character: { level: 10, exp: 100, sp: 5 }, items: {} }]]
    }, 'the retried batch carries the failed snapshot');

    // 2. After a failure, another character's flush (the step before its
    // dependent transaction) reaches the database instead of the old error.
    CharacterWriteQueue.vitals(51, 10, 20, 30, 40);
    failures.push(true);
    await rejects(CharacterWriteQueue.flushCharacter(51));
    CharacterWriteQueue.itemAmount(52, 700, 3);
    let dependentRan = false;
    await CharacterWriteQueue.flushCharacter(52).then(() => { dependentRan = true; });
    assert.strictEqual(dependentRan, true, 'work waiting on a later flush must start');
    assert.deepStrictEqual(writes.pop(), {
        characterId: 52, state: { character: {}, items: { 700: { id: 700, amount: 3, delete: false } } }
    });
    await CharacterWriteQueue.flushAll();
    assert.deepStrictEqual(writes.pop(), {
        batch: [[51, { character: { hp: 10, maxHp: 20, mp: 30, maxMp: 40 }, items: {} }]]
    }, 'the failed single-character snapshot is retried');

    // 3. Fields merged after the failed snapshot was taken win over it.
    CharacterWriteQueue.location(53, { locX: 1, locY: 2, locZ: 3, head: 4 });
    CharacterWriteQueue.experience(53, 20, 200, 10);
    gate = Promise.resolve().then(() => {
        CharacterWriteQueue.location(53, { locX: 9, locY: 8, locZ: 7, head: 6 });
    });
    failures.push(true);
    await rejects(CharacterWriteQueue.flushCharacter(53));
    await CharacterWriteQueue.flushAll();
    assert.deepStrictEqual(writes.pop(), {
        batch: [[53, { character: { level: 20, exp: 200, sp: 10, locX: 9, locY: 8, locZ: 7, head: 6 }, items: {} }]]
    }, 'the retry keeps the newer location and the older experience');

    // 4. A newer snapshot already queued behind the failed one absorbs it, so
    // no stale retry runs after the newer write.
    let release;
    gate = new Promise((resolve) => { release = resolve; });
    failures.push(true);
    CharacterWriteQueue.location(54, { locX: 1, locY: 1, locZ: 1, head: 1 });
    CharacterWriteQueue.karma(54, 1, 0, 0);
    const first = CharacterWriteQueue.flushAll();
    CharacterWriteQueue.location(54, { locX: 5, locY: 5, locZ: 5, head: 5 });
    const second = CharacterWriteQueue.flushCharacter(54);
    release();
    await rejects(first);
    await second;
    assert.deepStrictEqual(writes.pop(), {
        characterId: 54,
        state: { character: { locX: 5, locY: 5, locZ: 5, head: 5, pvp: 1, pk: 0, karma: 0 }, items: {} }
    }, 'the newer queued write carries the failed fields under its own');
    assert.strictEqual(CharacterWriteQueue.pendingCount(), 0, 'no stale copy of the failed snapshot stays queued');

    // 5. A direct write that waits on the character's flush (Database
    // withCharacterFlush, e.g. updateItemAmount from Sell) while that
    // character's buffered write fails: the restored older snapshot is written
    // before the direct write, so the timer does not overwrite the newer value.
    gate = new Promise((resolve) => { release = resolve; });
    failures.push(true);
    CharacterWriteQueue.itemAmount(56, 7, 1000);
    const timerBatch = CharacterWriteQueue.flushAll();
    const sell = CharacterWriteQueue.flushCharacter(56).then(() => { writes.push({ direct: 56, amount: 1500 }); });
    release();
    await rejects(timerBatch);
    await sell;
    await CharacterWriteQueue.flushAll(); // the next flush timer tick
    assert.deepStrictEqual(writes.slice(-2), [
        { characterId: 56, state: { character: {}, items: { 7: { id: 7, amount: 1000, delete: false } } } },
        { direct: 56, amount: 1500 }
    ], 'the failed snapshot is retried before the dependent direct write, and not after it');
    assert.strictEqual(CharacterWriteQueue.pendingCount(), 0, 'no older snapshot is left to overwrite the direct write');

    // 6. The same wait under a lasting fault: the retry fails too and the
    // dependent work is refused, as when the flush itself fails.
    gate = new Promise((resolve) => { release = resolve; });
    failures.push(true, true);
    CharacterWriteQueue.itemAmount(57, 8, 10);
    const failingBatch = CharacterWriteQueue.flushAll();
    let refusedRan = false;
    const refused = CharacterWriteQueue.flushCharacter(57).then(() => { refusedRan = true; });
    release();
    await rejects(failingBatch);
    await rejects(refused, 'dependent work fails after one retry of a lasting fault');
    assert.strictEqual(refusedRan, false);
    assert.strictEqual(CharacterWriteQueue.pendingCount(), 1, 'the snapshot stays queued for the timer');
    await CharacterWriteQueue.flushAll();
    assert.strictEqual(CharacterWriteQueue.pendingCount(), 0);

    console.log('character write queue failure recovery ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Database.applyBufferedCharacterState = originalApply;
    Database.applyBufferedCharacterStates = originalApplyBatch;
    Database.isReady = originalIsReady;
});
