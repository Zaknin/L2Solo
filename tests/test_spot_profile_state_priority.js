const assert = require('assert');

require('../src/Global');
// Load native data before the first economic route or combat profile check.
invoke('GameServer/DataCache').init();

const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

const originalCache = SpotProfiles.cache;
const originalBestSourceForPlan = GearAcquisitionPlanner.bestSourceForPlan;
SpotProfiles.cache = [
    {
        id: 'starter_human_01',
        avgLevel: 1,
        minLevel: 1,
        maxLevel: 3,
        density: 10,
        center: { locX: -84000, locY: 245000, locZ: -3729 }
    },
    {
        id: 'gear_source_01',
        avgLevel: 8,
        minLevel: 6,
        maxLevel: 10,
        density: 10,
        center: { locX: -110000, locY: 76000, locZ: -2800 }
    }
];

try {
    const equipmentPlan = {
        status: 'active',
        next: { spotId: 'gear_source_01' }
    };
    const atStarter = SpotProfiles.findForState({
        level: 1,
        spotId: 'starter_human_01',
        stats: { equipmentPlan, populationWave: 1, starterRegion: 'human' }
    });
    assert.strictEqual(atStarter.id, 'starter_human_01',
        'an active equipment plan must not replace a persisted physical starter spot');

    const unplaced = SpotProfiles.findForState({ level: 1, stats: { equipmentPlan } });
    assert.strictEqual(unplaced.id, 'gear_source_01',
        'a state without a physical spot may still select its equipment source');

    const crowded = {
        id: 'crowded_01', name: 'Crowded field', avgLevel: 8, minLevel: 6, maxLevel: 10,
        density: 10, capacity: 2, center: { locX: 1000, locY: 1000, locZ: 0 }
    };
    const alternate = {
        id: 'alternate_01', name: 'Available field', avgLevel: 8, minLevel: 6, maxLevel: 10,
        density: 10, capacity: 10, center: { locX: 2000, locY: 2000, locZ: 0 }
    };
    SpotProfiles.cache = [crowded, alternate];
    const occupancyByPresence = SpotProfiles.occupancySnapshot(SpotProfiles.cache, [
        { characterId: 4, activity: 'merchant', spotId: crowded.id },
        { characterId: 5, activity: 'shopping', spotId: crowded.id },
        { characterId: 6, activity: 'crafting', spotId: crowded.id },
        { characterId: 7, activity: 'traveling', spotId: crowded.id, stats: { travel: { reason: 'market_sale_inventory' } } },
        { characterId: 8, activity: 'traveling', stats: { travel: { spotId: crowded.id, reason: 'return_after_market' } } },
        { characterId: 9, activity: 'hunting', spotId: crowded.id },
        {
            characterId: 12,
            activity: 'hunting',
            spotId: alternate.id,
            stats: {
                equipmentPlan: {
                    status: 'active',
                    strategy: 'direct_drop',
                    next: { spotId: crowded.id }
                }
            }
        }
    ]);
    assert.strictEqual(occupancyByPresence[crowded.id].count, 2,
        'spot occupancy must include hunters and inbound travelers, not actors currently trading, crafting, or traveling to town');
    assert.strictEqual(occupancyByPresence[crowded.id].reservedCount, 3,
        'capacity admission must include durable farm intents without pretending that they are physically present');

    const reservation = {};
    assert.strictEqual(SpotProfiles.capacityFingerprint(reservation, 1), '',
        'an empty capacity snapshot must have an empty availability fingerprint');
    assert.strictEqual(SpotProfiles.reserveCapacity(reservation, crowded, [
        { characterId: 30, party: { partyId: 'atomic-party' } },
        { characterId: 31, party: { partyId: 'atomic-party' } }
    ]), true, 'a whole party that fits must reserve its destination atomically');
    assert.strictEqual(SpotProfiles.capacityFingerprint(reservation, 1), `${crowded.id}:0`,
        'the cheap availability fingerprint must observe reservations made on its cached snapshot');
    assert.strictEqual(SpotProfiles.reserveCapacity(reservation, crowded, [{ characterId: 32 }]), false,
        'a later planner decision must not overbook capacity already reserved in the same snapshot');

    const oversizedGroup = [{ characterId: 33 }, { characterId: 34 }, { characterId: 35 }];
    assert.strictEqual(SpotProfiles.hasCapacityForStates(crowded, oversizedGroup, {}), false,
        'an empty spot must still reject a group larger than its total capacity');

    const clanIntentStates = [40, 41, 42].map((characterId) => ({
        characterId,
        activity: 'hunting',
        spotId: alternate.id,
        stats: {
            clanPartyObjective: {
                status: 'open',
                clanGoalKey: 'clan-equipment:77:40:9001:7',
                spotId: crowded.id
            }
        }
    }));
    const clanIntentOccupancy = SpotProfiles.occupancySnapshot(SpotProfiles.cache, clanIntentStates);
    assert.strictEqual(clanIntentOccupancy[crowded.id].retained.size, 0,
        'an unformed clan roster that does not fit must lose admission as one atomic unit');

    const competingClanStates = [1, 2, 3].map((clanId) => ({
        characterId: 50 + clanId,
        activity: 'hunting',
        spotId: alternate.id,
        stats: {
            clanPartyObjective: {
                status: 'open',
                reason: 'clan_equipment',
                clanOperation: 'equipment',
                clanId,
                clanGoalKey: `clan-equipment:${clanId}:goal`,
                spotId: alternate.id
            }
        }
    }));
    const competingClanOccupancy = SpotProfiles.occupancySnapshot(SpotProfiles.cache, competingClanStates);
    assert.deepStrictEqual(
        [...competingClanOccupancy[alternate.id].retainedReservationKeys],
        ['clan-equipment:1', 'clan-equipment:2'],
        'only two deterministic clan equipment operations may reserve one sector'
    );
    assert.strictEqual(
        SpotProfiles.reserveCapacity(
            competingClanOccupancy,
            alternate,
            [{ characterId: 60 }],
            {
                reservationKey: 'clan-equipment:4',
                maxReservationGroups: SpotProfiles.MAX_CLAN_EQUIPMENT_RESERVATIONS_PER_SPOT
            }
        ),
        false,
        'same-snapshot clan planning must enforce the operation cap atomically'
    );

    const dangerous = {
        id: 'dangerous_01', name: 'Dangerous field', avgLevel: 8, minLevel: 6, maxLevel: 10,
        density: 10, capacity: 10, center: { locX: 3000, locY: 3000, locZ: 0 }
    };
    const safer = {
        id: 'safer_01', name: 'Safer field', avgLevel: 8, minLevel: 6, maxLevel: 10,
        density: 9, capacity: 10, center: { locX: 4000, locY: 4000, locZ: 0 }
    };
    SpotProfiles.cache = [dangerous, safer];
    GearAcquisitionPlanner.bestSourceForPlan = (state, plan, profiles, options) => (
        options.excludedSpotIds.has(dangerous.id)
            ? { spotId: safer.id }
            : { spotId: dangerous.id }
    );
    const deathPressured = {
        characterId: 20,
        level: 8,
        spotId: dangerous.id,
        stats: {
            deaths: 2,
            fightsResolved: 6,
            spotRisk: { spotId: dangerous.id, deathsAtEntry: 0, fightsAtEntry: 0 },
            equipmentPlan: { status: 'active', strategy: 'direct_drop', target: { selfId: 1 } }
        }
    };
    assert.strictEqual(
        SpotProfiles.findForState(deathPressured, { timestamp: 1000 }).id,
        safer.id,
        'death pressure must override an active equipment source and choose another available source'
    );
    const persistedBackoff = {
        ...deathPressured,
        spotId: safer.id,
        stats: {
            ...deathPressured.stats,
            spotRisk: { spotId: safer.id, deathsAtEntry: 2, fightsAtEntry: 6 },
            spotBackoffs: [{ spotId: dangerous.id, reason: 'death_pressure', startedAt: 1000, untilStep: 60 }]
        }
    };
    assert.strictEqual(
        SpotProfiles.findForState(persistedBackoff, { timestamp: 2000 }).id,
        safer.id,
        'a persisted backoff must stop the equipment plan from immediately pulling the bot back'
    );
    const expiredBackoff = { ...persistedBackoff, stats: { ...persistedBackoff.stats, stepCount: 60 } };
    assert.strictEqual(
        SpotProfiles.findForState(expiredBackoff, { timestamp: 5001 }).id,
        dangerous.id,
        'the original equipment source may be reconsidered after its cooldown expires'
    );

    const raid = {
        id: 'raid:999', name: 'Shared raid boss', avgLevel: 8, minLevel: 3, maxLevel: 10,
        density: 1, capacity: 999, raidBoss: true, raidBossTemplateId: 999,
        center: { locX: 5000, locY: 5000, locZ: 0 }
    };
    SpotProfiles.cache = [raid, safer];
    GearAcquisitionPlanner.bestSourceForPlan = originalBestSourceForPlan;
    assert.strictEqual(
        SpotProfiles.findForState({ characterId: 70, level: 8, spotId: raid.id }).id,
        safer.id,
        'an ordinary bot already placed on raid ground must evacuate to a normal hunting spot'
    );
} finally {
    SpotProfiles.cache = originalCache;
    GearAcquisitionPlanner.bestSourceForPlan = originalBestSourceForPlan;
}

console.log('Spot profile state-priority checks passed');
