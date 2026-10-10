const assert = require('assert');

require('../src/Global');
invoke('GameServer/DataCache').init();

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const RecruitmentChat = invoke('GameServer/Bot/Population/ColdPartyRecruitmentChat');

const originals = {
    statesForParty: LifeState.statesForParty, applyResolve: LifeState.applyResolve, leaveParty: LifeState.leaveParty,
    createOrUpdate: PartyState.createOrUpdate, findForState: SpotProfiles.findForState,
    resolve: PartyResolver.resolve, review: GoalService.review, beginMarketTravel: GoalExecutor.beginMarketTravel,
    announce: RecruitmentChat.maybeAnnounce
};

async function run() {
    const now = Date.now();
    const party = { partyId: 'market_break', leaderId: 1, memberIds: [1, 2, 3], spotId: 'cruma',
        stats: { formedAt: now - 5000, fightsResolved: 0, lastMarketBreakAt: now - 1000 } };
    const members = [1, 2, 3].map((characterId) => ({ characterId, name: `Bot${characterId}`, level: 20, party: { partyId: party.partyId, role: characterId === 1 ? 'tank' : 'dps' }, stats: {}, vitals: {} }));
    Object.assign(members[2], { level: 31, adena: 2000000,
        inventory: { 2370: { selfId: 2370, amount: 1, equipped: true, slot: 7 } },
        stats: { classId: 56, clanId: 1, money: [473405, 2.12e-6, 0, 0, 1.6e-5, 1226467, 166] } });
    const gearGoal = { type: 'upgrade_gear', target: { itemId: 166, itemSlot: 7, amount: 1 },
        plan: { expectedBenefit: 'market_search_for_gear', sourceType: 'npc', wishKey: 'power:166:7',
            estimatedCost: 1226467, valueRate: 1.6e-5 } };
    const Break = require('../src/GameServer/Bot/Population/PartyMarketBreak');
    const config = invoke('GameServer/Bot/Population/PopulationConfig');
    assert(Break.sessionReady(party, members[2], gearGoal, now, config), 'payable mandatory gear bypasses an ordinary party timer');
    assert(!Break.sessionReady(party, { ...members[2], adena: 1 }, gearGoal, now, config), 'an unfunded quote cannot bypass the timer');
    assert(!Break.sessionReady(party, members[2], { ...gearGoal, plan: { ...gearGoal.plan, sourceType: 'afk' } }, now, config),
        'a player quote retains the native party/trade admission rule');
    assert(!Break.sessionReady({ ...party, stats: { ...party.stats, objective: { priority: 'required', clanGoalKey: 'clan-duty' } } },
        members[2], gearGoal, now, config), 'clan duty keeps its own break policy');
    assert(!Break.sessionReady({ ...party, stats: { ...party.stats, objective: { sourceKind: 'raid' } } },
        members[2], gearGoal, now, config), 'a raid does not gain an early shopping break');
    assert(!Break.sessionReady(party, { ...members[2], inventory: { 166: { selfId: 166, amount: 1, equipped: true, slot: 7 } } },
        gearGoal, now, config), 'an already equipped D weapon is not a required kit gap');
    assert(!Break.sessionReady(party, members[2], null, now, config), 'ordinary errands retain the session limit');
    assert(Break.sessionReady({ ...party, stats: { formedAt: now - config.partyMarketBreakMinSessionMs - 1,
        fightsResolved: config.partyMarketBreakMinFights, lastMarketBreakAt: 0 } }, members[2], null, now, config),
    'ordinary shopping remains available after the existing session and fight thresholds');
    const savedParties = [];
    const departed = [];
    LifeState.statesForParty = () => Promise.resolve(members);
    LifeState.applyResolve = (state) => Promise.resolve(state);
    SpotProfiles.findForState = () => ({ id: 'cruma', name: 'Cruma Tower', route: {}, avgLevel: 20, rewards: {} });
    PartyResolver.resolve = () => ({ memberResults: members.map((state) => ({ state, result: { materialize: {}, patch: {}, nextResolveAt: 1 } })), partyPatch: { cohesion: .7, risk: .2, stats: {} }, events: [], nextResolveAt: 2, debug: {} });
    GoalService.review = (state) => Promise.resolve({ current: state.characterId === 3 ? gearGoal : null });
    GoalExecutor.beginMarketTravel = (state, goal) => goal ? { ...state, activity: 'traveling' } : null;
    LifeState.leaveParty = (state) => { departed.push(state.characterId); return Promise.resolve({ ...state, party: { ...state.party, partyId: null } }); };
    PartyState.createOrUpdate = (next) => { savedParties.push(next); return Promise.resolve(next); };
    RecruitmentChat.maybeAnnounce = (state) => ({ party: state, announced: false });

    const result = await PopulationService.resolveBackgroundParty(party);
    assert.strictEqual(result.ok, true, result.reason);
    assert.deepStrictEqual(departed, [3]);
    assert.deepStrictEqual(savedParties.at(-1).memberIds, [1, 2]);
    console.log('Bot party market break checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => Object.assign(LifeState, { statesForParty: originals.statesForParty, applyResolve: originals.applyResolve, leaveParty: originals.leaveParty }) && Object.assign(PartyState, { createOrUpdate: originals.createOrUpdate }) && Object.assign(SpotProfiles, { findForState: originals.findForState }) && Object.assign(PartyResolver, { resolve: originals.resolve }) && Object.assign(GoalService, { review: originals.review }) && Object.assign(GoalExecutor, { beginMarketTravel: originals.beginMarketTravel }) && Object.assign(RecruitmentChat, { maybeAnnounce: originals.announce }));
