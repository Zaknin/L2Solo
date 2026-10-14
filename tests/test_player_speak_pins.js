const assert = require('assert');

require('../src/Global');

// Pins the observable behaviour of BotManager.handlePlayerSpeak /
// handlePlayerSpeakNow for every routing family: early returns, the
// disabled-LLM per-bot command rules (with their reply text, timers and
// state changes), the hot-bot fallback, and the LLM routing paths
// (deterministic route, party LLM router, router error and busy router).
// Every external effect is recorded into one ordered event log.

const BotManager = invoke('GameServer/Bot/BotManager');
const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotDialogueArbiter = invoke('GameServer/Bot/AI/BotDialogueArbiter');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const PartyLLMRouter = invoke('GameServer/Bot/AI/PartyLLMRouter');
const PartyDialogueState = invoke('GameServer/Bot/AI/PartyDialogueState');
const PartyDialogueRouter = invoke('GameServer/Bot/AI/PartyDialogueRouter');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const World = invoke('GameServer/World/World');

function fakeActor(id, name, options = {}) {
    return {
        id,
        name,
        locX: options.locX ?? 0,
        locY: options.locY ?? 0,
        locZ: options.locZ ?? 0,
        destId: options.destId ?? 0,
        fetchId() { return this.id; },
        fetchName() { return this.name; },
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; },
        fetchDestId() { return this.destId; },
        fetchIsOnline() { return true; },
        isDead() { return false; },
        moveTo(data) { events.push(['move', this.name, data.from, data.to]); }
    };
}

function fakeSession(accountId, actor, extra = {}) {
    return { accountId, actor, dataSendToMe() {}, dataSendToOthers() {}, ...extra };
}

const events = [];
const nameOf = (session) => session?.actor?.fetchName?.() || null;
const flush = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const original = {
    sessions: BotManager.sessions,
    worldUser: World.user,
    setTimeout: global.setTimeout,
    random: Math.random,
    botSay: BotManager.botSay,
    botTell: BotManager.botTell,
    support: BotManager.handleDirectSupportRequest,
    isEnabled: BotBrain.isEnabled,
    route: BotDialogueArbiter.route,
    recordEvent: BotSocialMemory.recordEvent,
    detach: PartyCompanionService.detach,
    refresh: World.refreshPartyMemberships,
    routerEnabled: PartyLLMRouter.enabled,
    routerRoute: PartyLLMRouter.route,
    recordMetric: PartyDialogueRouter.recordMetric,
    beginRouter: PartyDialogueState.beginRouter,
    clearInFlight: PartyDialogueState.clearInFlight,
    startObservation: LangfuseTracing.startObservation
};

let arbiterResult = () => Promise.resolve({ ok: true, started: true });

function installStubs() {
    global.setTimeout = (fn, ms) => {
        events.push(['timer', ms]);
        fn();
        return 0;
    };
    Math.random = () => 0.25;
    BotManager.botSay = (session, text, target) => events.push(['say', nameOf(session), text, nameOf(target)]);
    BotManager.botTell = (session, target, text) => events.push(['tell', nameOf(session), nameOf(target), text]);
    BotManager.handleDirectSupportRequest = (session, target, distance, request) => {
        events.push(['support', nameOf(session), nameOf(target), distance, request]);
    };
    BotDialogueArbiter.route = (input) => {
        events.push(['route', nameOf(input.botSession), nameOf(input.playerSession), input.text, input.channel, input.source, input.allowFallback]);
        return arbiterResult();
    };
    BotSocialMemory.recordEvent = (from, bot, eventName, detail) => {
        events.push(['social', nameOf(from), nameOf(bot), eventName, detail]);
        return Promise.resolve(null);
    };
    PartyCompanionService.detach = (playerSession, session, details) => {
        events.push(['detach', nameOf(playerSession), nameOf(session), details]);
    };
    World.refreshPartyMemberships = (changed) => {
        events.push(['refresh', changed.map(nameOf)]);
        return 0;
    };
    PartyDialogueRouter.recordMetric = (result, options) => {
        events.push(['metric', options.source, options.dispatchCount, result?.status || result?.route || null, result?.reason || null]);
    };
    PartyDialogueState.clearInFlight = (playerSession, session) => {
        events.push(['clearInFlight', nameOf(session)]);
        return original.clearInFlight(playerSession, session);
    };
    LangfuseTracing.startObservation = (name, _input, metadata) => ({
        end(value) {
            events.push(['span', name, metadata?.source || null, metadata?.reason || null, value?.route || null, value?.reason || null]);
        },
        update() {}
    });
}

function restoreStubs() {
    BotManager.sessions = original.sessions;
    World.user = original.worldUser;
    global.setTimeout = original.setTimeout;
    Math.random = original.random;
    BotManager.botSay = original.botSay;
    BotManager.botTell = original.botTell;
    BotManager.handleDirectSupportRequest = original.support;
    BotBrain.isEnabled = original.isEnabled;
    BotDialogueArbiter.route = original.route;
    BotSocialMemory.recordEvent = original.recordEvent;
    PartyCompanionService.detach = original.detach;
    World.refreshPartyMemberships = original.refresh;
    PartyLLMRouter.enabled = original.routerEnabled;
    PartyLLMRouter.route = original.routerRoute;
    PartyDialogueRouter.recordMetric = original.recordMetric;
    PartyDialogueState.beginRouter = original.beginRouter;
    PartyDialogueState.clearInFlight = original.clearInFlight;
    LangfuseTracing.startObservation = original.startObservation;
}

function newPlayer() {
    return fakeSession('player_pin', fakeActor(3000001, 'Slava'));
}

function resetPlayer(playerSession) {
    PartyDialogueState.reset(playerSession);
    delete playerSession.botDialogueResponderId;
    delete playerSession.botDialogueResponderAt;
    delete playerSession.partyDialogueIngressPromise;
}

function speakNow(playerSession, data) {
    events.length = 0;
    const result = BotManager.handlePlayerSpeak(playerSession, data);
    return { result, log: events.slice() };
}

function companion(session, playerSession) {
    session.partyCompanion = true;
    session.followPlayerSession = playerSession;
    return session;
}

function disabledLlmCases() {
    BotBrain.isEnabled = () => false;
    const player = newPlayer();
    const at = (x) => ({ from: { locX: x, locY: 0, locZ: 0 } });

    // Early returns: blank text and a session without an actor do nothing.
    let out = speakNow(player, { text: '   ' });
    assert.strictEqual(out.result, undefined);
    assert.deepStrictEqual(out.log, []);
    out = speakNow({ actor: null }, { text: 'hi everyone' });
    assert.strictEqual(out.result, undefined);
    assert.deepStrictEqual(out.log, []);

    // A command addressed by the short name (bot_ prefix stripped) reaches only that bot.
    let kira = fakeSession('bot_kira', fakeActor(3000002, 'bot_Kira', { locX: 100 }), { plan: 'hunting' });
    let other = fakeSession('bot_other', fakeActor(3000003, 'Other', { locX: 120 }), { plan: 'hunting' });
    BotManager.sessions = [kira, other];
    out = speakNow(player, { text: 'Kira stop' });
    assert.strictEqual(out.result, undefined);
    assert.deepStrictEqual(out.log, [
        ['timer', 1000],
        ['say', 'bot_Kira', 'Staying here! Let me know if you need help.', 'Slava'],
        ['move', 'bot_Kira', at(100).from, at(100).from]
    ]);
    assert.strictEqual(kira.plan, 'resting');
    assert.strictEqual(other.plan, 'hunting');

    // Untargeted stop: no bot is addressed, nothing happens.
    out = speakNow(player, { text: 'stop' });
    assert.deepStrictEqual(out.log, []);

    // Follow from the party companion: it follows without moving here.
    kira = companion(fakeSession('bot_kira', fakeActor(3000002, 'Kira', { locX: 100 }), { plan: 'hunting' }), player);
    BotManager.sessions = [kira];
    out = speakNow(player, { text: 'follow me' });
    assert.deepStrictEqual(out.log, [
        ['timer', 1000],
        ['say', 'Kira', 'Sure! I will follow you and assist in combat.', 'Slava']
    ]);
    assert.strictEqual(kira.plan, 'following');

    // Follow from a selected non-companion: tell plus a move toward the player.
    other = fakeSession('bot_other', fakeActor(3000003, 'Other', { locX: 120 }), { plan: 'hunting' });
    BotManager.sessions = [other];
    player.actor.destId = 3000003;
    out = speakNow(player, { text: 'за мной' });
    assert.deepStrictEqual(out.log.slice(0, 2), [
        ['timer', 1000],
        ['tell', 'Other', 'Slava', 'I can come closer, but invite me if you want party follow.']
    ]);
    assert.strictEqual(out.log.length, 3);
    assert.strictEqual(out.log[2][0], 'move');
    assert.deepStrictEqual(out.log[2][2], at(120).from);
    assert.strictEqual(other.plan, 'hunting');

    // A pk_hunting bot refuses every order family before the follow rule.
    const pk = fakeSession('bot_pk', fakeActor(3000004, 'Pk', { locX: 100 }), { plan: 'pk_hunting' });
    BotManager.sessions = [pk];
    player.actor.destId = 3000004;
    for (const order of ['follow', 'wait', 'кач', 'buff']) {
        out = speakNow(player, { text: order });
        assert.deepStrictEqual(out.log, [
            ['timer', 625],
            ['say', 'Pk', 'I take no orders, Slava.', 'Slava']
        ], `pk_hunting refusal for "${order}"`);
    }
    assert.strictEqual(pk.plan, 'pk_hunting');

    // Hunt from the companion detaches it through PartyCompanionService.
    kira = companion(fakeSession('bot_kira', fakeActor(3000002, 'Kira', { locX: 100 }), { plan: 'following' }), player);
    BotManager.sessions = [kira];
    player.actor.destId = 0;
    out = speakNow(player, { text: 'go hunt' });
    assert.deepStrictEqual(out.log, [
        ['timer', 1000],
        ['say', 'Kira', 'Alright, returning to hunt keltirs!', 'Slava'],
        ['detach', 'Slava', 'Kira', { event: 'party_dismissed', source: 'chat_hunt', plan: 'hunting' }]
    ]);

    // Hunt from a selected non-companion resets its plan and publishes membership.
    other = fakeSession('bot_other', fakeActor(3000003, 'Other', { locX: 120 }), { plan: 'resting', followPlayerSession: player, partyCompanion: false });
    BotManager.sessions = [other];
    player.actor.destId = 3000003;
    out = speakNow(player, { text: 'иди качайся' });
    assert.deepStrictEqual(out.log, [
        ['timer', 1000],
        ['say', 'Other', 'Alright, returning to hunt keltirs!', 'Slava'],
        ['refresh', ['Other']]
    ]);
    assert.strictEqual(other.plan, 'hunting');
    assert.strictEqual(other.followPlayerSession, null);
    assert.strictEqual(other.partyCompanion, false);

    // Heal and buff in one line go to the support handler with the distance.
    other = fakeSession('bot_other', fakeActor(3000003, 'Other', { locX: 120 }), { plan: 'hunting' });
    BotManager.sessions = [other];
    out = speakNow(player, { text: 'heal and buff please' });
    assert.deepStrictEqual(out.log, [
        ['timer', 1000],
        ['support', 'Other', 'Slava', 120, { heal: true, buff: true }]
    ]);
    out = speakNow(player, { text: 'бафф' });
    assert.deepStrictEqual(out.log, [
        ['timer', 1000],
        ['support', 'Other', 'Slava', 120, { heal: false, buff: true }]
    ]);

    // Insult to the selected bot: social memory first, then a delayed tell.
    out = speakNow(player, { text: 'you NOOB' });
    assert.deepStrictEqual(out.log, [
        ['social', 'Slava', 'Other', 'insulted', 'chat'],
        ['timer', 625],
        ['tell', 'Other', 'Slava', 'That was uncalled for.']
    ]);

    // A greeting reaches every bot in range, addressed or not.
    player.actor.destId = 0;
    const first = fakeSession('bot_first', fakeActor(3000005, 'First', { locX: 100 }), { plan: 'resting' });
    const second = fakeSession('bot_second', fakeActor(3000006, 'Second', { locX: 200 }));
    const far = fakeSession('bot_far', fakeActor(3000007, 'Far', { locX: 1600 }));
    BotManager.sessions = [first, second, far];
    out = speakNow(player, { text: 'hello' });
    assert.deepStrictEqual(out.log, [
        ['timer', 1250],
        ['say', 'First', "Hey Slava! I'm currently resting.", 'Slava'],
        ['timer', 1250],
        ['say', 'Second', "Hey Slava! I'm currently hunting.", 'Slava']
    ]);

    // Unknown unaddressed line: nobody answers.
    out = speakNow(player, { text: 'nice weather today' });
    assert.deepStrictEqual(out.log, []);

    // Unknown line addressed by name falls back to the dialogue arbiter.
    out = speakNow(player, { text: 'second, how are you?' });
    assert.strictEqual(out.result, undefined);
    assert.deepStrictEqual(out.log, [
        ['route', 'Second', 'Slava', 'second, how are you?', 'local_chat', 'local_chat', true]
    ]);

    // A group address picks the first bot in range only; a selected bot still answers.
    player.actor.destId = 3000006;
    out = speakNow(player, { text: 'everyone, how are you?' });
    assert.deepStrictEqual(out.log, [
        ['route', 'First', 'Slava', 'everyone, how are you?', 'local_chat', 'local_chat', true],
        ['route', 'Second', 'Slava', 'everyone, how are you?', 'local_chat', 'local_chat', true]
    ]);
    player.actor.destId = 0;
    out = speakNow(player, { text: 'ребят, как дела?' });
    assert.deepStrictEqual(out.log, [
        ['route', 'First', 'Slava', 'ребят, как дела?', 'local_chat', 'local_chat', true]
    ]);

    // Out of range (> 1500) in local chat: even a named bot is ignored.
    out = speakNow(player, { text: 'far stop' });
    assert.deepStrictEqual(out.log, []);

    // Party channel with the LLM off: a far companion still obeys, a far
    // non-companion does not, and the fallback route stays local_chat.
    const farMate = companion(fakeSession('bot_farmate', fakeActor(3000008, 'FarMate', { locX: 4000 }), { plan: 'following' }), player);
    BotManager.sessions = [farMate, far];
    out = speakNow(player, { kind: 3, text: 'stop' });
    assert.strictEqual(out.result, undefined, 'party chat with the LLM off returns synchronously');
    assert.deepStrictEqual(out.log, [
        ['timer', 1000],
        ['say', 'FarMate', 'Staying here! Let me know if you need help.', 'Slava'],
        ['move', 'FarMate', at(4000).from, at(4000).from]
    ]);
    out = speakNow(player, { kind: 3, text: 'far, how are you?' });
    assert.deepStrictEqual(out.log, [
        ['route', 'FarMate', 'Slava', 'far, how are you?', 'local_chat', 'local_chat', true]
    ]);
}

async function enabledLlmCases() {
    BotBrain.isEnabled = () => true;
    const player = newPlayer();
    const aria = fakeSession('bot_aria', fakeActor(3000011, 'Aria', { locX: 100 }));
    const belen = fakeSession('bot_belen', fakeActor(3000012, 'Belen', { locX: 150 }));

    // Local chat, LLM on: a named bot gets the conversation route, no rule replies.
    BotManager.sessions = [aria, belen];
    World.user = { sessions: [player, aria, belen] };
    PartyLLMRouter.enabled = () => true;
    PartyLLMRouter.route = async () => { throw new Error('router must not run in local chat'); };
    resetPlayer(player);
    let out = speakNow(player, { text: 'Belen, follow me' });
    assert.strictEqual(out.result, undefined);
    assert.deepStrictEqual(out.log, [
        ['route', 'Belen', 'Slava', 'Belen, follow me', 'local_chat', 'local_chat', true]
    ]);
    await flush();

    // Local chat, LLM on, unaddressed line: nobody is dispatched.
    resetPlayer(player);
    out = speakNow(player, { text: 'nice weather today' });
    assert.deepStrictEqual(out.log, []);

    // Party chat, LLM on, a named companion: deterministic route, no router call.
    companion(aria, player);
    companion(belen, player);
    resetPlayer(player);
    out = speakNow(player, { kind: 3, text: 'Belen, heal me' });
    assert.ok(out.result instanceof Promise, 'party chat with the LLM on is serialised');
    assert.strictEqual(await out.result, undefined);
    await flush();
    assert.deepStrictEqual(events, [
        ['span', 'party.address.resolve', null, 'explicit_full_name', null, 'explicit_full_name'],
        ['metric', 'deterministic', 1, 'matched', 'explicit_full_name'],
        ['span', 'party.dialogue.route', 'deterministic', 'explicit_full_name', 'bot', 'explicit_full_name'],
        ['route', 'Belen', 'Slava', 'Belen, heal me', 'party_chat', 'party_chat', true],
        ['span', 'party.dispatch', null, 'explicit_full_name', null, null]
    ]);

    // Party chat, router rejects: the spokesperson fallback is dispatched.
    resetPlayer(player);
    PartyLLMRouter.route = async () => { throw new Error('router down'); };
    events.length = 0;
    let result = await BotManager.handlePlayerSpeak(player, { kind: 3, text: 'who should handle this?' });
    await flush();
    assert.deepStrictEqual(result, { ok: true, started: true });
    assert.deepStrictEqual(events, [
        ['span', 'party.address.resolve', null, 'party_ambiguous', null, 'party_ambiguous'],
        ['metric', 'deterministic', 0, 'needs_router', 'party_ambiguous'],
        ['metric', 'llm_router', 1, 'none', 'router_error'],
        ['route', 'Aria', 'Slava', 'who should handle this?', 'party_chat', 'party_chat', true],
        ['span', 'party.dispatch', null, 'router_error_fallback', null, null]
    ]);

    // Party chat, router answers "none": its result is returned, nobody dispatched.
    resetPlayer(player);
    PartyLLMRouter.route = async () => ({ ok: true, route: 'none', candidate: null, reason: 'small talk' });
    events.length = 0;
    result = await BotManager.handlePlayerSpeak(player, { kind: 3, text: 'who should handle this?' });
    await flush();
    assert.deepStrictEqual(result, { ok: true, route: 'none', candidate: null, reason: 'small talk' });
    assert.deepStrictEqual(events, [
        ['span', 'party.address.resolve', null, 'party_ambiguous', null, 'party_ambiguous'],
        ['metric', 'deterministic', 0, 'needs_router', 'party_ambiguous'],
        ['metric', 'llm_router', 0, 'none', 'small talk'],
        ['span', 'party.dialogue.route', 'llm_router', 'router_none', 'none', 'small talk']
    ]);

    // Party chat, router picks a bot but the arbiter fails: clearInFlight and route_error.
    resetPlayer(player);
    PartyLLMRouter.route = async (input) => ({ ok: true, route: 'bot', candidate: input.candidates[1], reason: 'pick Belen' });
    arbiterResult = () => Promise.reject(new Error('arbiter down'));
    events.length = 0;
    result = await BotManager.handlePlayerSpeak(player, { kind: 3, text: 'who should handle this?' });
    await flush();
    assert.deepStrictEqual(result, { ok: false, reason: 'route_error', error: 'arbiter down' });
    assert.deepStrictEqual(events, [
        ['span', 'party.address.resolve', null, 'party_ambiguous', null, 'party_ambiguous'],
        ['metric', 'deterministic', 0, 'needs_router', 'party_ambiguous'],
        ['metric', 'llm_router', 1, 'bot', 'pick Belen'],
        ['span', 'party.dialogue.route', 'llm_router', 'router_bot', 'bot', 'pick Belen'],
        ['route', 'Belen', 'Slava', 'who should handle this?', 'party_chat', 'party_chat', true],
        ['span', 'party.dispatch', null, 'router_bot', null, 'route_error'],
        ['clearInFlight', 'Belen']
    ]);

    // Arbiter answers without starting: clearInFlight, result passed through.
    resetPlayer(player);
    arbiterResult = () => Promise.resolve({ ok: false, reason: 'busy' });
    events.length = 0;
    result = await BotManager.handlePlayerSpeak(player, { kind: 3, text: 'who should handle this?' });
    await flush();
    assert.deepStrictEqual(result, { ok: false, reason: 'busy' });
    assert.deepStrictEqual(events.slice(-2), [
        ['span', 'party.dispatch', null, 'router_bot', null, 'busy'],
        ['clearInFlight', 'Belen']
    ]);
    arbiterResult = () => Promise.resolve({ ok: true, started: true });

    // Router busy (beginRouter refuses): the fallback route is used in the same turn.
    resetPlayer(player);
    PartyDialogueState.beginRouter = () => false;
    PartyLLMRouter.route = async () => { throw new Error('router must not run while busy'); };
    events.length = 0;
    result = await BotManager.handlePlayerSpeak(player, { kind: 3, text: 'who should handle this?' });
    await flush();
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(events, [
        ['span', 'party.address.resolve', null, 'party_ambiguous', null, 'party_ambiguous'],
        ['metric', 'deterministic', 0, 'needs_router', 'party_ambiguous'],
        ['route', 'Aria', 'Slava', 'who should handle this?', 'party_chat', 'party_chat', true],
        ['span', 'party.dispatch', null, 'party_spokesperson', null, null]
    ]);
    PartyDialogueState.beginRouter = original.beginRouter;

    // Party chat with the cheap router disabled: spokesperson chosen deterministically.
    resetPlayer(player);
    PartyLLMRouter.enabled = () => false;
    events.length = 0;
    result = await BotManager.handlePlayerSpeak(player, { kind: 3, text: 'who should handle this?' });
    await flush();
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(events, [
        ['span', 'party.address.resolve', null, 'party_spokesperson', null, 'party_spokesperson'],
        ['metric', 'deterministic', 1, 'matched', 'party_spokesperson'],
        ['span', 'party.dialogue.route', 'deterministic', 'party_spokesperson', 'bot', 'party_spokesperson'],
        ['route', 'Aria', 'Slava', 'who should handle this?', 'party_chat', 'party_chat', true],
        ['span', 'party.dispatch', null, 'party_spokesperson', null, null]
    ]);
    resetPlayer(player);
}

async function main() {
    installStubs();
    try {
        disabledLlmCases();
        await enabledLlmCases();
    } finally {
        restoreStubs();
    }
    console.log('Player speak pin checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
