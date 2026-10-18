// E235: when the same account logs in again while its old connection is still
// open, the old character's status snapshot (vitals, effects, skill
// cooldowns) is written by the replacement itself. The old connection's own
// close runs later and must not write a second, staler snapshot.
const assert = require('assert');

require('../src/Global');

const Session = invoke('GameServer/Session');
const World = invoke('GameServer/World/World');
const Database = invoke('Database');
const BotSession = invoke('GameServer/Bot/BotSession');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const ServerResponse = invoke('GameServer/Network/Response');
const authLogin = invoke('GameServer/Network/Request/AuthLogin');

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

World.user = { sessions: [], revision: 0 };
const calls = [];
Database.updateCharacterStatus = async (id, record) => { calls.push({ kind: 'status', id, record }); };
Database.fetchCharacters = async (username) => { calls.push({ kind: 'list', username }); return []; };
ServerResponse.charSelectInfo = () => Buffer.from([0x13]);

function session(accountId) {
    const value = Object.create(Session.prototype);
    value.socket = { destroyed: false, write() {}, destroy() { this.destroyed = true; }, on() {} };
    value.accountId = accountId;
    return value;
}
const select = (value, id) => value.setActor({ id, name: `Char${id}`, classId: 0, items: [], paperdoll: {} });
const statusWrites = (from = 0) => calls.slice(from).filter((call) => call.kind === 'status');

function loginPacket(username) {
    const name = Buffer.from(`${username}\0`, 'ucs2');
    const keys = Buffer.alloc(8);
    return Buffer.concat([Buffer.from([0x08]), name, keys]);
}

(async () => {
    // Control: the only session of an account closes; its snapshot is written.
    const only = session('acc235c');
    only.setAccountId('acc235c');
    select(only, 350);
    let from = calls.length;
    only.error();
    await settle();
    assert.deepStrictEqual(statusWrites(from).map((call) => call.id), [350], 'a normal close writes the status snapshot');

    // Same account logs in again through the login packet while the old
    // connection is still open; the old close comes afterwards.
    const old = session('acc235');
    old.setAccountId('acc235');
    select(old, 351);
    EffectStore.apply(old.actor, {
        key: 'might', id: 1068, level: 3, type: 'buff', stats: { pAtkMul: 1.15 }, durationMs: 60000
    });
    const fresh = session('acc235');
    from = calls.length;
    authLogin(fresh, loginPacket('acc235'));
    assert.ok(old.socket.destroyed, 'the replacement closes the old connection');
    assert.ok(!World.user.sessions.includes(old), 'the old session is no longer the account session');
    const replaced = statusWrites(from);
    assert.deepStrictEqual(replaced.map((call) => call.id), [351], 'the replacement writes the old character status once');
    assert.deepStrictEqual(JSON.parse(replaced[0].record.effects).map((effect) => effect.key), ['might'],
        'the snapshot carries the effect applied since the last save');
    // Call order of the Database API only: the stub replaces the real
    // updateCharacterStatus, whose SQL is queued after the character flush.
    const order = calls.slice(from).map((call) => call.kind);
    assert.deepStrictEqual(order, ['status', 'list'], 'the snapshot is requested before the new session reads the list');

    from = calls.length;
    old.error();
    await settle();
    assert.deepStrictEqual(statusWrites(from), [], 'the old connection closing later writes no second snapshot');

    // An old session still on character selection has no character to save.
    const lobby = session('acc235l');
    lobby.setAccountId('acc235l');
    const lobbyFresh = session('acc235l');
    from = calls.length;
    lobbyFresh.setAccountId('acc235l');
    lobby.error();
    await settle();
    assert.ok(lobby.socket.destroyed, 'the lobby session is replaced');
    assert.deepStrictEqual(statusWrites(from), [], 'a replaced session without a character writes nothing');

    // A bot session found under the same account name is never written.
    const bot = new BotSession('bot_235');
    bot.setActor({ id: 352, name: 'Char352', classId: 0, items: [], paperdoll: {} });
    World.insertUser(bot);
    const claimant = session('bot_235');
    from = calls.length;
    claimant.setAccountId('bot_235');
    await settle();
    assert.deepStrictEqual(statusWrites(from), [], 'a replaced bot session writes no player status');

    console.log('Same-account replacement status checks passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
