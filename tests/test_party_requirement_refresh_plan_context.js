const assert = require('assert');

require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('party-refresh-plan-context');
require('../src/Global');
isolated.assertConfigured(options.default);

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');

DataCache.init();

// The party requirement refresh re-plans members between resolves. It must
// finalize those plans like every other planning path: a failed drop target
// keeps its cooldown ("Keep the failure on the acquisition plan so it survives
// travel, idle ticks and restarts"), and an unchanged route keeps its start
// time and progression baseline.
const weapon = DataCache.items.find((item) => String(item.etc?.rank) === 'd'
    && Number(item.etc?.slot) === 7 && String(item.template?.kind) === 'Weapon.Sword');
assert(weapon, 'fixture: a D-grade sword');
const npcId = 20001;
// Both members hold a usable weapon: an unarmed bot gets the weapon bridge first.
const held = (name) => {
    const item = DataCache.items.find((entry) => entry.template?.name === name);
    assert(item, `fixture: ${name}`);
    return { [item.selfId]: { selfId: Number(item.selfId), amount: 1, equipped: true, equippedSlots: [Number(item.etc.slot)], slot: Number(item.etc.slot) } };
};
const now = Date.now();
const failingMember = {
    characterId: 9200001, phase: 'cold',
    name: 'FailingDropMember',
    level: 30,
    inventory: held('Short Sword'),
    party: { partyId: 'bgp-refresh-context' },
    stats: {
        classId: 0,
        role: 'dps',
        targetCombat: { populationTargets: { [npcId]: { resolves: 10, targetKills: 0 } } },
        equipmentPlan: {
            status: 'active',
            strategy: 'direct_drop',
            grade: 'd',
            target: { selfId: Number(weapon.selfId), name: weapon.name, slot: 7 },
            next: { spotId: 'drop-spot', npcId, itemId: Number(weapon.selfId) },
            targetProgress: { npcId, resolves: 0, targetKills: 0 },
            expectedKills: 400,
            startedAt: now - 60 * 60 * 1000,
            plannedForLevel: 30,
            progressionBaseline: { level: 30, exp: 0 }
        }
    }
};
const craftStartedAt = now - 3 * 60 * 60 * 1000;
const craftBaseline = { level: 29, exp: 123456 };
const craftPlan = {
    status: 'component_ready',
    strategy: 'craft',
    grade: 'c',
    recipeId: 189,
    target: { selfId: 9301, name: 'Craft Target', slot: 7 },
    next: { spotId: 'material-spot', npcId: 20002, itemId: 1879 },
    startedAt: craftStartedAt,
    plannedForLevel: 29,
    progressionBaseline: craftBaseline
};
const craftMember = {
    characterId: 9200002, phase: 'cold',
    name: 'CraftMember',
    level: 30,
    exp: 200000,
    inventory: held('Short Sword'),
    party: { partyId: 'bgp-refresh-context' },
    stats: { classId: 0, role: 'dps', equipmentPlan: craftPlan }
};

const originals = {
    replacementPlanFor: GearAcquisitionPlanner.replacementPlanFor,
    planFor: GearAcquisitionPlanner.planFor,
    cachedStatesForParties: LifeState.cachedStatesForParties,
    cachedState: LifeState.cachedState,
    upsertState: LifeState.upsertState,
    leaveParty: LifeState.leaveParty,
    createOrUpdate: PartyState.createOrUpdate,
    recordMany: LifeEvents.recordMany,
    ensure: SpotProfiles.ensure,
    currentOccupancy: SpotProfiles.currentOccupancy
};

async function main() {
    // The refresh tests planner finalization. Supply a real funded gear
    // decision before instrumenting the two planner calls below.
    const native = require('./fixtures/native_gear_economy')({ characterId: failingMember.characterId, timestamp: now });
    const kit = require('./fixtures/profitable_stock_state').kitFor(0, failingMember.level);
    const armour = Object.fromEntries(Object.entries(kit.inventory).filter(([, row]) => Number(row.slot) !== 7));
    Object.assign(failingMember, { activity: native.member.activity, exp: native.member.exp,
        adena: native.member.adena, currentRegion: native.member.currentRegion, spotId: native.member.spotId,
        loc: { ...native.member.loc }, inventory: { ...armour, ...failingMember.inventory,
            57: { ...native.member.inventory[57] } } });
    const failedEconomy = native.review(failingMember);
    const failedWish = failedEconomy.network.queue.find(wish => wish.key === failedEconomy.network.activity?.rootKey);
    assert(failedEconomy.network.activity?.activity === 'shopping' && !failedEconomy.network.activity.funding
        && failedWish?.object?.slot && failedWish.funded && Array.isArray(failedEconomy.statsPacket.money),
        `native failed-drop gear decision: ${require('./fixtures/native_gear_economy').describe(failedEconomy)}`);

    const craftNative = require('./fixtures/native_gear_economy')({ characterId: craftMember.characterId, timestamp: now });
    const craftWish = craftNative.economy.network.queue.find(wish => wish.key === craftNative.economy.network.activity?.rootKey);
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByProductId(craftWish?.object?.itemId);
    assert(recipe && recipe.productId === craftWish.object.itemId && recipe.materials.length,
        'the actual native gear target has an authored recipe and materials');
    const target = DataCache.items.find(item => Number(item.selfId) === Number(recipe.productId));
    Object.assign(craftPlan, { recipeId: recipe.recipeId, grade: target.etc.rank,
        target: { selfId: recipe.productId, name: target.template.name, slot: craftWish.object.slot },
        next: { ...craftPlan.next, itemId: recipe.materials[0].selfId } });
    Object.assign(craftMember, craftNative.member, { stats: { ...craftNative.member.stats, equipmentPlan: craftPlan },
        party: { partyId: 'bgp-refresh-context' } });
    const craftEconomy = craftNative.review(craftMember);
    const refreshedWish = craftEconomy.network.queue.find(wish => wish.key === craftEconomy.network.activity?.rootKey);
    assert(craftEconomy.network.activity?.activity === 'shopping' && !craftEconomy.network.activity.funding
        && refreshedWish?.funded && refreshedWish.object?.itemId === recipe.productId,
        'the instrumented craft route targets the current funded native gear wish');

    const replacementOptions = [];
    const saved = new Map();
    const events = [];
    LifeEvents.recordMany = async (characterId, entries) => { events.push(...entries.map((entry) => ({ characterId, ...entry }))); };
    GearAcquisitionPlanner.replacementPlanFor = (_state, _previous, _spots, options) => {
        replacementOptions.push(options);
        return { status: 'active', strategy: 'market', grade: 'd',
            target: { selfId: 9302, name: 'Market Target', slot: 7 },
            market: { town: 'Giran', price: 1000, sourceType: 'npc' },
            next: { kind: 'market', town: 'Giran', itemId: 9302 } };
    };
    GearAcquisitionPlanner.planFor = () => ({
        status: 'active',
        strategy: 'craft',
        grade: craftPlan.grade,
        recipeId: craftPlan.recipeId,
        target: { ...craftPlan.target },
        next: { ...craftPlan.next },
        partyNeed: 'required',
        requiresParty: true,
        materials: []
    });
    const current = new Map([[failingMember.characterId, failingMember], [craftMember.characterId, craftMember]]);
    LifeState.cachedState = id => current.get(Number(id));
    LifeState.cachedStatesForParties = parties => new Map(parties.map(party => [party.partyId, party.memberIds.map(id => current.get(Number(id)))]));
    LifeState.upsertState = async (state) => {
        saved.set(Number(state.characterId), state.stats.equipmentPlan);
        current.set(Number(state.characterId), state);
        return state;
    };
    LifeState.leaveParty = async () => null;
    PartyState.createOrUpdate = async (party) => party;
    SpotProfiles.ensure = () => [];
    SpotProfiles.currentOccupancy = () => ({});

    const party = { partyId: 'bgp-refresh-context', status: 'active', leaderId: failingMember.characterId,
        memberIds: [failingMember.characterId, craftMember.characterId], spotId: 'drop-spot',
        stats: { lastRequirementRefreshAt: 0, objective: null } };
    await PopulationService.refreshBackgroundPartyRequirements([party]);
    assert.strictEqual(replacementOptions.length, 0, 'marking a refresh does not plan on main');
    const selections = [failingMember, craftMember].map(state => ({ characterId: state.characterId,
        plan: require('../src/GameServer/Bot/Population/PartyRequirementRefresh').plan(state,
            { occupancy: {}, timestamp: now,
                ...(state === failingMember ? { spots: native.spots, planningOptions: native.planningOptions,
                    preparedEconomy: failedEconomy } : { spots: craftNative.spots,
                    planningOptions: craftNative.planningOptions, preparedEconomy: craftEconomy }) }).acquisitionPlan }));
    await PopulationService.applyWorkerPartyRequirements(party, { memberPlans: selections, requirementRefreshedAt: now });

    assert.strictEqual(replacementOptions.length, 1, 'fixture: the failing drop route must be replaced');
    assert((replacementOptions[0].excludedTargetIds || []).includes(Number(weapon.selfId)),
        'the replacement must exclude the drop target that just failed');
    const failedPlan = saved.get(failingMember.characterId);
    assert(failedPlan, 'the changed requirement must be saved');
    assert((failedPlan.recoveryTargets || []).some((entry) => (
        Number(entry.targetId) === Number(weapon.selfId) && entry.reason === 'combat_unviable'
        && Array.isArray(entry.wake) && entry.wake.every(Number.isFinite) && entry.until === undefined
    )), 'the saved plan must carry the failed target dormant wake inputs');

    const refreshedCraft = saved.get(craftMember.characterId);
    assert(refreshedCraft, 'fixture: the craft route requirement changed and must be saved');
    assert.strictEqual(refreshedCraft.startedAt, craftStartedAt,
        'the same craft route must keep its start time');
    assert.deepStrictEqual(refreshedCraft.progressionBaseline, craftBaseline,
        'the same craft route must keep its progression baseline');
    assert.strictEqual(refreshedCraft.plannedForLevel, craftMember.level,
        'a refreshed plan must be stamped for the member level');
    console.log('Party requirement refresh plan context checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    Object.assign(GearAcquisitionPlanner, {
        replacementPlanFor: originals.replacementPlanFor, planFor: originals.planFor
    });
    Object.assign(LifeState, {
        cachedStatesForParties: originals.cachedStatesForParties, cachedState: originals.cachedState, upsertState: originals.upsertState, leaveParty: originals.leaveParty
    });
    PartyState.createOrUpdate = originals.createOrUpdate;
    LifeEvents.recordMany = originals.recordMany;
    Object.assign(SpotProfiles, { ensure: originals.ensure, currentOccupancy: originals.currentOccupancy });
    await invoke('Database').close();
    require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
});
