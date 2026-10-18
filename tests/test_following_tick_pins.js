const assert = require('assert');
const fs = require('fs');
const nodePath = require('path');

// Pins the observable behaviour of FollowingState.tick (the party companion
// state) before it is split into phase methods (problem U36). Every phase
// entry and early return is driven with stubbed modules, a stubbed session,
// stubbed actors, a fixed clock and a fixed random source. Every outside
// effect is recorded in one ordered event log: each call into another module
// (with its arguments), each write or delete of a session field, each action
// on an actor, each read of the clock and of Math.random, and the effects of
// the asynchronous leader-target chain once its promises settle.
//
// The expected logs live in tests/fixtures/following_tick_pins.json. They
// were recorded from the unsplit tick (base a35dd169). Regenerate them only
// from that base: FOLLOWING_TICK_PINS_WRITE=1 node tests/test_following_tick_pins.js

const FIXTURE = nodePath.join(__dirname, 'fixtures', 'following_tick_pins.json');
const WRITE = process.env.FOLLOWING_TICK_PINS_WRITE === '1';

let events = [];
let cfg = { returns: {}, consts: {} };
const labels = new Map();

function ser(value, depth = 0) {
    if (value === undefined) return '<undefined>';
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (labels.has(value)) return `<${labels.get(value)}>`;
    if (typeof value === 'function') return '<fn>';
    if (value instanceof Promise) return '<promise>';
    if (depth > 4) return '<deep>';
    if (Array.isArray(value)) return value.map((entry) => ser(entry, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) out[key] = ser(value[key], depth + 1);
    return out;
}

function record(kind, ...args) {
    events.push([kind, ...args.map((arg) => ser(arg))]);
}

// One stub per module: any property is a recording function whose result
// comes from the scenario (cfg.returns['Module.fn']) or is undefined;
// cfg.consts supplies plain values (e.g. developerDiagnostics).
const moduleStubs = new Map();
function moduleStub(path) {
    if (moduleStubs.has(path)) return moduleStubs.get(path);
    const name = path.split('/').pop();
    const fns = new Map();
    const stub = new Proxy(function moduleFunction() {}, {
        apply(_target, _self, args) {
            record(`call ${name}()`, ...args);
            const impl = cfg.returns[`${name}()`];
            return impl ? impl(...args) : undefined;
        },
        get(_target, prop) {
            if (typeof prop === 'symbol' || prop === 'then') return undefined;
            const key = `${name}.${prop}`;
            if (Object.prototype.hasOwnProperty.call(cfg.consts, key)) return cfg.consts[key];
            if (!fns.has(prop)) {
                fns.set(prop, (...args) => {
                    record(`call ${key}`, ...args);
                    const impl = cfg.returns[key];
                    return impl ? impl(...args) : undefined;
                });
            }
            return fns.get(prop);
        }
    });
    labels.set(stub, name);
    moduleStubs.set(path, stub);
    return stub;
}

const realSpeckMath = require('../src/GameServer/SpeckMath');
const originalInvoke = global.invoke;
global.invoke = (path) => (path === 'GameServer/SpeckMath' ? realSpeckMath : moduleStub(path));

const membershipPath = require.resolve('../src/GameServer/World/PartyMembershipPublication');
const membershipModule = new (require('module'))(membershipPath);
membershipModule.filename = membershipPath;
membershipModule.loaded = true;
membershipModule.exports = (sessions) => record('call refreshPartyMemberships', sessions);
require.cache[membershipPath] = membershipModule;

const followingPath = require.resolve('../src/GameServer/Bot/AI/States/FollowingState');
delete require.cache[followingPath];
const FollowingState = require(followingPath);

function actor(label, fields) {
    const f = { id: 0, x: 0, y: 0, z: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100, level: 40,
        online: true, dead: false, seated: false, towards: null, hits: false, casts: false,
        karma: 0, pvpFlag: 0, attackable: true, destId: undefined, ...fields };
    const a = {
        f,
        name: label,
        fetchId: () => f.id,
        fetchName: () => label,
        fetchLocX: () => f.x,
        fetchLocY: () => f.y,
        fetchLocZ: () => f.z,
        fetchHp: () => f.hp,
        fetchMaxHp: () => f.maxHp,
        fetchMp: () => f.mp,
        fetchMaxMp: () => f.maxMp,
        fetchLevel: () => f.level,
        fetchIsOnline: () => f.online,
        fetchKarma: () => f.karma,
        fetchPvpFlag: () => f.pvpFlag,
        fetchAttackable: () => f.attackable,
        fetchDestId: () => f.destId,
        isDead: () => f.dead,
        canUseSkill: () => true,
        select: (target) => record(`${label}.select`, target),
        unselect: () => record(`${label}.unselect`),
        moveTo: (move) => record(`${label}.moveTo`, move),
        skillset: { fetchSkill: (id) => (f.skills || {})[id] },
        backpack: { fetchItems: () => [] },
        state: {
            fetchSeated: () => f.seated,
            fetchTowards: () => f.towards,
            fetchHits: () => f.hits,
            fetchCasts: () => f.casts,
            fetchCombats: () => false,
            fetchDead: () => f.dead,
            setSeated: (value) => { record(`${label}.state.setSeated`, value); f.seated = value; },
            setHits: (value) => { record(`${label}.state.setHits`, value); f.hits = value; },
            setCasts: (value) => { record(`${label}.state.setCasts`, value); f.casts = value; }
        },
        attack: {
            abortCast: () => record(`${label}.attack.abortCast`),
            clearTimers: () => record(`${label}.attack.clearTimers`),
            resetQueuedEvent: () => record(`${label}.attack.resetQueuedEvent`)
        },
        automation: { abortAll: () => record(`${label}.automation.abortAll`) }
    };
    labels.set(a, label);
    return a;
}

function skill(label, fields = {}) {
    const f = { selfId: 1, mp: 10, distance: 600, targetKind: 'single', ...fields };
    const s = {
        fetchSelfId: () => f.selfId,
        fetchName: () => label,
        fetchConsumedMp: () => f.mp,
        fetchDistance: () => f.distance,
        fetchTargetKind: () => f.targetKind,
        fetchHitTime: () => 1000
    };
    labels.set(s, label);
    return s;
}

// A session whose every field write and delete is recorded.
function recordedSession(label, initial) {
    const target = { ...initial };
    const proxy = new Proxy(target, {
        set(obj, key, value) {
            record(`${label}.set`, key, value);
            obj[key] = value;
            return true;
        },
        deleteProperty(obj, key) {
            record(`${label}.delete`, key);
            delete obj[key];
            return true;
        }
    });
    labels.set(proxy, label);
    return proxy;
}

function stubObject(label, impls = {}) {
    const fns = new Map();
    const stub = new Proxy({}, {
        get(_target, prop) {
            if (typeof prop === 'symbol' || prop === 'then') return undefined;
            if (!fns.has(prop)) {
                fns.set(prop, (...args) => {
                    record(`call ${label}.${prop}`, ...args);
                    return impls[prop] ? impls[prop](...args) : undefined;
                });
            }
            return fns.get(prop);
        }
    });
    labels.set(stub, label);
    return stub;
}

const NO_PULL = () => ({ enabled: false, target: null, puller: null, engageable: false, phase: null });

// A fresh world for one case: the leader (player, id 1) at the origin and
// the companion bot (id 101) 100 units away, both healthy.
function world(options = {}) {
    const player = actor('player', { id: 1, x: 0, y: 0, ...(options.player || {}) });
    const bot = actor('bot', { id: 101, x: 100, y: 0, ...(options.bot || {}) });
    const playerSession = recordedSession('leaderSession', { actor: player });
    const session = recordedSession('session', {
        partyCompanion: true,
        followPlayerSession: playerSession,
        plan: 'following',
        actor: bot,
        dataSendToOthers: (packet, from) => record('session.dataSendToOthers', packet, from),
        ...(options.session || {})
    });
    const role = options.role || 'dps';
    const members = [playerSession, session, ...(options.extraMembers || [])];
    cfg = {
        consts: {
            'PopulationConfig.developerDiagnostics': false,
            'BotBuffs.REFRESH_THRESHOLD_MS': 600000,
            'ShotStock.SHOT_IDS': [1835],
            'TownServiceCatalog.ROLES': { GENERIC_MERCHANT: 'generic_merchant' }
        },
        returns: {
            'PlayerPartyRaid.tick': () => false,
            'PartyRevivalService.tick': () => ({ handled: false }),
            'BotRoles.inferRole': (who) => (who === bot ? role : (options.roles?.[who?.fetchId?.()] || 'dps')),
            'BotRoles.partyRoleStance': (r) => `stance_${r}`,
            'BotRoles.shouldRestForMana': () => false,
            'BotRoles.usesCasterWeaponCombat': () => false,
            'BotRoles.hasMeleeWeapon': () => false,
            'BotRoles.needsPartyManaRecovery': () => true,
            'PartyCompanionService.getSettings': () => ({ combatMode: 'assist', pullMode: 'off' }),
            'PartyCompanionService.staysOutOfTown': () => false,
            'PartyCompanionService.regroupActive': () => false,
            'PartyCompanionService.formationTargetFor': () => null,
            'BotRaidSafety.syncPlayerPartyRaid': () => null,
            'BotRaidSafety.isProtectedRaidEntity': () => false,
            'BotRaidSafety.canEngagePlayerPartyRaid': () => true,
            'PartyAwareness.leaderCombatTargetId': () => undefined,
            'PartyAwareness.findThreatTargetingPartyProjected': () => null,
            'PartyAwareness.recentIncomingNpc': () => null,
            'PartyAwareness.partySessions': () => members,
            'PartyAwareness.partyActors': () => members.map((member) => member.actor),
            'PartyPulling.current': NO_PULL,
            'PartyPulling.travellingPullerAwayFromCamp': () => false,
            'PartyPulling.supportProviders': () => [],
            'PartyPulling.supportMembers': () => [],
            'PartyPulling.hasDeadPartyMember': () => false,
            'PartyPulling.actorCanEngage': () => false,
            'World.fetchNpcsInRadius': () => [],
            'EffectStore.impairments': () => ({}),
            'CompanionTownTransit.tick': () => ({ handled: false }),
            'CompanionTownTransit.sameTown': () => false,
            'BotBuffs.needsNewbieRefresh': () => false,
            'BotBuffs.missingNewbieBuffs': () => ['wind_walk'],
            'HotTownRebuff.syncVisit': () => null,
            'HotTownRebuff.needsVisit': () => false,
            'BotSupportPlanner.isUrgentPartyMusicRefresh': () => false,
            'PartyCombatLootPolicy.idleSupport': () => false,
            'PendingSweep.tick': () => false,
            'Response.sitAndStand': () => 'sit-stand-packet',
            'TownPathfinder.isInsideTown': () => false,
            'BotRetreatPlanner.retreat': () => ({ to: { locX: 400, locY: 0, locZ: 0 }, partyMovementAllowed: true }),
            ...(options.returns || {})
        }
    };
    const Generics = stubObject('Generics');
    const BotAI = stubObject('BotAI', options.botAI || {});
    return { player, bot, playerSession, session, Generics, BotAI, members };
}

let clock = 0;
const originalNow = Date.now;
const originalRandom = Math.random;
let randomState = 0;
function installClock(start) {
    clock = start;
    randomState = 0;
    Date.now = () => { events.push(['now']); return clock; };
    Math.random = () => {
        randomState = (randomState * 7 + 3) % 10;
        events.push(['random']);
        return randomState / 10;
    };
}
function restoreClock() {
    Date.now = originalNow;
    Math.random = originalRandom;
}

async function settle() {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Each case: build(w) prepares stubs, ticks is how many ticks run (the clock
// advances by step ms between them), then(w) changes the world between ticks,
// expect checks the final decision independently of the recorded log.
const cases = [];
function pin(name, spec) { cases.push({ name, ...spec }); }

const npc = (label, fields) => actor(label, { attackable: true, ...fields });

pin('not_companion_returns_to_hunting', {
    world: { session: { partyCompanion: false } },
    expect: (w) => assert.strictEqual(w.session.plan, 'hunting')
});

pin('leader_offline_returns_to_hunting', {
    world: { player: { online: false } },
    expect: (w) => assert.strictEqual(w.session.plan, 'hunting')
});

pin('player_party_raid_handles_tick', {
    world: { returns: { 'PlayerPartyRaid.tick': () => true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision, undefined)
});

pin('revival_handled', {
    world: { returns: { 'PartyRevivalService.tick': () => ({ handled: true, source: 'cast', targetId: 1 }) } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'resurrect_party')
});

pin('leader_dead_waits_for_resurrection', {
    world: { player: { dead: true } },
    expect: (w) => assert.deepStrictEqual([w.session.roleDecision.action, w.session.roleDecision.reason],
        ['wait_for_resurrection', 'awaiting_resurrection'])
});

pin('leader_dead_blocked_falls_through_to_combat', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 1 });
        w.cfg.returns['PartyRevivalService.tick'] = () => ({ handled: false, blockedBy: 'combat' });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'npc', actor: mob, targetId: 1 });
    },
    world: { player: { dead: true } },
    expect: (w) => assert.deepStrictEqual([w.session.roleDecision.action, w.session.roleDecision.reason],
        ['assist_leader', 'party_under_attack'])
});

pin('deliver_purchased_resources_pending_trade', {
    build: (w) => {
        w.session.pendingResourceDelivery = { playerSession: w.playerSession, playerId: 1, tradeId: 't1' };
        w.session.activeTrade = { id: 't1' };
    },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'trade_pending_confirmation')
});

pin('protected_raid_threat_retreats', {
    build: (w) => {
        const boss = npc('boss', { id: 600, x: 300 });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'raid', actor: boss, targetId: 1 });
        w.cfg.returns['BotRaidSafety.canEngagePlayerPartyRaid'] = () => false;
        w.cfg.returns['BotRaidSafety.retreat'] = () => true;
    },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'raid_entity_protected')
});

pin('engageable_raid_threat_becomes_assist', {
    build: (w) => {
        const boss = npc('boss', { id: 600, x: 300, destId: 1 });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'raid', actor: boss, targetId: 1 });
        w.cfg.returns['BotRaidSafety.syncPlayerPartyRaid'] = () => ({ phase: 'combat', bossId: 600 });
    },
    expect: (w) => assert.strictEqual(w.session.currentTargetId, 600)
});

pin('necromancer_summons_from_corpse', {
    build: (w) => {
        const corpse = npc('corpse', { id: 700, x: 120, dead: true });
        w.cfg.returns['SummonerTactics.corpseTarget'] = () => corpse;
    },
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'summon_corpse')
});

pin('disabled_by_debuff', {
    world: { returns: { 'EffectStore.impairments': () => ({ disabled: true }) }, session: { pendingSupportApproach: { targetId: 1 } } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'disabled')
});

pin('seated_bot_stands_for_threat', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 1 });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'npc', actor: mob, targetId: 1 });
    },
    world: { bot: { seated: true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'party_under_attack')
});

pin('rooted_bot_holds_position', {
    world: { bot: { x: 600 }, returns: { 'EffectStore.impairments': () => ({ rooted: true }) } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'rooted')
});

pin('karma_companion_waits_outside_town', {
    world: { session: { lastFollowMoveTarget: { locX: 1, locY: 1 } }, returns: { 'PartyCompanionService.staysOutOfTown': () => true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'karma_keeps_out_of_town')
});

pin('intertown_gatekeeper_transit', {
    world: { bot: { x: 9000 }, returns: { 'CompanionTownTransit.tick': () => ({ handled: true, transit: { sourceTown: 'Gludin', targetTown: 'Dion' } }) } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'intertown_gatekeeper')
});

pin('far_companion_catches_up_by_teleport', {
    world: { bot: { x: 9000 } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'catch_up')
});

pin('far_companion_in_same_town_walks', {
    world: { bot: { x: 9000 }, returns: { 'CompanionTownTransit.sameTown': () => true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'keep_range')
});

pin('stuck_companion_unsticks_after_three_samples', {
    world: { bot: { x: 600, towards: 'move' } },
    ticks: 3,
    step: 800,
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'unstuck')
});

pin('pending_support_approach_casts', {
    build: (w) => {
        const heal = skill('heal', { selfId: 1011, distance: 600 });
        w.bot.f.skills = { 1011: heal };
        w.session.pendingSupportApproach = { targetId: 1, skillId: 1011, kind: 'top_off', startedAt: 99000, ctrl: false };
        w.player.f.hp = 50;
    },
    role: 'healer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'cast_heal')
});

pin('pending_support_yields_to_threat', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 1 });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'npc', actor: mob, targetId: 1 });
        w.session.pendingSupportApproach = { targetId: 1, skillId: 1011, kind: 'buff:haste', startedAt: 99000 };
    },
    world: { bot: { towards: 'remote' } },
    expect: (w) => assert.strictEqual(w.session.pendingSupportApproach, undefined)
});

pin('returns_to_party_after_support', {
    world: { bot: { x: 600 }, session: { returnToPartyAfterSupport: true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'return_after_support')
});

pin('leader_sitting_far_moves_near', {
    world: { bot: { x: 600, seated: true }, player: { seated: true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'leader_moved')
});

pin('leader_sitting_far_standing_bot_moves_near', {
    world: { bot: { x: 600 }, player: { seated: true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'move_near_sitting_leader')
});

pin('leader_sitting_near_bot_sits', {
    world: { player: { seated: true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'leader_sitting')
});

pin('leader_stood_bot_stands', {
    world: { bot: { seated: true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'leader_stood_ready')
});

pin('low_hp_sits_to_rest', {
    world: { bot: { hp: 20 } },
    expect: (w) => assert.strictEqual(w.session.plan, 'resting')
});

pin('low_mp_recovers_at_newbie_guide', {
    world: {
        bot: { mp: 10, level: 15 },
        returns: { 'BotRoles.shouldRestForMana': () => true },
        botAI: { getClosestNewbieGuide: () => ({ locX: 0, locY: 0 }) }
    },
    expect: (w) => assert.strictEqual(w.session.plan, 'getting_buffed')
});

pin('newbie_buffs_refresh_at_guide', {
    world: {
        returns: { 'BotBuffs.needsNewbieRefresh': () => true, 'TownPathfinder.isInsideTown': () => true },
        botAI: { getClosestNewbieGuide: () => ({ locX: 0, locY: 0 }) }
    },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'newbie_blessing')
});

pin('newbie_buffs_wait_for_guide_town_then_ready', {
    world: { returns: { 'BotBuffs.needsNewbieRefresh': () => true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'wait_for_newbie_guide_town')
});

pin('newbie_buffs_wait_for_route_retry', {
    world: {
        session: { newbieGuideRetryAt: 200000 },
        returns: { 'BotBuffs.needsNewbieRefresh': () => true, 'TownPathfinder.isInsideTown': () => true },
        botAI: { getClosestNewbieGuide: () => ({ locX: 0, locY: 0 }) }
    },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'wait_for_newbie_guide_route')
});

pin('town_errand_equipment_purchase', {
    world: {
        returns: {
            'TownPathfinder.isInsideTown': () => true,
            'CompanionEquipmentShopping.planErrand': () => ({ kind: 'npc_equipment_purchase', itemName: 'Sword', itemId: 5, target: { town: 'Gludin', name: 'Smith' } })
        },
        botAI: { getClosestTown: () => ({ x: 0, y: 0, name: 'Gludin' }) }
    },
    expect: (w) => assert.strictEqual(w.session.plan, 'shopping')
});

pin('town_visit_rebuff', {
    world: {
        returns: { 'HotTownRebuff.syncVisit': () => ({ town: 'Gludin', key: 'v1' }), 'HotTownRebuff.needsVisit': () => true }
    },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'town_visit_rebuff')
});

pin('support_buff_cast_and_rebuff_request', {
    build: (w) => {
        const haste = skill('haste', { selfId: 1086, mp: 20 });
        const provider = actor('provider', { id: 102 });
        w.cfg.returns['BotSupportPlanner.nextAction'] = () => ({ effect: 'haste', target: w.player, skill: haste });
        w.cfg.returns['BotSupportPlanner.rebuffRequest'] = () => ({ provider, skill: skill('might', { selfId: 1068 }) });
    },
    role: 'buffer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'cast_support')
});

pin('support_buff_waits_for_mp', {
    build: (w) => {
        const haste = skill('haste', { selfId: 1086, mp: 200 });
        w.cfg.returns['BotSupportPlanner.nextAction'] = () => ({ effect: 'haste', target: w.player, skill: haste });
    },
    role: 'buffer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'low_mp_for_buff')
});

function healerWorld(w, { playerHp = 30, botMp = 100 } = {}) {
    w.player.f.hp = playerHp;
    w.bot.f.mp = botMp;
    w.cfg.returns['BotSkillCapabilities.selectHealSkill'] = (_bot, opts) => (opts?.group ? null : skill(opts?.emergency ? 'greater_heal' : 'heal', { selfId: opts?.emergency ? 1217 : 1011 }));
    w.cfg.returns['BotSkillCapabilities.manaRechargeSkill'] = () => skill('recharge', { selfId: 1013 });
}

pin('healer_emergency_heal', {
    build: (w) => healerWorld(w),
    role: 'healer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'emergency_heal')
});

pin('healer_top_off', {
    build: (w) => healerWorld(w, { playerHp: 60 }),
    role: 'healer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'top_off')
});

pin('healer_saves_mp', {
    build: (w) => healerWorld(w, { playerHp: 60, botMp: 20 }),
    role: 'healer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'party_not_critical')
});

pin('healer_recharges_party_mp', {
    build: (w) => { healerWorld(w, { playerHp: 100 }); w.player.f.mp = 10; },
    role: 'healer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'recharge_party')
});

pin('healer_personal_threat_control', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 101 });
        w.cfg.returns['PartyAwareness.recentIncomingNpc'] = () => mob;
        w.cfg.returns['PartyClassTactics.supportCrowdControl'] = () => ({ reason: 'sleep', target: mob, skill: skill('sleep', { selfId: 1069 }) });
    },
    role: 'healer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'defend_self')
});

pin('healer_personal_threat_retreat', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 101 });
        w.cfg.returns['World.fetchNpcsInRadius'] = () => [mob];
    },
    role: 'healer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'personal_attack_no_control')
});

pin('critical_hp_retreats_from_threat', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 101 });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'npc', actor: mob, targetId: 101 });
    },
    world: { bot: { hp: 20 } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'critical_hp_under_attack')
});

pin('bot_puller_handles_pull', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 1500 });
        const pulling = () => ({ enabled: true, target: mob, puller: { kind: 'bot', session: w.session, actor: w.bot }, engageable: false, phase: 'approach' });
        w.cfg.returns['PartyPulling.current'] = pulling;
        w.cfg.returns['PartyPulling.tickBotPuller'] = () => ({ handled: true, action: 'approach', target: mob });
    },
    role: 'tank',
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'party_pull')
});

pin('companion_holds_for_pull', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 1500 });
        const puller = actor('puller', { id: 103 });
        w.cfg.returns['PartyPulling.current'] = () => ({ enabled: true, target: mob, puller: { kind: 'bot', session: {}, actor: puller }, engageable: false, phase: 'return' });
    },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'hold_for_pull')
});

pin('tank_taunts_leader_attacker', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 1 });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'npc', actor: mob, targetId: 1 });
        w.cfg.returns['BotSkillCapabilities.aggressionSkill'] = () => skill('aggression', { selfId: 28 });
    },
    role: 'tank',
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'protect_leader')
});

pin('tank_auto_pulls_safe_target', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 300 });
        w.cfg.returns['PartyCompanionService.getSettings'] = () => ({ combatMode: 'assist', pullMode: 'auto' });
        w.cfg.returns['World.fetchNpcsInRadius'] = () => [mob];
        w.cfg.returns['BotHuntingVisibility.select'] = (_s, _k, _b, candidates) => ({ candidate: candidates[0] });
    },
    role: 'tank',
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'pull_target')
});

pin('class_tactic_self_action', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 1 });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'npc', actor: mob, targetId: 1 });
        w.cfg.returns['PartyClassTactics.selfAction'] = () => ({ reason: 'frenzy', target: w.bot, skill: skill('frenzy', { selfId: 176 }) });
    },
    expect: (w) => assert.strictEqual(w.session.roleDecision.action, 'class_tactic')
});

pin('dps_assists_party_threat', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 1 });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'npc', actor: mob, targetId: 1 });
    },
    expect: (w) => assert.strictEqual(w.session.currentTargetId, 500)
});

pin('buffer_holds_support_line', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 150, destId: 1 });
        w.cfg.returns['PartyAwareness.findThreatTargetingPartyProjected'] = () => ({ type: 'npc', actor: mob, targetId: 1 });
    },
    role: 'buffer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'hold_support_line')
});

pin('idle_support_marks_combat_loot_ready', {
    world: { returns: { 'PartyCombatLootPolicy.idleSupport': () => true } },
    expect: (w) => assert.strictEqual(w.session.partyCombatLootReadyAt, 100000)
});

pin('pending_sweep_loot_acts', {
    world: { returns: { 'PendingSweep.tick': () => true } },
    expect: (w) => assert.strictEqual(w.session.roleDecision, undefined)
});

pin('leader_pvp_target_async', {
    build: (w) => {
        const enemy = actor('enemy', { id: 9, x: 200, karma: 5 });
        w.cfg.returns['PartyAwareness.leaderCombatTargetId'] = () => 9;
        w.cfg.returns['World.fetchUser'] = () => Promise.resolve(enemy);
    },
    expect: (w) => assert.strictEqual(w.session.currentTargetId, 9)
});

pin('leader_npc_target_async', {
    build: (w) => {
        const mob = npc('mob', { id: 500, x: 200 });
        w.cfg.returns['PartyAwareness.leaderCombatTargetId'] = () => 500;
        w.cfg.returns['World.fetchUser'] = () => Promise.reject(new Error('not a user'));
        w.cfg.returns['World.fetchNpc'] = () => Promise.resolve(mob);
    },
    expect: (w) => assert.strictEqual(w.session.currentTargetId, 500)
});

pin('leader_target_missing_async', {
    build: (w) => {
        w.session.currentTargetId = 500;
        w.cfg.returns['PartyAwareness.leaderCombatTargetId'] = () => 500;
        w.cfg.returns['World.fetchUser'] = () => Promise.reject(new Error('not a user'));
        w.cfg.returns['World.fetchNpc'] = () => Promise.reject(new Error('gone'));
    },
    expect: (w) => assert.strictEqual(w.session.currentTargetId, undefined)
});

pin('support_leader_target_holds_line', {
    world: { returns: { 'PartyAwareness.leaderCombatTargetId': () => 500 } },
    role: 'healer',
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'hold_support_line')
});

pin('idle_follow_keeps_range', {
    world: { bot: { x: 600 } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'keep_range')
});

pin('idle_follow_keeps_current_move', {
    world: { bot: { x: 600, towards: 'move' }, session: { lastFollowMoveTarget: { locX: 0, locY: 0, locZ: 0 } } },
    expect: (w) => assert.strictEqual(w.session.lastFollowMoveHeldAt, 100000)
});

pin('idle_follow_rooted_by_regroup', {
    world: { returns: { 'PartyCompanionService.regroupActive': () => true, 'EffectStore.impairments': () => ({ rooted: true }) } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'rooted')
});

pin('idle_ready_near_leader', {
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'ready')
});

pin('stay_order_returns_to_stay_point', {
    world: { session: { botStay: true, stayLocation: { locX: 900, locY: 0, locZ: 0 } } },
    expect: (w) => assert.strictEqual(w.session.roleDecision.reason, 'stay_order')
});

async function runCase(spec) {
    events = [];
    const w = world({ ...(spec.world || {}), role: spec.role || spec.world?.role });
    w.cfg = cfg;
    installClock(100000);
    try {
        events.push(['setup']);
        if (spec.build) spec.build(w);
        const ticks = spec.ticks || 1;
        for (let i = 0; i < ticks; i++) {
            events.push(['tick', i]);
            const result = FollowingState.tick(w.session, w.bot, w.Generics, w.BotAI);
            events.push(['return', ser(result)]);
            await settle();
            clock += spec.step || 1000;
        }
        spec.expect(w);
    } finally {
        restoreClock();
    }
    return events;
}

(async () => {
    const expected = WRITE ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const recorded = {};
    let failures = 0;
    for (const spec of cases) {
        try {
            const log = await runCase(spec);
            recorded[spec.name] = log;
            if (!WRITE) {
                assert.ok(expected[spec.name], `no pinned log for ${spec.name}`);
                assert.deepStrictEqual(log, expected[spec.name]);
            }
            console.log(`ok ${spec.name} (${log.length} events)`);
        } catch (error) {
            failures++;
            console.error(`FAIL ${spec.name}: ${error.message.split('\n').slice(0, 12).join('\n')}`);
        }
    }
    if (!WRITE) assert.deepStrictEqual(Object.keys(expected).sort(), cases.map((spec) => spec.name).sort(),
        'every pinned log must have a case');
    if (WRITE && failures === 0) {
        // One event per line keeps a changed pin readable in a diff.
        const body = Object.entries(recorded).map(([name, log]) => (
            `${JSON.stringify(name)}: [\n${log.map((event) => `  ${JSON.stringify(event)}`).join(',\n')}\n ]`
        )).join(',\n ');
        fs.writeFileSync(FIXTURE, `{\n ${body}\n}\n`);
        console.log(`wrote ${FIXTURE}`);
    }
    global.invoke = originalInvoke;
    if (failures) {
        console.error(`${failures} following tick pin(s) failed`);
        process.exitCode = 1;
        return;
    }
    console.log(`All ${cases.length} following tick pins passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
