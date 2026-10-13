const assert = require('assert');

require('../src/Global');

// The Clan Manager's "Level Up" (NpcBypasses/Clan) spends the leader's SP and
// Adena, then writes the new clan level. A failed level write must reach the
// handler's existing log and failure page instead of rejecting unhandled
// (Node 22 ends the server on an unhandled rejection).
const Clan = invoke('GameServer/World/Generics/NpcBypasses/Clan');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanSocialRuntime = invoke('GameServer/Clan/ClanSocialRuntime');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

// Counted only in this test: the server itself has no such listener.
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error?.message || String(error)));

const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

function actorFixture(id, clanId) {
    let sp = 100000;
    let cash = 2000000;
    const coin = { fetchId: () => 101, fetchSelfId: () => 57, fetchAmount: () => cash, setAmount: (n) => { cash = n; } };
    const backpack = {
        items: [coin],
        fetchItems() { return this.items; },
        fetchItemFromSelfId: (selfId) => (Number(selfId) === 57 ? coin : null),
        // Like Actor/Backpack.deleteItem: memory first, callback, write buffered.
        deleteItem(session, objectId, amount, callback) { coin.setAmount(coin.fetchAmount() - amount); callback(57); }
    };
    return {
        backpack,
        fetchId: () => id, fetchName: () => `Leader${id}`, fetchClanId: () => clanId, setClanId: (n) => { clanId = n; },
        fetchClanPrivileges: () => 2047, setClanPrivileges() {}, fetchTitle: () => '', setTitle() {},
        fetchLevel: () => 40, fetchClassId: () => 0, fetchExp: () => 1000, fetchSp: () => sp, setSp: (n) => { sp = n; },
        fetchIsOnline: () => true, isDead: () => false
    };
}

async function fixture({ holdSp = false } = {}) {
    const actor = actorFixture(4600001, 77);
    const pages = [];
    const said = [];
    const warnings = [];
    const spWrites = [];
    const levelWrites = [];
    const releaseSp = [];
    const session = { accountId: 'human', actor, dataSendToMe(packet) { if (packet?.page) pages.push(packet.page); if (packet?.said) said.push(packet.said); } };
    World.user = { sessions: [session] };
    Database.fetchClans = async () => [{ id: 77, name: 'Fixture', level: 0, leaderId: 4600001 }];
    Database.fetchClanCharacters = async () => [{ id: 4600001, clanId: 77, name: 'Leader4600001' }];
    Database.updateCharacterExperience = (id, level, exp, sp) => {
        spWrites.push(sp);
        return holdSp ? new Promise((resolve) => releaseSp.push(resolve)) : Promise.resolve();
    };
    Database.updateClanLevel = async (clanId, level) => { levelWrites.push(level); };
    utils.infoWarn = (...args) => warnings.push(args);
    await ClanService.reload();
    return { session, actor, pages, said, warnings, spWrites, levelWrites, releaseSp, clan: ClanService.findById(77) };
}

async function main() {
    const original = {
        fetchClans: Database.fetchClans,
        fetchClanCharacters: Database.fetchClanCharacters,
        updateCharacterExperience: Database.updateCharacterExperience,
        updateClanLevel: Database.updateClanLevel,
        infoWarn: utils.infoWarn,
        syncMemberships: ClanSocialRuntime.syncMemberships,
        user: World.user,
        npcHtml: ServerResponse.npcHtml,
        speak: ServerResponse.speak,
        pledgeShowInfoUpdate: ServerResponse.pledgeShowInfoUpdate,
        statusUpdate: ServerResponse.statusUpdate,
        userInfo: ServerResponse.userInfo
    };
    ClanSocialRuntime.syncMemberships = () => {};
    ServerResponse.npcHtml = (_, body) => ({ page: body });
    ServerResponse.speak = (_, payload) => ({ said: payload.text });
    ServerResponse.pledgeShowInfoUpdate = () => ({});
    ServerResponse.statusUpdate = () => ({});
    ServerResponse.userInfo = () => ({});
    try {
        // A failed level write is logged and answered by the existing failure page.
        const failed = await fixture();
        Database.updateClanLevel = async () => { throw new Error('injected level write failure'); };
        const startUnhandled = unhandled.length;
        await Clan(failed.session, ['clan', 'level-up']);
        await ticks();
        assert.deepStrictEqual(unhandled.slice(startUnhandled), [], 'a failed level write must not reject unhandled');
        assert.strictEqual(failed.warnings.filter((args) => args[0] === 'Clan').length, 1, 'a failed level write is logged by the handler');
        assert(failed.pages.some((page) => page.includes('Failed to increase clan level.')), 'the leader sees the existing failure page');
        assert(!failed.said.some((text) => text.startsWith('Clan level increased')), 'no success message for a failed level write');

        // Success is unchanged: one charge, level 1, success message.
        const ok = await fixture();
        await Clan(ok.session, ['clan', 'level-up']);
        await ticks();
        assert.deepStrictEqual(unhandled, []);
        assert.strictEqual(ok.warnings.length, 0);
        assert.strictEqual(ok.clan.level, 1);
        assert.deepStrictEqual(ok.levelWrites, [1]);
        assert.strictEqual(ok.actor.fetchSp(), 70000);
        assert.strictEqual(ok.actor.backpack.fetchItemFromSelfId(57).fetchAmount(), 1350000);
        assert(ok.said.includes('Clan level increased to 1.'), 'the leader sees the success message');

        // A second request while the first is still paying is ignored, as on
        // the 3->4 path: one charge and one level write for one level.
        const repeat = await fixture({ holdSp: true });
        const first = Clan(repeat.session, ['clan', 'level-up']);
        const second = Clan(repeat.session, ['clan', 'level-up']);
        repeat.releaseSp.forEach((resolve) => resolve());
        await Promise.all([first, second]);
        await ticks();
        assert.strictEqual(repeat.spWrites.length, 1, 'a repeated request must not pay the level twice');
        assert.deepStrictEqual(repeat.levelWrites, [1]);
        assert.strictEqual(repeat.actor.fetchSp(), 70000);
        assert.strictEqual(repeat.actor.backpack.fetchItemFromSelfId(57).fetchAmount(), 1350000);
        assert.strictEqual(repeat.clan.level, 1);
        assert.notStrictEqual(repeat.session.clanLevelUpPending, true, 'the guard is released after the request ends');

        // After a failed request the guard is released and the next one runs.
        assert.notStrictEqual(failed.session.clanLevelUpPending, true, 'a failed request releases the guard');
        console.log('clan level-up bypass checks passed');
    } finally {
        Object.assign(Database, {
            fetchClans: original.fetchClans,
            fetchClanCharacters: original.fetchClanCharacters,
            updateCharacterExperience: original.updateCharacterExperience,
            updateClanLevel: original.updateClanLevel
        });
        utils.infoWarn = original.infoWarn;
        ClanSocialRuntime.syncMemberships = original.syncMemberships;
        World.user = original.user;
        Object.assign(ServerResponse, {
            npcHtml: original.npcHtml,
            speak: original.speak,
            pledgeShowInfoUpdate: original.pledgeShowInfoUpdate,
            statusUpdate: original.statusUpdate,
            userInfo: original.userInfo
        });
    }
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
    console.error(error);
    process.exit(1);
});
