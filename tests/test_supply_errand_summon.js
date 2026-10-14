const assert = require('assert');

require('../src/Global');

// E298 (as E292 option 2): the companion panel "Call" and "Regroup" commands
// leave a party companion on a hidden supply errand (phases cold and
// shopping) alone. The errand's return places it beside the leader. Other
// companions are still summoned, and an errand companion is neither moved,
// told "Summoned to your side!", nor counted for a regroup slot.

const BotSupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const ServerResponse = invoke('GameServer/Network/Response');
const BotAI = invoke('GameServer/Bot/BotAI');
const PetTravel = invoke('GameServer/Pets/PetTravel');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');

function item(id, selfId, amount) {
    let count = amount;
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => count,
        setAmount: (value) => { count = value; }
    };
}

function makeActor(id, name, counters, log) {
    const adena = item(10, 57, 100000);
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchIsOnline: () => true,
        fetchKarma: () => 0,
        fetchLevel: () => 20,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        isDead: () => false,
        unselect() {},
        clearDestId() { log.push(`clear:${name}`); },
        setLocXYZ() {},
        moveTo() {},
        backpack: { fetchItemFromSelfId: (selfId) => (Number(selfId) === 57 ? adena : null) },
        automation: { abortAll() {} },
        state: { fetchHits: () => false, fetchCasts: () => false, setCasts() {} }
    };
}

function makeWorld(counters, log) {
    const leader = {
        accountId: 'player',
        nativePartyUiVersion: undefined,
        dataSendToMe() {},
        actor: Object.assign(makeActor(100, 'Slava', counters, log), {
            fetchLocX: () => 1000, fetchLocY: () => 2000, fetchLocZ: () => 30
        })
    };
    const make = (accountId, id, name) => ({
        accountId,
        partyCompanion: true,
        followPlayerSession: leader,
        plan: 'following',
        actor: makeActor(id, name, counters, log),
        dataSendToOthers: (packet) => { counters.sent.push(packet); },
        dataSendToMeAndOthers: () => { log.push(`teleport:${name}`); }
    });
    return { leader, errand: make('bot_1', 1, 'Caelan'), a: make('bot_2', 2, 'Ardis'), b: make('bot_3', 3, 'Brun') };
}

async function flush() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function runCase(phaseWanted, failures) {
    const counters = { sent: [], said: [] };
    const log = [];
    BotTownTravel.request = (_session, _bot, _ai, _reason, options) => {
        if (phaseWanted === 'shopping') BotTownTravel.arrival = options.onArrival;
        return 'escape';
    };
    BotAI.stop = () => {};
    BotAI.init = () => {};
    BotAI.wakeup = () => {};
    PopulationService.markHot = async () => ({ phase: 'hot' });

    const { leader, errand, a, b } = makeWorld(counters, log);
    const requested = BotSupplyErrand.request(errand, leader, 1463, 1);
    assert.strictEqual(requested.ok, true, `${phaseWanted}: supply errand starts (${requested.reason})`);
    await flush();
    if (phaseWanted === 'shopping') BotTownTravel.arrival();
    assert.strictEqual(errand.supplyErrandPhase, phaseWanted);
    assert.strictEqual(errand.supplyErrandHidden, true);
    errand.botStay = true;
    errand.stayLocation = { locX: 7, locY: 8, locZ: 9 };
    a.botStay = true;
    a.stayLocation = { locX: 1, locY: 1, locZ: 1 };
    log.length = 0;
    counters.sent.length = 0;
    const before = {
        companionShopping: errand.companionShopping,
        shoppingTarget: errand.shoppingTarget,
        resumeAfterShopping: errand.resumeAfterShopping,
        plan: errand.plan,
        stayLocation: errand.stayLocation
    };

    PartyCompanionService.membersForLeader = () => [errand, a, b];
    BotManager.botSay = (session, text) => { counters.said.push(`${session.accountId}:${text}`); };
    BotManager.getBotStatus = () => null;
    BotRoles.presentation = () => ({ role: 'dps', classId: 0, className: 'Fighter' });

    const check = (ok, message) => { if (!ok) failures.push(`${phaseWanted}: ${message}`); };
    const stateKept = (command) => {
        check(errand.supplyErrandHidden === true, `${command}: supplyErrandHidden is ${errand.supplyErrandHidden} (expected true)`);
        check(errand.supplyErrandPhase === phaseWanted, `${command}: supplyErrandPhase is '${errand.supplyErrandPhase}' (expected '${phaseWanted}')`);
        check(errand.companionShopping === before.companionShopping, `${command}: companionShopping was changed`);
        check(errand.shoppingTarget === before.shoppingTarget, `${command}: shoppingTarget was changed`);
        check(errand.resumeAfterShopping === before.resumeAfterShopping, `${command}: resumeAfterShopping was changed`);
        check(errand.plan === before.plan, `${command}: plan is '${errand.plan}' (expected '${before.plan}')`);
        check(errand.stayLocation === before.stayLocation, `${command}: the Hold anchor of the errand companion was moved`);
        check(!log.includes('teleport:Caelan') && !log.includes('clear:Caelan'), `${command}: the errand companion was teleported`);
        check(counters.sent.length === 0, `${command}: packets were sent for the hidden companion`);
    };

    const realSetTimeout = global.setTimeout;
    global.setTimeout = () => 0;
    const realBegin = PetTravel.begin;
    PetTravel.begin = () => [];
    try {
        // Call (summon) on the errand companion: nothing happens, no false reply.
        CompanionControl(leader, ['companion-control', 'summon', 'Caelan']);
        stateKept('summon errand');
        check(counters.said.length === 0, `summon errand: reply '${counters.said}' for a companion that was not summoned`);

        // Call on an ordinary companion still works.
        CompanionControl(leader, ['companion-control', 'summon', 'Ardis']);
        check(log.includes('teleport:Ardis'), 'summon ordinary: the ordinary companion was not summoned');
        check(counters.said.includes('bot_2:Summoned to your side!'), `summon ordinary: reply is '${counters.said}'`);
        check(a.stayLocation.locX === 1060 && a.stayLocation.locY === 2060, `summon ordinary: Hold anchor is ${JSON.stringify(a.stayLocation)}`);

        // Regroup: the errand companion is skipped, the others get the first two slots.
        log.length = 0;
        CompanionControl(leader, ['companion-control', 'regroup']);
        stateKept('regroup');
        check(log.includes('teleport:Ardis') && log.includes('teleport:Brun'), `regroup: the ordinary companions were not both summoned (${log})`);
        check(a.stayLocation.locX === 1060 && a.stayLocation.locY === 2060, `regroup: first ordinary slot is ${JSON.stringify(a.stayLocation)} (expected 1060,2060)`);
    } finally {
        global.setTimeout = realSetTimeout;
        PetTravel.begin = realBegin;
    }
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
        items: DataCache.items,
        say: TownChatter.say,
        members: PartyCompanionService.membersForLeader,
        botSay: BotManager.botSay,
        getBotStatus: BotManager.getBotStatus,
        presentation: BotRoles.presentation
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
        TownChatter.say = () => {};

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
        TownChatter.say = originals.say;
        PartyCompanionService.membersForLeader = originals.members;
        BotManager.botSay = originals.botSay;
        BotManager.getBotStatus = originals.getBotStatus;
        BotRoles.presentation = originals.presentation;
    }
    assert.deepStrictEqual(failures, [], `panel summon/regroup and the supply errand:\n  ${failures.join('\n  ')}`);
    console.log('supply errand summon tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
});
