const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');

// A far solo bot's goal has no timer: every consumer of it (tryPurchase,
// beginMarketTravel, reconcile, standingBuyNeed in PopulationService;
// BotAfkMarketService) sits in the command path and calls review() first.

function reviewSpot(state, explicitSpot = null, existingGoal = null) {
    if (explicitSpot) return explicitSpot;
    const spotId = state?.stats?.travel?.spotId
        || state?.stats?.marketReturn?.spotId
        || state?.spotId
        || existingGoal?.plan?.spotId
        || null;
    return spotId
        ? invoke('GameServer/Bot/Population/SpotProfiles').findById(spotId)
        : null;
}

// A goal served at the market: a sale, a material or gear purchase, an errand.
function isMarketGoal(goal) {
    return ['sell_inventory', 'buy_craft_material', 'market_errand'].includes(goal?.type)
        || ['market_search_for_weapon', 'market_search_for_gear'].includes(goal?.plan?.expectedBenefit);
}

function reviewDecision(state, existing, options, timestamp) {
    let economy = null;
    const candidates = NeedsEvaluator.evaluate(state, {
        ...options,
        spot: reviewSpot(state, options.spot, existing?.current),
        now: timestamp,
        onEconomy: context => { economy = context; options.onEconomy?.(context); }
    });
    const marketCandidate = candidates.find(isMarketGoal);
    const activeMarketGoal = isMarketGoal(existing?.current);
    // The inputHash is the economy build's input name: its decided facts and
    // market reads, not the bot's own plan (trip, town rhythm), a constant or
    // the caller. So this "unchanged" shortcut now keeps a goal whose economy
    // facts did not move where a moved own-plan value made it re-evaluate before.
    if (existing?.current?.nextReviewAt > timestamp && existing.current.status === 'active'
        && !marketCandidate && !activeMarketGoal
        && Number.isSafeInteger(existing.inputHash) && candidates[0]?.inputHash === existing.inputHash) return { result: existing, unchanged: true, goal: null, candidates, economy };

    const goal = GoalPlanner.plan(candidates, timestamp);
    if (!goal) {
        if (existing?.current?.type === 'sell_inventory'
            && ['planned', 'active', 'blocked'].includes(existing.current.status)
            && economy && !economy.intentPending && !state.incomingPending) {
            return { result: null, unchanged: false, candidates, economy,
                goal: { ...existing.current, status: 'abandoned', reviewedAt: timestamp, nextReviewAt: timestamp } };
        }
        return { result: null, unchanged: true, goal: null, candidates, economy };
    }
    if (existing?.current?.type === goal.type) goal.createdAt = existing.current.createdAt;
    return { result: null, unchanged: false, goal, candidates, economy };
}

// A review hands back the needs it evaluated and the economy it read (not
// stored), so the AFK market reconcile and the market trip that follow do not
// evaluate them again for the same state.
function withCandidates(snapshot, candidates, economy) {
    return snapshot ? { ...snapshot, candidates, economy } : null;
}

const GoalService = {
    initialized: false,

    init() {
        if (this.initialized) return Promise.resolve(true);
        return GoalState.init().then((ready) => {
            this.initialized = ready;
            if (ready) utils.infoSuccess('BotGoals', 'goal service initialized');
            return ready;
        });
    },

    snapshot(characterId) {
        return GoalState.snapshot(characterId);
    },

    revision(characterId) {
        return GoalState.revision(characterId);
    },

    current(characterId) {
        const cached = GoalState.snapshot(characterId);
        return cached ? Promise.resolve(cached) : GoalState.load(characterId);
    },

    async currentForMarket(state, options = {}) {
        const snapshot = await this.current(state.characterId);
        // Arrival can change the worker's selected step (for example, the
        // trip used the last escape scroll). Read that card before buying;
        // an active goal from departure must not become a false shop miss.
        if (state.activity !== 'shopping' && snapshot?.current?.status === 'active') return snapshot;
        return this.review(state, options);
    },

    complete(characterId) {
        return GoalState.clear(characterId, 'completed');
    },

    review(state, options = {}) {
        if (!state?.characterId || state.phase === 'hot') return Promise.resolve(null);
        const timestamp = Number(options.now) || Date.now();
        const cached = GoalState.snapshot(state.characterId);

        const choose = (existing) => {
            const decision = reviewDecision(state, existing, options, timestamp);
            if (decision.unchanged) return withCandidates(decision.result, decision.candidates, decision.economy);
            return GoalState.set(state.characterId, decision.goal, { inputHash: decision.candidates[0]?.inputHash }).then(saved => {
                if (saved) invoke('GameServer/Bot/AI/BotClanChat').onGoal(state, saved.current, existing?.current, timestamp);
                return withCandidates(saved, decision.candidates, decision.economy);
            });
        };

        return (cached ? Promise.resolve(cached) : GoalState.load(state.characterId)).then(choose);
    }
};

GoalService.reviewSpot = reviewSpot;

module.exports = GoalService;
