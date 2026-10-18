'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const world = require('./fixtures/native_stock_world')();
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Income = require('../src/GameServer/Bot/Population/PartyIncomeComparison');
const Material = require('../src/GameServer/Bot/Population/CraftMaterialParty');
const Agreement = require('../src/GameServer/Bot/Population/PartyAgreement');
const Calculation = require('../src/GameServer/Bot/Population/PartyGoalCalculation');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const at = Date.now(), spotId = 'material-recruit-fixture';
const objective = { status: 'open', priority: 'required', reason: 'craft_material', materialParty: true,
    objectiveKey: `craft-material:${spotId}`, strategy: 'craft', spotId, npcId: 626,
    itemId: 4097, targetId: 5726, requiredTotal: 12, amount: 12 };
const original = { request: Coordinator.requestPartyGoals, prepare: Income.prepare,
    commit: DB.commitBackgroundPartyMembership, maxSize: Config.partyMaxSize };
let serial = 0, calls = 0;
async function seed(itemId = 4097, targetId = 5726, amount = 0) {
    const name = `MatRecruit${++serial}`, account = `bot_mat_recruit_${serial}`;
    await DB.createAccount(account, 'fixture');
    const id = Number((await DB.createCharacter(account, { name, classId: 8, race: 0, sex: 0, face: 0,
        hair: 0, hairColor: 0, maxHp: 100, maxMp: 100, locX: 0, locY: 0, locZ: 0 })).insertId);
    await DB.execute(['UPDATE characters SET level=65 WHERE id=?', [id]]);
    if (amount) await DB.setItem(id, { selfId: itemId, amount, name: 'Material', equipped: false, slot: 0 });
    return Life.upsertState({ characterId: id, accountName: account, name, level: 65, phase: 'cold', activity: 'hunting',
        spotId, loc: { locX: 0, locY: 0, locZ: 0 }, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        stats: { classId: 8, role: 'dps', equipmentPlan: { status: 'active', strategy: 'craft', target: { selfId: targetId, slot: 12 } },
            partyRequest: { ...objective, itemId, targetId, npcId: itemId === 4097 ? 626 : 627 } } }, 'material_recruit_seed');
}
function reply(party, members, timestamp, rejectId = null) {
    assert.equal(party.stats.recruitmentReview, true);
    const goals = Material.needs(members, objective, party.stats.agreement);
    const joint = { objective, memberGoals: members.map(member => ({ characterId: member.characterId,
        ...goals.find(goal => goal.characterId === member.characterId) })), lastIncomeReviewAt: timestamp,
    incomeReviews: members.map(member => ({ characterId: member.characterId,
        ...Income.evaluate({ solo: null, party: { income: 1000 }, cash: 5000 }),
        accept: member.characterId !== rejectId, at: timestamp, soloSource: null, partySource: 'table_party' })) };
    const response = { ok: true, sources: Calculation.sources(members), joint };
    assert(Protocol.validateEnvelope(Protocol.envelope('party_goal_result', 'recruit-fixture', response), 'worker').ok);
    return response;
}
async function stored() {
    const [row] = await DB.execute(['SELECT * FROM bot_background_parties WHERE partyId=?', ['material-recruit']]);
    return { ...row, stats: JSON.parse(row.statsJson) };
}
(async () => {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init(); await Parties.init();
    Config.partyMaxSize = 5;
    const a = await seed(4097, 5726, 4), b = await seed(4098, 5730, 8), novice = await seed();
    const contract = { ...Material.agreement([a, b], objective), cursor: 7 };
    contract.materialNeeds[0].collected = 4; contract.materialNeeds[1].collected = 8;
    const initial = Parties.prepareCommit({ partyId: 'material-recruit', status: 'active', leaderId: a.characterId,
        memberIds: [a.characterId, b.characterId], spotId, startedAt: at, nextResolveAt: at + 600000,
        stats: { objective, agreement: contract } });
    const assigned = [a, b].map(member => Life.preparePartyAssignment(member, initial.row.partyId, 'dps', a.characterId));
    const created = await DB.commitBackgroundPartyMembership({ party: initial.row, members: assigned });
    assert(created.ok, created.reason);
    created.lifeRows.forEach(row => Life.acceptNewerLifecycleRow(row)); Parties.acceptRow(created.partyRow);
    const materialParty = Parties.find('material-recruit');
    await Parties.createOrUpdate({ ...materialParty, stats: { ...materialParty.stats,
        objective: { status: 'open', reason: 'shared_target', spotId, npcId: objective.npcId }, agreement: { mode: 'turn' } } });
    const ordinary = await stored();
    Coordinator.requestPartyGoals = () => { throw Error('ordinary recruitment cannot admit an uncontracted material need'); };
    assert.equal((await Population.recruitBackgroundMembers([novice])).size, 0);
    assert.equal((await stored()).statsJson, ordinary.statsJson);
    assert.equal(JSON.parse((await stored()).memberIdsJson).length, 2);
    assert.equal(Life.cachedState(novice.characterId).stats.partyRequest.itemId, objective.itemId,
        'sharing a camp and NPC with an ordinary party cannot erase the material request');
    assert.equal(JSON.parse((await DB.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?',
        [novice.characterId]]))[0].statsJson).partyRequest.itemId, objective.itemId);
    await Parties.createOrUpdate(materialParty);
    const baseline = await stored();
    Income.prepare = () => { throw Error('recruitment forecast ran on main'); };
    Coordinator.requestPartyGoals = async () => { calls++; return { ok: false, reason: 'party_goal_busy' }; };
    assert.equal((await Population.recruitBackgroundMembers([novice])).size, 0);
    assert.equal((await stored()).statsJson, baseline.statsJson, 'busy worker changes neither contract nor membership');
    Coordinator.requestPartyGoals = async (party, members, options) => { calls++;
        return reply(party, members, options.timestamp, a.characterId); };
    assert.equal((await Population.recruitBackgroundMembers([novice])).size, 0, 'a retained member may refuse the changed delivery time');
    assert.equal((await stored()).statsJson, baseline.statsJson);
    Coordinator.requestPartyGoals = async (party, members, options) => { calls++;
        const result = reply(party, members, options.timestamp); result.sources[0].revision++;
        return result; };
    assert.equal((await Population.recruitBackgroundMembers([novice])).size, 0, 'wrong worker source never commits');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    Coordinator.requestPartyGoals = async (party, members, options) => {
        calls++;
        assert.deepEqual(party.stats.agreement.materialNeeds.map(goal => goal.collected), [4, 8, 0]);
        assert.equal(party.stats.agreement.materialNeeds[2].characterId, novice.characterId,
            'the worker forecasts with the newcomer need already in the proposed contract');
        await gate;
        return reply(party, members, options.timestamp);
    };
    const pending = Population.recruitBackgroundMembers([novice]);
    while (!release || calls < 4) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await stored()).statsJson, baseline.statsJson, 'no membership or quota is written before worker advice');
    release();
    assert.deepEqual([...(await pending)], [novice.characterId]);
    const committed = await stored();
    assert.equal(JSON.parse(committed.memberIdsJson).length, 3);
    assert.equal(committed.stats.agreement.cursor, 7);
    assert.deepEqual(committed.stats.agreement.materialNeeds.map(goal => goal.collected), [4, 8, 0]);
    assert.deepEqual(committed.stats.agreement.materialNeeds.map(goal => goal.quota), [12, 12, 12]);
    assert.equal(Life.cachedState(novice.characterId).stats.partyRequest, null,
        'native assignment may clear the request only after its need is durable in the party');
    assert.equal(committed.stats.recruitmentReview, undefined);
    const members = JSON.parse(committed.memberIdsJson).map(id => Life.cachedState(id));
    assert(members.every(member => member.party?.partyId === 'material-recruit'
        && member.stats.backgroundPartySpotId === undefined),
        'the atomic join seats retained members and newcomers; the party alone keeps its spot');
    const paid = { ...committed.stats.agreement, help: { status: 'funded', helperIds: [b.characterId], remaining: 999 } };
    const merged = Material.agreement(members, objective, paid);
    assert.deepEqual(merged.help, paid.help, 'merging needs never rewrites a funded escrow');
    assert.deepEqual(Material.agreement(members, objective, merged), merged, 'repeated merge cannot duplicate or reset a need');
    const fullOwner = { ...members[0], inventory: { 4097: { selfId: 4097, amount: 12 } } };
    const looted = Agreement.allocate([fullOwner, members[1], members[2]].map((state, index) => ({ state,
        result: { materialize: { items: index === 1 ? [{ selfId: 4097, amount: 2, partySpoil: true }] : [] } } })),
    committed.stats.agreement, { needScore: () => { throw Error('newcomer loot rebuilt wishes'); } });
    assert.equal(looted.memberResults[2].result.materialize.items[0].amount, 2, 'the newcomer receives its actual reserved component');
    assert.equal(looted.agreement.materialNeeds[2].collected, 2);
    console.log('PASS native recruitment commit: newcomer need, preserved progress, busy/refused/stale worker and bounded loot');

    const later = await seed(4098, 5730);
    Coordinator.requestPartyGoals = async (party, members, options) => { calls++; return reply(party, members, options.timestamp); };
    let rejected;
    DB.commitBackgroundPartyMembership = async request => {
        // A party-only write can race after main checked its cached source.
        // It changes no member row, so member CAS alone cannot protect it.
        await DB.execute(["UPDATE bot_background_parties SET updatedAt=updatedAt+1,statsJson=json_set(statsJson,'$.concurrent',1) WHERE partyId=?", ['material-recruit']]);
        const [row] = await DB.execute(['SELECT * FROM bot_background_parties WHERE partyId=?', ['material-recruit']]); Parties.acceptRow(row);
        rejected = await original.commit.call(DB, request); return rejected;
    };
    assert.equal((await Population.recruitBackgroundMembers([later])).size, 0);
    assert.equal(rejected.reason, 'party_recruitment_changed');
    assert.equal(JSON.parse((await stored()).memberIdsJson).length, 3);
    assert.equal((await stored()).stats.agreement.materialNeeds.length, 3);
    assert(!Life.cachedState(later.characterId).party?.partyId);
    DB.commitBackgroundPartyMembership = original.commit;
    const current = Parties.find('material-recruit');
    await Parties.createOrUpdate({ ...current, stats: { ...current.stats, pveEncounter: { pending: true } } });
    const beforeCombatCalls = calls;
    assert.equal((await Population.recruitBackgroundMembers([later])).size, 0);
    assert.equal(calls, beforeCombatCalls, 'an unfinished encounter does no recruitment work');
    assert.equal((await DB.execute(['PRAGMA integrity_check', []]))[0].integrity_check, 'ok');
    console.log('PASS native party-only CAS race rolls back all joins and preserves quotas; combat defers recruitment');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Coordinator.requestPartyGoals = original.request; Income.prepare = original.prepare;
    DB.commitBackgroundPartyMembership = original.commit; Config.partyMaxSize = original.maxSize;
    await world.close();
});
