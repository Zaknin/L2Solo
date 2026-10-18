// Pins the observable behaviour of Request/Speak.consume (U46) for every
// chat kind and every local command before the method is split: the
// handler and its arguments, who receives which packet in which order, the
// bot dialogue entry and the return value.
const assert = require('assert');

require('../src/Global');

const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const PopulationConfig = invoke('GameServer/Bot/Population/PopulationConfig');
const Speak = invoke('GameServer/Network/Request/Speak');

const events = [];
const invoked = [];
let clanMembers = [];
let worldSessions = [];
let buffHandles = false;
let tradeResult = { ok: true };
let afkFails = false;
let botHookThrows = false;
const clanDialogueResult = { clanDialogue: true };
const tradeTarget = { accountId: 'bot_trader', actor: { fetchId: () => 3000001, fetchName: () => 'Trader' } };

function decode(packet) {
    if (!Buffer.isBuffer(packet)) return packet;
    const read = new ReceivePacket(packet);
    read.readD().readD().readS().readS();
    return read.data;
}

function makeActor(name, id, options = {}) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchIsOnline: options.online === undefined ? () => true : options.online,
        fetchClanId: () => options.clanId || 0,
        fetchDestId: () => 3000001,
        backpack: { fetchItems: () => ['item-a'] }
    };
}

function makeSession(accountId, name, id, options = {}) {
    const session = {
        accountId,
        actor: makeActor(name, id, options),
        dataSendToMe(packet) { events.push(['send', accountId, decode(packet)]); },
        dataSendToMeAndOthers(packet, actor) {
            events.push(['sendNearby', accountId, decode(packet), actor === session.actor]);
        }
    };
    if (options.socket !== false) session.socket = { write() {} };
    if (options.online === false) session.actor.fetchIsOnline = () => false;
    if (options.noOnline) delete session.actor.fetchIsOnline;
    return session;
}

const stubs = {
    'GameServer/World/Generics/NpcBypasses/NativeMenu': {
        open: (s) => events.push(['NativeMenu.open', s.accountId])
    },
    'GameServer/World/ArenaDuelService': {
        handleGo: (s, text) => events.push(['ArenaDuel.handleGo', s.accountId, text])
    },
    'GameServer/Bot/Economy/BuffService': {
        command: (s, text) => { events.push(['BuffService.command', s.accountId, text]); return buffHandles; }
    },
    'GameServer/World/Generics/NpcBypasses/NativeItems': {
        open: (s, arg) => events.push(['NativeItems.open', s.accountId, arg])
    },
    [path.actor]: {
        adminPanel: (s, actor) => events.push(['adminPanel', s.accountId, actor === s.actor])
    },
    [path.world + 'NpcTalkResponse']: (s, data) => events.push(['NpcTalkResponse', s.accountId, data]),
    'GameServer/AfkTrade/AfkTradeService': {
        SELL: 'sell-mode',
        BUY: 'buy-mode',
        begin: (s, mode) => {
            events.push(['AfkTrade.begin', s.accountId, mode]);
            return afkFails ? Promise.reject(new Error('begin boom')) : Promise.resolve();
        },
        stop: (s) => {
            events.push(['AfkTrade.stop', s.accountId]);
            return afkFails ? Promise.reject(new Error('stop boom')) : Promise.resolve();
        }
    },
    'GameServer/World/World': {
        get user() { return { sessions: worldSessions }; },
        dismissParty: (s, actor) => events.push(['World.dismissParty', s.accountId, actor === s.actor]),
        oustPartyMember: (s, actor, data) => events.push(['World.oustPartyMember', s.accountId, actor === s.actor, data]),
        inviteBotByName: (s, actor, name, fourth, source) =>
            events.push(['World.inviteBotByName', s.accountId, actor === s.actor, name, fourth, source]),
        requestJoinBotPartyByName: (s, actor, name, source) =>
            events.push(['World.requestJoinBotPartyByName', s.accountId, actor === s.actor, name, source]),
        messageBotByName: (s, actor, name, text, source) => {
            events.push(['World.messageBotByName', s.accountId, actor === s.actor, name, text, source]);
            return Promise.resolve(true);
        }
    },
    'GameServer/World/Generics/NpcBypasses/CompanionControl': {
        render: (s, page, options) => events.push(['CompanionControl.render', s.accountId, page, options])
    },
    'GameServer/World/Generics/NpcBypasses/BotParty': {
        open: (s) => events.push(['BotParty.open', s.accountId])
    },
    'GameServer/World/Generics/NpcBypasses/BotFriends': {
        render: (s, view, page, extra, options) => events.push(['BotFriends.render', s.accountId, view, page, extra, options])
    },
    'GameServer/World/Generics/NpcBypasses/UiTest': {
        render: (s) => events.push(['UiTest.render', s.accountId])
    },
    'GameServer/World/Generics/NpcBypasses/BotStatus': (s, parts) => events.push(['BotStatus', s.accountId, parts]),
    'GameServer/World/Generics/NpcBypasses/BotPath': (s, parts) => events.push(['BotPath', s.accountId, parts]),
    'GameServer/Bot/BotManager': {
        findSessionById: (id) => { events.push(['BotManager.findSessionById', id]); return tradeTarget; },
        findSessionByName: (name) => {
            events.push(['BotManager.findSessionByName', name]);
            return { accountId: 'bot_tell', actor: { fetchName: () => 'TellBot' } };
        },
        handlePlayerSpeak: (s, data) => {
            events.push(['BotManager.handlePlayerSpeak', s.accountId, data]);
            if (botHookThrows) throw new Error('hook boom');
        }
    },
    'GameServer/Bot/BotTradeService': {
        startPlayerTrade: (s, target) => {
            events.push(['BotTrade.startPlayerTrade', s.accountId, target === tradeTarget]);
            return tradeResult;
        }
    },
    'GameServer/Clan/ClanService': {
        onlineSessions: (clan) => { events.push(['ClanService.onlineSessions', clan]); return clanMembers; }
    },
    'GameServer/Bot/AI/ClanDialogueService': {
        handlePlayerSpeak: (s, data) => {
            events.push(['ClanDialogue.handlePlayerSpeak', s.accountId, data]);
            return clanDialogueResult;
        }
    }
};

const originalInvoke = global.invoke;
const originalActionFailed = ServerResponse.actionFailed;
const originalTradeStart = ServerResponse.tradeStart;
const originalInfoWarn = utils.infoWarn;
const originalConsoleError = console.error;
const originalConsoleInfo = console.info;
const originalDiagnostics = PopulationConfig.developerDiagnostics;
const originalLogChat = PopulationConfig.devLogPlayerChat;

function consume(session, data) {
    events.length = 0;
    invoked.length = 0;
    const result = Speak.consume(session, data);
    return { result, events: events.slice(), invoked: invoked.slice() };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
    global.invoke = (module) => {
        invoked.push(module);
        return Object.prototype.hasOwnProperty.call(stubs, module) ? stubs[module] : originalInvoke(module);
    };
    ServerResponse.actionFailed = () => ({ packet: 'actionFailed' });
    ServerResponse.tradeStart = (actor, items) => ({ packet: 'tradeStart', target: actor.fetchName(), items });
    utils.infoWarn = (...args) => events.push(['infoWarn', ...args]);

    const player = makeSession('player_pin', 'Pinner', 2000001);
    const speakLine = (kind, text) => [2000001, kind, 'Pinner', text];

    // Plain local chat: nearby broadcast, then the bot dialogue entry with the
    // same data object; nothing returned.
    {
        const data = { kind: 0, text: 'hello there' };
        const run = consume(player, data);
        assert.strictEqual(run.result, undefined);
        assert.deepStrictEqual(run.events, [
            ['BuffService.command', 'player_pin', 'hello there'],
            ['sendNearby', 'player_pin', speakLine(0, 'hello there'), true],
            ['BotManager.handlePlayerSpeak', 'player_pin', data]
        ]);
        assert.strictEqual(run.events[2][2], data, 'the bot entry receives the same data object');
        assert.deepStrictEqual(run.invoked, [
            'GameServer/World/ArenaDuelService',
            'GameServer/Bot/Economy/BuffService',
            'GameServer/Bot/BotManager'
        ], 'plain local chat looks up the same modules in the same order');
    }

    // An unknown dotted command falls through to local chat.
    {
        const run = consume(player, { kind: 0, text: '.nothing here' });
        assert.deepStrictEqual(run.events.map((e) => e[0]), ['BuffService.command', 'sendNearby', 'BotManager.handlePlayerSpeak']);
    }

    // Party (3), alliance (9) and an unknown kind are local broadcasts with no
    // command dispatch.
    for (const kind of [3, 9, 17]) {
        const data = { kind, text: '.leave' };
        const run = consume(player, data);
        assert.strictEqual(run.result, undefined);
        assert.deepStrictEqual(run.events, [
            ['sendNearby', 'player_pin', speakLine(kind, '.leave'), true],
            ['BotManager.handlePlayerSpeak', 'player_pin', data]
        ], `kind ${kind} is a local broadcast`);
    }

    // Shout (1) and trade (8): one packet object to every non-bot session with
    // a writable socket, in session order; never a nearby broadcast.
    for (const kind of [1, 8]) {
        const other = makeSession('player_other', 'Other', 2000002);
        const bot = makeSession('bot_someone', 'SomeBot', 2000003);
        const noSocket = makeSession('player_nosocket', 'NoSocket', 2000004, { socket: false });
        const badSocket = makeSession('player_badsocket', 'BadSocket', 2000005);
        badSocket.socket = { write: 'not a function' };
        const sent = [];
        for (const s of [player, other]) {
            const send = s.dataSendToMe;
            s.dataSendToMe = function (packet) { sent.push(packet); return send.call(this, packet); };
        }
        worldSessions = [other, bot, player, noSocket, badSocket];
        const data = { kind, text: 'WTS stuff' };
        const run = consume(player, data);
        delete player.dataSendToMe;
        player.dataSendToMe = makeSession('player_pin', 'Pinner', 2000001).dataSendToMe;
        assert.strictEqual(run.result, undefined);
        assert.deepStrictEqual(run.events, [
            ['send', 'player_other', speakLine(kind, 'WTS stuff')],
            ['send', 'player_pin', speakLine(kind, 'WTS stuff')],
            ['BotManager.handlePlayerSpeak', 'player_pin', data]
        ], `kind ${kind} goes to every connected player`);
        assert.strictEqual(sent[0], sent[1], 'every recipient gets the same packet object');
        worldSessions = [];
    }

    // Clan chat (4) with a clan: online members (fetchIsOnline not false, or
    // absent) get the packet; the clan dialogue result is returned; no local
    // broadcast and no nearby bot entry.
    {
        const clanPlayer = makeSession('player_clan', 'Clanner', 2000006, { clanId: 77 });
        const online = makeSession('player_m1', 'M1', 2000007);
        const offline = makeSession('player_m2', 'M2', 2000008, { online: false });
        const unknown = makeSession('player_m3', 'M3', 2000009, { noOnline: true });
        const noActor = { accountId: 'player_m4', dataSendToMe: () => events.push(['send', 'player_m4', 'any']) };
        clanMembers = [online, offline, unknown, noActor];
        const data = { kind: 4, text: 'clan hi' };
        const run = consume(clanPlayer, data);
        assert.strictEqual(run.result, clanDialogueResult);
        assert.deepStrictEqual(run.events, [
            ['ClanService.onlineSessions', { id: 77 }],
            ['send', 'player_m1', [2000006, 4, 'Clanner', 'clan hi']],
            ['send', 'player_m3', [2000006, 4, 'Clanner', 'clan hi']],
            ['send', 'player_m4', 'any'],
            ['ClanDialogue.handlePlayerSpeak', 'player_clan', data]
        ]);
        clanMembers = [];
    }

    // Clan chat without a clan: nothing at all.
    {
        const run = consume(player, { kind: 4, text: 'no clan' });
        assert.strictEqual(run.result, undefined);
        assert.deepStrictEqual(run.events, []);
    }

    // Private tell (2): routed by handlePrivateTell, consume returns nothing
    // (not the routing promise) and nothing is broadcast.
    {
        const run = consume(player, { kind: 2, text: 'psst', target: 'TellBot' });
        assert.strictEqual(run.result, undefined);
        assert.deepStrictEqual(run.events, [
            ['BotManager.findSessionByName', 'TellBot'],
            ['send', 'player_pin', [2000001, 2, '->TellBot', 'psst']],
            ['World.messageBotByName', 'player_pin', true, 'TellBot', 'psst', 'client_tell']
        ]);
        const empty = consume(player, { kind: 2, text: '  ', target: 'TellBot' });
        assert.strictEqual(empty.result, undefined);
        assert.deepStrictEqual(empty.events, [['send', 'player_pin', { packet: 'actionFailed' }]]);
    }

    // Local commands (kind 0): each one calls only its handler.
    const commandCases = [
        [' .MENU ', [['NativeMenu.open', 'player_pin']]],
        [' .Go ', [['ArenaDuel.handleGo', 'player_pin', ' .Go ']]],
        ['.items', [['BuffService.command', 'player_pin', '.items'], ['NativeItems.open', 'player_pin', null]]],
        [' .ITEMS weapons ', [['BuffService.command', 'player_pin', '.ITEMS weapons'], ['NativeItems.open', 'player_pin', 'weapons']]],
        ['.admin', [['BuffService.command', 'player_pin', '.admin'], ['adminPanel', 'player_pin', true]]],
        ['.sell', [['BuffService.command', 'player_pin', '.sell'], ['NpcTalkResponse', 'player_pin', { link: 'sell-junk' }]]],
        ['.afksell', [['BuffService.command', 'player_pin', '.afksell'], ['AfkTrade.begin', 'player_pin', 'sell-mode']]],
        ['.afkbuy', [['BuffService.command', 'player_pin', '.afkbuy'], ['AfkTrade.begin', 'player_pin', 'buy-mode']]],
        ['.afkstop', [['BuffService.command', 'player_pin', '.afkstop'], ['AfkTrade.stop', 'player_pin']]],
        ['.leave', [['BuffService.command', 'player_pin', '.leave'], ['World.dismissParty', 'player_pin', true]]],
        ['.kick  Bob ', [['BuffService.command', 'player_pin', '.kick  Bob'], ['World.oustPartyMember', 'player_pin', true, { name: 'Bob' }]]],
        ['.bot', [['BuffService.command', 'player_pin', '.bot'], ['CompanionControl.render', 'player_pin', 0, { open: true }]]],
        ['.b', [['BuffService.command', 'player_pin', '.b'], ['CompanionControl.render', 'player_pin', 0, { open: true }]]],
        ['.companion', [['BuffService.command', 'player_pin', '.companion'], ['CompanionControl.render', 'player_pin', 0, { open: true }]]],
        ['.botparty', [['BuffService.command', 'player_pin', '.botparty'], ['BotParty.open', 'player_pin']]],
        ['/invite  Ann ', [['BuffService.command', 'player_pin', '/invite  Ann'], ['World.inviteBotByName', 'player_pin', true, 'Ann', undefined, 'chat_invite']]],
        ['.invite Ann', [['BuffService.command', 'player_pin', '.invite Ann'], ['World.inviteBotByName', 'player_pin', true, 'Ann', undefined, 'chat_invite']]],
        [' .JoinParty Zed ', [['BuffService.command', 'player_pin', '.JoinParty Zed'], ['World.requestJoinBotPartyByName', 'player_pin', true, 'Zed', 'join_party_command']]],
        ['.botfriends', [['BuffService.command', 'player_pin', '.botfriends'], ['BotFriends.render', 'player_pin', 'friends', 0, null, { open: true }]]],
        ['.botfriends add', [['BuffService.command', 'player_pin', '.botfriends add'], ['BotFriends.render', 'player_pin', 'add', 0, null, { open: true }]]],
        ['/tell Ann hello you', [['BuffService.command', 'player_pin', '/tell Ann hello you'], ['World.messageBotByName', 'player_pin', true, 'Ann', 'hello you', 'chat_tell']]],
        ['.W Ann', [['BuffService.command', 'player_pin', '.W Ann'], ['World.messageBotByName', 'player_pin', true, '', '', 'chat_tell']]],
        ['.uitest', [['BuffService.command', 'player_pin', '.uitest'], ['UiTest.render', 'player_pin']]],
        ['.botstatus', [['BuffService.command', 'player_pin', '.botstatus'], ['BotStatus', 'player_pin', ['bot-status', undefined]]]],
        ['.bs Ann', [['BuffService.command', 'player_pin', '.bs Ann'], ['BotStatus', 'player_pin', ['bot-status', 'Ann']]]],
        ['.botpath Ann', [['BuffService.command', 'player_pin', '.botpath Ann'], ['BotPath', 'player_pin', ['bot-path', 'Ann']]]],
        ['/trade', [
            ['BuffService.command', 'player_pin', '/trade'],
            ['BotManager.findSessionById', 3000001],
            ['BotTrade.startPlayerTrade', 'player_pin', true],
            ['send', 'player_pin', { packet: 'tradeStart', target: 'Trader', items: ['item-a'] }]
        ]]
    ];
    for (const [text, expected] of commandCases) {
        const run = consume(player, { kind: 0, text });
        assert.strictEqual(run.result, undefined, `${text} returns nothing`);
        assert.deepStrictEqual(run.events, expected, `${JSON.stringify(text)} dispatch`);
    }

    // A failed trade start answers actionFailed and still does not broadcast.
    tradeResult = { ok: false };
    {
        const run = consume(player, { kind: 0, text: '.trade' });
        assert.deepStrictEqual(run.events, [
            ['BuffService.command', 'player_pin', '.trade'],
            ['BotManager.findSessionById', 3000001],
            ['BotTrade.startPlayerTrade', 'player_pin', true],
            ['send', 'player_pin', { packet: 'actionFailed' }]
        ]);
    }
    tradeResult = { ok: true };

    // A buff command the BuffService accepts stops the dispatch.
    buffHandles = true;
    {
        const run = consume(player, { kind: 0, text: ' .buff might ' });
        assert.deepStrictEqual(run.events, [['BuffService.command', 'player_pin', '.buff might']]);
    }
    buffHandles = false;

    // AFK trade command failures are logged, not thrown.
    afkFails = true;
    {
        const run = consume(player, { kind: 0, text: '.afksell' });
        assert.strictEqual(run.result, undefined);
        await tick();
        assert.deepStrictEqual(events.slice(run.events.length), [['infoWarn', 'AfkTrade', 'command failed: %s', 'begin boom']]);
        const stop = consume(player, { kind: 0, text: '.afkstop' });
        await tick();
        assert.deepStrictEqual(events.slice(stop.events.length), [['infoWarn', 'AfkTrade', 'stop command failed: %s', 'stop boom']]);
    }
    afkFails = false;

    // Kind 0 with no text: the dispatch throws at the first startsWith check
    // after the exact-match commands (current behaviour).
    events.length = 0;
    assert.throws(() => Speak.consume(player, { kind: 0 }), TypeError);
    assert.deepStrictEqual(events, [['BuffService.command', 'player_pin', '']]);

    // A throwing bot dialogue hook is logged and swallowed after the broadcast.
    botHookThrows = true;
    {
        const errors = [];
        console.error = (...args) => errors.push(args);
        let run;
        try {
            run = consume(player, { kind: 1, text: 'shout' });
        } finally {
            console.error = originalConsoleError;
        }
        assert.strictEqual(run.result, undefined);
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0][0], 'BotManager speak hook error:');
        assert.strictEqual(errors[0][1].message, 'hook boom');
    }
    botHookThrows = false;

    // The player chat log line comes first, with diagnostics on.
    {
        PopulationConfig.developerDiagnostics = true;
        PopulationConfig.devLogPlayerChat = true;
        const lines = [];
        console.info = (...args) => { lines.push(args); events.push(['log']); };
        let run;
        try {
            events.length = 0;
            run = consume(player, { kind: 2, text: '  a\n  b  ', target: 'TellBot' });
            consume(makeSession('bot_x', 'BotX', 2000010), { kind: 4, text: 'bot line' });
        } finally {
            console.info = originalConsoleInfo;
            PopulationConfig.developerDiagnostics = originalDiagnostics;
            PopulationConfig.devLogPlayerChat = originalLogChat;
        }
        assert.deepStrictEqual(run.events[0], ['log']);
        assert.deepStrictEqual(lines, [['PlayerChat :: %s kind=%s%s text="%s"', 'Pinner', 2, ' target="TellBot"', ' a b ']]);
    }
}

main()
    .then(() => console.log('Speak.consume pins passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => {
        global.invoke = originalInvoke;
        ServerResponse.actionFailed = originalActionFailed;
        ServerResponse.tradeStart = originalTradeStart;
        utils.infoWarn = originalInfoWarn;
        console.error = originalConsoleError;
        console.info = originalConsoleInfo;
    });
