const assert = require('assert');

const { createWorld } = require('./helpers/c4QuestHarness');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const HotPartyLifecycle = invoke('GameServer/Bot/Population/HotPartyLifecycle');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

function playerAt(locX, locY, locZ) {
    return {
        actor: {
            fetchLocX: () => locX,
            fetchLocY: () => locY,
            fetchLocZ: () => locZ
        }
    };
}

(async () => {
    // Main judges the state it holds: the bot is in its cache.
    const world = await createWorld([{ id: 7001 }], 'cold-visibility-handoff');
    await LifeState.init();
    const coordinator = new ColdSimulationCoordinator();
    coordinator.population = {
        realPlayerSessionsNear: () => [playerAt(1000, 2000, -4976)]
    };
    const visible = {
        characterId: 7001,
        activity: 'grouped',
        phase: 'cold',
        loc: { locX: 1200, locY: 2200, locZ: -4976 },
        stats: {},
        simulation: { revision: 1 }
    };
    await LifeState.upsertState(visible, 'visibility_fixture');
    assert.strictEqual(coordinator.visibleToRealPlayer(visible), true,
        'a cold actor on the player-visible floor must be protected from background resolution');
    assert.strictEqual(await coordinator.prepareProposal({
        characterId: visible.characterId,
        token: visible.simulation,
        nextState: { ...visible, activity: 'hunting' },
        result: { events: [] }
    }), null, 'a visible actor proposal must be rejected until hot activation owns it');

    assert.strictEqual(coordinator.visibleToRealPlayer({
        ...visible,
        loc: { locX: 20000, locY: 2200, locZ: -4976 }
    }), false, 'distant cold actors must remain eligible for background simulation');
    assert.strictEqual(coordinator.visibleToRealPlayer({ ...visible, activity: 'traveling' }), false,
        'persisted travel remains event-scheduled until hot route materialization exists');

    coordinator.population = { realPlayerSessionsNear: () => [] };
    const transitioning = {
        ...visible,
        party: { partyId: 'visible-party', leaderId: visible.characterId }
    };
    await LifeState.upsertState(transitioning, 'visibility_fixture');
    HotPartyLifecycle.pending.add('visible-party');
    try {
        assert.strictEqual(await coordinator.prepareProposal({
            characterId: transitioning.characterId,
            token: transitioning.simulation,
            nextState: transitioning,
            result: { events: [] }
        }), null, 'a party being handed to hot lifecycle must reject new cold proposals');
    } finally {
        HotPartyLifecycle.pending.delete('visible-party');
    }

    await world.close();
    console.log('Cold visibility handoff checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
