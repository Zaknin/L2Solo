const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const Party = invoke('GameServer/Bot/AI/HotBackgroundParty');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Raid = invoke('GameServer/Bot/AI/BotRaidSafety');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const TownTransit = invoke('GameServer/Bot/AI/TownTransitPolicy');
const Retreat = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const Generics = invoke(path.actor);
const Geo = invoke('GameServer/Geodata/GeodataEngine');
DataCache.init();

// E70 for a hot party member (minimum.md #1): a member hit by mobs takes the
// danger moment before its hits gate, with the near members' damage; a
// member nobody hits, or one at full HP, keeps the author's potion rule.
const saved = [];
function replace(object, key, value) { const old = object[key]; saved.push(() => object[key] = old); object[key] = value; }
function item(selfId, amount) { return { fetchSelfId: () => selfId, fetchAmount: () => amount, fetchId: () => selfId + 100000 }; }
function actor(id, x) {
    return { x, hp: 100, potions: 0, used: [], effects: {},
        fetchId: () => id, fetchSelfId: () => id, fetchClassId: () => 0, fetchLevel: () => 10,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp() { return this.hp; }, fetchMaxHp: () => 100, fetchMp: () => 50, fetchMaxMp: () => 50,
        fetchPAtk: () => 100, fetchPDef: () => 100, fetchAtkSpd: () => 300, fetchMAtk: () => 10, fetchCastSpd: () => 333,
        fetchIsOnline: () => true, isDead() { return this.hp <= 0; }, canUseSkill: () => true,
        state: { seated: false, fetchSeated() { return this.seated; }, setSeated(v) { this.seated = v; },
            fetchDead: () => false, fetchCasts: () => false, fetchHits: () => false, fetchTowards: () => false },
        backpack: { owner: null, fetchItems() { return this.owner.potions ? [item(1060, this.owner.potions)] : []; },
            buildItemSkill: () => ({ fetchSelfId: () => 2031 }), useItem(_s, objectId) { this.owner.used.push(objectId); } },
        automation: { replenishVitals() {} }, select() {}, unselect() {}, moveTo(coords) { this.moved = coords; } };
}
try {
    replace(Geo, 'hasLineOfSight', () => true);
    const economy = () => ({ coldLifeState: { stats: { decisionSeq: 3 } }, economySeq: 3,
        heldEconomy: { deathHours: 0.5, riskWeight: 1.5, moneyPrice: 1 / 10000, network: { activity: null } } });
    const group = [1, 2].map(id => ({ accountId: `bot_hot_danger_${id}`, fetchAccountId() { return this.accountId; },
        hotBackgroundPartyId: 'danger', actor: actor(id, id * 100), dataSendToOthers() {}, ...economy() }));
    group.forEach(s => { s.actor.backpack.owner = s.actor; });
    const [leader, member] = group;
    const party = { partyId: 'danger', leaderId: 1, memberIds: [1, 2], status: 'hot', spotId: 'S',
        stats: { objective: { npcId: 20 } } };
    replace(Parties, 'find', () => party);
    replace(World, 'user', { sessions: [], revision: 0 });
    group.forEach(session => World.insertUser(session));
    // A strong mob on the member: alone or with the leader's damage it loses the race at 30% HP.
    const mob = { fetchId: () => 9001, fetchSelfId: () => 20, fetchKind: () => 'Monster', fetchAttackable: () => true,
        isDead: () => false, fetchHp: () => 100, fetchMaxHp: () => 100, destId: 2,
        fetchDestId() { return this.destId; }, fetchLocX: () => 250, fetchLocY: () => 0, fetchLocZ: () => 0,
        matchupTarget: { maxHp: 100, pAtk: 80, pDef: 100, atkSpd: 300, vulnerabilities: {} } };
    let scans = 0;
    replace(World, 'fetchNpcsInRadius', () => { scans++; return [mob]; });
    replace(Restrictions, 'canUseBasicAction', () => true);
    replace(Restrictions, 'canMove', () => true);
    replace(Raid, 'isProtectedRaidEntity', () => false);
    replace(Tactics, 'stop', () => {});
    replace(Tactics, 'support', () => false);
    replace(Spots, 'findById', () => ({ id: 'S', arrivalPoints: [] }));
    replace(Spots, 'containsLocation', () => true);
    replace(TownTransit, 'townAt', () => null);
    const retreats = [];
    replace(Retreat, 'retreat', (s, _bot, threat) => { retreats.push([s, threat]); return true; });
    const fights = [];
    const AI = { executeCombat: (s, _bot, target) => fights.push([s.actor.fetchId(), target.fetchId()]) };
    const tick = (s, now = 20000) => Party.tick(s, s.actor, Generics, AI, now);
    const reset = (hp, potions) => {
        member.actor.hp = hp; member.actor.potions = potions; member.actor.used = []; member.actor.effects = {};
        member.plan = 'hunting'; member.partyDangerFlee = false; member.dangerMoment = undefined;
        fights.length = 0; retreats.length = 0; scans = 0;
    };

    // Wounded, hit, a potion in the bag: it drinks instead of swinging on.
    reset(30, 3);
    assert.strictEqual(tick(member), true);
    assert.strictEqual(member.actor.used.length, 1, 'a hit party member losing the race drinks');
    assert.deepStrictEqual(fights, [], 'the drink takes the action');

    // No potion: it runs, and FleeingState owns it until the run ends.
    reset(30, 0);
    assert.strictEqual(tick(member), true);
    assert.strictEqual(member.plan, 'fleeing', 'without a potion a losing member runs');
    assert.strictEqual(member.lastDecision.action, 'party_danger_flee');
    assert.strictEqual(retreats.length, 1);
    assert.strictEqual(tick(member, 21000), false, 'the party tick yields to FleeingState during the run');
    member.plan = 'resting';
    mob.destId = 1; // the run shook the mob off
    assert.notStrictEqual(tick(member, 22000), false, 'the party takes the member back once the run ends');
    assert.strictEqual(member.partyDangerFlee, false);
    mob.destId = 2;

    // Full HP: no moment, one awareness scan only, the author's combat step.
    reset(100, 3);
    tick(member);
    assert.strictEqual(member.actor.used.length, 0);
    assert.deepStrictEqual(fights, [[2, 9001]], 'a full-HP member fights through executeCombat');
    assert.strictEqual(member.dangerMoment, undefined);

    // Nobody hits it (the mob is on the leader): no moment, the author's rule.
    reset(30, 3);
    mob.destId = 1;
    tick(member);
    assert.strictEqual(member.actor.used.length, 0, 'a member nobody hits takes no danger moment');
    assert.strictEqual(member.plan, 'hunting');
    assert.deepStrictEqual(fights, [[2, 9001]]);
    mob.destId = 2;

    // The leader's damage counts: against a mob the member alone loses to,
    // the pair wins the race and the member fights on.
    mob.matchupTarget = { ...mob.matchupTarget, pAtk: 40 };
    mob.fetchHp = () => 150;
    const DangerMoment = invoke('GameServer/Bot/AI/DangerMoment');
    reset(40, 0);
    const solo = DangerMoment.forActor(member, member.actor, mob, { attackers: [mob] });
    reset(40, 0);
    tick(member);
    assert.strictEqual(solo.action, 'flee', 'alone the member would run');
    assert.notStrictEqual(member.plan, 'fleeing', 'with the leader beside it the member fights on');
    assert.deepStrictEqual(fights, [[2, 9001]]);
    console.log('Hot background party danger moment: drink, run, full HP, unhit member and party damage passed');
} finally { saved.reverse().forEach(restore => restore()); }
