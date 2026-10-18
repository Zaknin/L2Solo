'use strict';
// A near bot (its live character) and a far bot (its saved state) notice the
// same changes through the one fact function: the same bot gives the same
// facts on both paths; a buff or the day/night flip raises nothing; a full
// bag raises the bag fact (supply + sources) on both paths.
const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const GameTime = invoke('GameServer/World/GameTime');

const weapon = Data.items.find(row => Number(row.etc?.slot) === 7 && row.etc?.rank === 'd' && String(row.template?.kind || '').startsWith('Weapon'));
assert(weapon, 'fixture: a D-grade weapon');
let nextObject = 1;
function item(selfId, { amount = 1, equipped = false, slot = 0, stackable = false } = {}) {
    const id = nextObject++;
    return { fetchSelfId: () => selfId, fetchId: () => id, fetchAmount: () => amount, fetchEquipped: () => equipped,
        fetchStackable: () => stackable, fetchSlot: () => slot, fetchEnchantLevel: () => 0 };
}
function skill(selfId, level) {
    return { fetchSelfId: () => selfId, fetchLevel: () => level, fetchPassive: () => true };
}
const worn = item(Number(weapon.selfId), { equipped: true, slot: 7 });
const items = [worn, item(736, { amount: 3, stackable: true }), item(1060, { amount: 20, stackable: true })];
const backpack = { inventoryRevision: 1, fetchItems: () => items, fetchTotalLoad: () => 0,
    fetchEquippedWeapon: () => worn, fetchDwarvenCraftLevel: () => 0,
    fetchItemFromSelfId: id => items.find(row => row.fetchSelfId() === id) || null };
const skills = [skill(141, 2), skill(142, 1)];
const actor = { backpack, effects: {}, skillset: { fetchSkills: () => skills, fetchSkill: () => null },
    fetchId: () => 718301, fetchLevel: () => 20, fetchClassId: () => 1, fetchClanId: () => 5, fetchKarma: () => 0,
    fetchExp: () => Data.experience[19] + 1, fetchPk: () => 0, fetchSp: () => 0, fetchRace: () => 0, fetchMaxLoad: () => 80000,
    fetchHp: () => 500, isDead: () => false, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
const session = { actor, hennas: [null, null, null], questStates: new Map(), plan: 'hunting', currentSpot: { id: 'spot_a' },
    hotBackgroundPartyId: 77,
    coldLifeState: { characterId: 718301, level: 20, classId: 1, activity: 'hunting', spotId: 'spot_a',
        party: { partyId: 77, role: 'leader' }, vitals: { hp: 500 },
        stats: { classId: 1, clanId: 5, recipes: [3, 1], coldCombat: Profile.capture(actor) } } };
const farFacts = () => {
    const state = Economy.stateForActor(actor, session);
    return Sections.semanticFacts(state, null, Providers.recipeIds(state));
};

// The same bot, near and far: the same facts.
assert.deepEqual(Events.marksFor(session, actor).facts, farFacts(), 'near and far read the same facts');

// A buff and the day/night flip: no event (no decision input).
const realNow = Date.now;
let day = realNow(), night = day;
while (GameTime.isNight(day)) day += 60000;
while (!GameTime.isNight(night)) night += 60000;
try {
    Date.now = () => day;
    Events.observe(session, actor);
    const before = { ...session.coldLifeState.stats };
    actor.effects = { 1068: { id: 1068, key: 'might', stats: { pAtk: 1.15 }, expiresAt: night + 1200000 } };
    Date.now = () => night;
    Events.observe(session, actor);
    assert.equal(session.coldLifeState.stats.decisionSeq, before.decisionSeq, 'a buff at dusk raises nothing');
    assert.equal(session.coldLifeState.stats.wishDirty, before.wishDirty);
} finally { Date.now = realNow; }
const sectionBits = Sections.sectionMask(['supply', 'sources']);

// A full bag, far: the saved state's facts raise supply + sources.
const notFull = Economy.stateForActor(actor, session);
const filler = Array.from({ length: 80 }, () => item(1864));
items.push(...filler); backpack.inventoryRevision++;
const full = Economy.stateForActor(actor, session);
const farChanged = Sections.events({ ...notFull, stats: { ...notFull.stats, wishSections: undefined } },
    { ...full, stats: { ...full.stats, wishSections: undefined } });
assert(farChanged.includes('supply') && farChanged.includes('sources'), `a full bag is a far event: ${farChanged}`);
assert.notEqual(Sections.semanticFacts(full).bag, Sections.semanticFacts(notFull).bag);

// A full bag, near: the same fact raises the same sections.
items.splice(items.length - filler.length); backpack.inventoryRevision++;
Events.observe(session, actor);
const seq = Number(session.coldLifeState.stats.decisionSeq || 0);
session.coldLifeState.stats.wishDirty = 0;
items.push(...filler); backpack.inventoryRevision++;
Events.observe(session, actor);
assert.equal(session.coldLifeState.stats.decisionSeq, seq + 1, 'a full bag is one near event');
assert.equal(session.coldLifeState.stats.wishDirty & sectionBits, sectionBits, 'a full bag raises supply + sources near');
assert.deepEqual(Events.marksFor(session, actor).facts, farFacts(), 'a full bag reads the same near and far');
console.log('PASS near and far facts: one function / no buff or dusk event / full bag on both paths');
process.exit(0);
