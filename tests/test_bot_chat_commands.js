const assert = require('assert');

require('../src/Global');

// This file exercises the legacy deterministic command fallback. Keep the
// developer's ignored config/local.ini from changing that contract underneath
// the test suite; LLM routing is covered by the hot conversation flow tests.
const originalOpenRouterEnabled = options.default.OpenRouter?.enabled;
const originalAI = options.default.AI;
options.default.AI = undefined;
if (options.default.OpenRouter) options.default.OpenRouter.enabled = false;

const BotManager = invoke('GameServer/Bot/BotManager');
const BotAI = invoke('GameServer/Bot/BotAI');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const Generics = invoke(path.actor);
const SkillModel = invoke('GameServer/Model/Skill');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const BuffService = invoke('GameServer/Bot/Economy/BuffService');

function fakeActor(id, name, options = {}) {
    const actor = {
        id,
        name,
        hp: options.hp ?? 100,
        maxHp: options.maxHp ?? 100,
        mp: options.mp ?? 100,
        maxMp: options.maxMp ?? 100,
        classId: options.classId ?? 0,
        locX: options.locX ?? 0,
        locY: options.locY ?? 0,
        locZ: options.locZ ?? 0,
        moveCalls: [],
        vitalUpdates: 0,
        fetchId() { return this.id; },
        fetchName() { return this.name; },
        fetchClassId() { return this.classId; },
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; },
        fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMp() { return this.mp; },
        fetchMaxMp() { return this.maxMp; },
        setHp(value) { this.hp = value; },
        setMp(value) { this.mp = value; },
        fetchIsOnline() { return true; },
        isDead() { return false; },
        statusUpdateVitals() { this.vitalUpdates += 1; },
        moveTo(data) { this.moveCalls.push(data); },
        skillset: {
            skills: [],
            fetchSkill(selfId) { return this.skills.find((skill) => skill.fetchSelfId() === selfId) || null; }
        }
    };
    return actor;
}

function fakeSession(accountId, actor) {
    return {
        accountId,
        actor,
        selfPackets: 0,
        dataSendToMe() { this.selfPackets += 1; },
        dataSendToOthers() {}
    };
}

const originalSessions = BotManager.sessions;
const originalSetTimeout = global.setTimeout;
const originalRecordEvent = BotSocialMemory.recordEvent;
const originalSkillExec = Generics.skillExec;
const originalBotTell = BotManager.botTell;
const originalBotSay = BotManager.botSay;
const originalBuffQuote = BuffService.quote;

try {
    global.setTimeout = (fn) => {
        fn();
        return 0;
    };

    const player = fakeActor(2000001, 'Slava', { hp: 20, mp: 7 });
    const playerSession = fakeSession('player_test', player);
    const followBot = fakeActor(2000002, 'FollowBot', { locX: 100 });
    const bystanderBot = fakeActor(2000003, 'BystanderBot', { locX: 120 });
    const followSession = fakeSession('bot_follow', followBot);
    const bystanderSession = fakeSession('bot_bystander', bystanderBot);

    BotManager.sessions = [followSession, bystanderSession];
    BotManager.handlePlayerSpeak(playerSession, { text: 'follow me' });

    assert.strictEqual(followBot.moveCalls.length, 0, 'untargeted follow command should not move nearby bots');
    assert.strictEqual(bystanderBot.moveCalls.length, 0, 'untargeted follow command should not move bystanders');

    player.fetchDestId = () => followBot.fetchId();
    BotManager.handlePlayerSpeak(playerSession, { text: 'follow me' });

    assert.strictEqual(followBot.moveCalls.length, 1, 'selected bot should obey direct follow command');
    assert.strictEqual(bystanderBot.moveCalls.length, 0, 'direct follow command should not spill to other nearby bots');

    const healer = fakeActor(2000004, 'HealerBot', { classId: 15, mp: 30, locX: 100 });
    healer.skillset.skills.push(new SkillModel({
        selfId: 1011,
        name: 'Heal',
        level: 1,
        passive: false,
        spell: true,
        hp: 0,
        mp: 15,
        hitTime: 1000,
        reuse: 1000,
        power: 20,
        distance: 600
    }));
    const healerSession = fakeSession('bot_healer', healer);
    BotManager.sessions = [healerSession];
    player.fetchDestId = () => healer.fetchId();

    let supportCast = null;
    Generics.skillExec = (_session, _actor, data) => { supportCast = data; };
    BotManager.handlePlayerSpeak(playerSession, { text: 'heal me' });

    assert.deepStrictEqual(supportCast, {
        id: player.fetchId(),
        selfId: 1011,
        ctrl: false
    }, 'direct healer support should cast the learned heal through normal skill execution');
    assert.strictEqual(player.fetchHp(), 20, 'support command should not bypass skill execution with a full-HP write');

    const unskilledHealer = fakeActor(2000007, 'UnskilledHealer', { classId: 15, mp: 30, locX: 100 });
    const unskilledHealerSession = fakeSession('bot_unskilled_healer', unskilledHealer);
    BotManager.sessions = [unskilledHealerSession];
    player.fetchDestId = () => unskilledHealer.fetchId();
    supportCast = null;
    BotManager.handlePlayerSpeak(playerSession, { text: 'heal me' });
    assert.strictEqual(supportCast, null, 'direct support should reject a heal the bot has not learned');

    const partyPackets = [];
    const partyBot = fakeActor(2000012, 'PartyBot', { locX: 100 });
    const partyBotSession = fakeSession('bot_party', partyBot);
    partyBotSession.partyCompanion = true;
    partyBotSession.followPlayerSession = playerSession;
    partyBotSession.dataSendToOthers = () => {
        throw new Error('party companion chat must not use nearby chat');
    };
    playerSession.dataSendToMe = (packet) => partyPackets.push(packet);
    BotManager.sessions = [partyBotSession];
    BotManager.botSay(partyBotSession, 'Party call');
    BotManager.botTell(partyBotSession, playerSession, 'Direct party call');
    BotAI.say(partyBotSession, 'AI party call');
    BotAI.tell(partyBotSession, playerSession, 'AI direct party call');
    assert.deepStrictEqual(
        partyPackets.map((packet) => packet.readInt32LE(5)),
        [3, 3, 3, 3],
        'companion messages to its leader must use the party-chat channel, including BotAI messages'
    );
    const outsidePackets = [];
    const outsideSession = fakeSession('outside_player', fakeActor(2000013, 'OutsidePlayer'));
    outsideSession.dataSendToMe = (packet) => outsidePackets.push(packet);
    BotManager.botTell(partyBotSession, outsideSession, 'External tell');
    assert.deepStrictEqual(outsidePackets.map((packet) => packet.readInt32LE(5)), [2], 'a message outside the party must remain a private tell');
    BotManager.botSay(partyBotSession, 'External reply', outsideSession);
    assert.deepStrictEqual(outsidePackets.map((packet) => packet.readInt32LE(5)), [2, 2], 'an addressed reply outside the party must remain a private tell');

    const tank = fakeActor(2000011, 'TankWithoutBuffs', { classId: 1, mp: 30, locX: 100 });
    const tankSession = fakeSession('bot_tank', tank);
    const tankReplies = [];
    BotManager.sessions = [tankSession];
    BotManager.botTell = (_botSession, _playerSession, text) => tankReplies.push(text);
    player.fetchDestId = () => tank.fetchId();
    supportCast = null;
    BotManager.handlePlayerSpeak(playerSession, { text: 'buff me' });
    assert.strictEqual(supportCast, null, 'a bot without friendly support skills must not cast a buff');
    assert.deepStrictEqual(tankReplies, [], 'a bot without friendly support skills must ignore a direct buff request');
    BotManager.botTell = originalBotTell;

    const buffer = fakeActor(2000008, 'Prophet', { classId: 17, mp: 100, locX: 100 });
    const bufferSession = fakeSession('bot_buffer', buffer);
    const quotes = [];
    BuffService.quote = (targetSession, sourceSession) => {
        quotes.push({ targetSession, sourceSession });
        return { ok: true, price: 100 };
    };
    supportCast = null;
    BotManager.handleDirectSupportRequest(bufferSession, playerSession, 100, { buff: true });
    assert.strictEqual(supportCast, null, 'direct buff request must not cast before payment');
    assert.deepStrictEqual(quotes, [{ targetSession: playerSession, sourceSession: bufferSession }]);
    BuffService.quote = originalBuffQuote;


    const socialEvents = [];
    BotSocialMemory.recordEvent = (fromSession, botSession, eventName, detail) => {
        socialEvents.push({
            player: fromSession.actor.fetchName(),
            bot: botSession.actor.fetchName(),
            eventName,
            detail
        });
        return Promise.resolve(null);
    };

    const insultBot = fakeActor(2000005, 'InsultBot', { locX: 100 });
    const nearbyBot = fakeActor(2000006, 'NearbyBot', { locX: 120 });
    const insultSession = fakeSession('bot_insult', insultBot);
    const nearbySession = fakeSession('bot_nearby', nearbyBot);
    BotManager.sessions = [insultSession, nearbySession];
    player.fetchDestId = () => insultBot.fetchId();

    BotManager.handlePlayerSpeak(playerSession, { text: 'you idiot' });

    assert.deepStrictEqual(socialEvents, [{
        player: 'Slava',
        bot: 'InsultBot',
        eventName: 'insulted',
        detail: 'chat'
    }], 'direct insult should be recorded only for the targeted bot');

    // The disabled-LLM greeting fallback must match whole words only:
    // "this" contains "hi" and "купи" contains "ку", but neither greets.
    const greetBot = fakeActor(2000014, 'GreetBot', { locX: 100 });
    const greetSession = fakeSession('bot_greet', greetBot);
    const greetings = [];
    BotManager.sessions = [greetSession];
    player.fetchDestId = () => 0;
    BotManager.botSay = (sourceSession, _text, targetSession) => greetings.push({ sourceSession, targetSession });
    for (const greeting of ['hi', 'hi!', 'привет all', 'ку', 'Hello']) {
        greetings.length = 0;
        BotManager.handlePlayerSpeak(playerSession, { text: greeting });
        assert.strictEqual(greetings.length, 1, `"${greeting}" should still get a greeting reply`);
        assert.strictEqual(greetings[0].sourceSession, greetSession);
        assert.strictEqual(greetings[0].targetSession, playerSession);
    }
    for (const notGreeting of ['this', 'купи', 'which']) {
        greetings.length = 0;
        BotManager.handlePlayerSpeak(playerSession, { text: notGreeting });
        assert.strictEqual(greetings.length, 0, `"${notGreeting}" contains a greeting substring but is not a greeting`);
    }
    BotManager.botSay = originalBotSay;

    console.log('Bot chat command checks passed');
} finally {
    BotManager.sessions = originalSessions;
    global.setTimeout = originalSetTimeout;
    BotSocialMemory.recordEvent = originalRecordEvent;
    Generics.skillExec = originalSkillExec;
    BotManager.botTell = originalBotTell;
    BotManager.botSay = originalBotSay;
    BuffService.quote = originalBuffQuote;
    if (options.default.OpenRouter) options.default.OpenRouter.enabled = originalOpenRouterEnabled;
    options.default.AI = originalAI;
}
