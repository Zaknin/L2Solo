const assert = require('assert');

require('../src/Global');

// E292: a party companion on a hidden supply errand (player_resource_purchase)
// is moved by the leader's teleport. Every other exit of the errand reveals the
// bot, clears its errand phase and hands the life-state row back to hot
// (BotTownTravel.restoreSupplyHot, ShoppingState.scheduleResourceReturn). This
// test checks that the leader-teleport exit leaves the same end state.

const BotSupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const ServerResponse = invoke('GameServer/Network/Response');
const BotAI = invoke('GameServer/Bot/BotAI');
const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');

function item(id, selfId, amount) {
    let count = amount;
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => count,
        setAmount: (value) => { count = value; }
    };
}

function makeWorld(counters) {
    const player = {
        accountId: 'player',
        actor: {
            fetchId: () => 100,
            fetchName: () => 'Slava',
            fetchIsOnline: () => true,
            fetchLocX: () => 0,
            fetchLocY: () => 0,
            fetchLocZ: () => 0
        }
    };
    const adena = item(10, 57, 100000);
    const bot = {
        fetchId: () => 1,
        fetchName: () => 'Caelan',
        fetchIsOnline: () => true,
        fetchKarma: () => 0,
        fetchLevel: () => 20,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        isDead: () => false,
        unselect() {},
        setLocXYZ() {},
        moveTo() {},
        backpack: { fetchItemFromSelfId: (selfId) => (Number(selfId) === 57 ? adena : null) },
        automation: { abortAll() {} },
        state: { fetchHits: () => false, fetchCasts: () => false, setCasts() {} }
    };
    const session = {
        accountId: 'bot_1',
        actor: bot,
        partyCompanion: true,
        followPlayerSession: player,
        dataSendToOthers: (packet) => { counters.sent.push(packet); }
    };
    return { player, bot, session };
}

async function flush() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function runCase(phaseWanted, failures) {
    const counters = { sent: [], markHot: 0, stop: 0, init: 0 };
    let arrival = null;
    BotTownTravel.request = (_session, _bot, _ai, _reason, options) => {
        arrival = options.onArrival;
        return 'escape';
    };
    BotAI.stop = () => { counters.stop += 1; };
    BotAI.init = () => { counters.init += 1; };
    BotAI.wakeup = () => {};
    PopulationService.markHot = async () => { counters.markHot += 1; return { phase: 'hot' }; };

    const { player, session } = makeWorld(counters);
    const requested = BotSupplyErrand.request(session, player, 1463, 1);
    assert.strictEqual(requested.ok, true, `${phaseWanted}: supply errand starts (${requested.reason})`);
    await flush();
    assert.strictEqual(session.supplyErrandPhase, 'cold');
    assert.strictEqual(session.supplyErrandHidden, true);
    if (phaseWanted === 'shopping') {
        arrival();
        assert.strictEqual(session.supplyErrandPhase, 'shopping');
    }
    counters.sent.length = 0;

    // The leader (a real player) teleports; the companion is synced beside it.
    let teleported = 0;
    const Generics = { teleportTo: () => { teleported += 1; return true; }, revive() {} };
    const moved = TeleportTo.syncPartyCompanions(player, { locX: 5000, locY: 5000, locZ: 0 }, Generics, [session]);
    await flush();

    assert.strictEqual(moved, 1, `${phaseWanted}: the companion is moved with the leader`);
    assert.strictEqual(teleported, 1);
    const check = (ok, message) => { if (!ok) failures.push(`${phaseWanted}: ${message}`); };
    check(session.supplyErrandHidden !== true,
        `supplyErrandHidden stays ${session.supplyErrandHidden} after the leader teleport (expected revealed)`);
    check(session.supplyErrandPhase === undefined,
        `supplyErrandPhase stays '${session.supplyErrandPhase}' after the leader teleport (expected cleared)`);
    check(counters.markHot === 1,
        `PopulationService.markHot called ${counters.markHot} times (expected 1: the life-state row stays cold)`);
    check(session.resumeAfterShopping === undefined,
        'resumeAfterShopping stays set after the leader teleport (expected cleared)');
}

async function main() {
    const originals = {
        bestSupplyOffer: MarketOpportunity.bestSupplyOffer,
        request: BotTownTravel.request,
        markCold: LifeState.markCold,
        markHot: PopulationService.markHot,
        stop: BotAI.stop,
        init: BotAI.init,
        wakeup: BotAI.wakeup,
        charInfo: ServerResponse.charInfo,
        relationChanged: ServerResponse.relationChanged,
        items: DataCache.items
    };
    const failures = [];
    try {
        DataCache.items = [{ selfId: 1463, template: { name: 'Soulshot: D-grade' }, etc: { stackable: true } }];
        MarketOpportunity.bestSupplyOffer = () => ({
            sourceType: 'npc', sourceId: 7004, sourceName: 'D-grade grocer', town: 'Talking Island',
            locX: -84000, locY: 244000, locZ: -3700,
            selfId: 1463, price: 17, itemName: 'Soulshot: D-grade', available: true
        });
        LifeState.markCold = async () => ({ phase: 'cold', activity: 'shopping' });
        ServerResponse.charInfo = () => 'charInfo';
        ServerResponse.relationChanged = () => 'relationChanged';

        await runCase('cold', failures);
        await runCase('shopping', failures);
    } finally {
        MarketOpportunity.bestSupplyOffer = originals.bestSupplyOffer;
        BotTownTravel.request = originals.request;
        LifeState.markCold = originals.markCold;
        PopulationService.markHot = originals.markHot;
        BotAI.stop = originals.stop;
        BotAI.init = originals.init;
        BotAI.wakeup = originals.wakeup;
        ServerResponse.charInfo = originals.charInfo;
        ServerResponse.relationChanged = originals.relationChanged;
        DataCache.items = originals.items;
    }
    assert.deepStrictEqual(failures, [], `leader teleport leaves the supply errand open:\n  ${failures.join('\n  ')}`);
    console.log('supply errand leader teleport tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
});
