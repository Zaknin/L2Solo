const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

// A far bot that hunts alone has no other main pass that reviews its goal, so
// main keeps a due list (bot id -> nextReviewAt of its cached goal, fed by
// every goal write, GoalState.watch) and one timer armed at the earliest
// time. A fire reviews at most REVIEWS_PER_FIRE due bots and fires no closer
// than REVIEW_SPACING_MS after the last one (64 reviews/s at most: a restart
// makes every cached goal due at once). A due bot leaves the list; its next
// goal write puts it back.
const REVIEWS_PER_FIRE = 16;
const REVIEW_SPACING_MS = 250;
const due = new Map();
let armedAt = Infinity, lastFireAt = 0, timer = null;

function arm(at) {
    at = Math.max(at, lastFireAt + REVIEW_SPACING_MS);
    if (at >= armedAt) return;
    if (timer) clearTimeout(timer);
    armedAt = at;
    timer = setTimeout(fire, Math.max(0, at - Date.now()));
    timer.unref?.();
}

function fire() {
    timer = null;
    armedAt = Infinity;
    lastFireAt = Date.now();
    GoalService.reviewDue(lastFireAt);
}

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
            && economy && !economy.intentPending && !economy.routePending && !state.incomingPending) {
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
    },

    // The due list's fire: the due far solo bots' goals reviewed in one batch.
    // Each review builds the bot's economy on main (NeedsEvaluator ->
    // economyFor), once per due goal, not per commit.
    reviewDue(timestamp = Date.now()) {
        const states = [];
        let next = Infinity;
        for (const [id, at] of due) {
            if (at > timestamp || states.length >= REVIEWS_PER_FIRE) {
                next = Math.min(next, at);
                continue;
            }
            due.delete(id);
            const state = LifeState.cachedState(id);
            if (state?.phase === 'cold' && !state.party?.partyId) states.push(state);
        }
        if (next < Infinity) arm(next);
        if (!states.length) return Promise.resolve([]);
        return this.reviewBatch(states, { now: timestamp }).catch((err) => {
            utils.infoWarn('BotGoals', 'due goal review failed: %s', err.message);
            return [];
        });
    },

    // The due list's next fire time (Infinity: none armed).
    dueArmedAt() {
        return armedAt;
    },

    reviewBatch(states = [], options = {}) {
        const candidates = (states || []).filter((state) => state?.characterId && state.phase !== 'hot');
        if (!candidates.length) return Promise.resolve([]);
        const timestamp = Number(options.now) || Date.now();
        return Promise.all(candidates.map((state) => {
            const cached = GoalState.snapshot(state.characterId);
            return cached ? Promise.resolve(cached) : GoalState.load(state.characterId);
        })).then((existingGoals) => {
            const decisions = candidates.map((state, index) => {
                const stateOptions = typeof options.optionsForState === 'function'
                    ? { ...options, ...(options.optionsForState(state) || {}) }
                    : options;
                return {
                    state,
                    previous: existingGoals[index]?.current,
                    decision: reviewDecision(state, existingGoals[index], stateOptions, timestamp)
                };
            });
            const pending = decisions.filter(({ decision }) => !decision.unchanged).map(({ state, decision }) => ({
                characterId: state.characterId,
                goal: decision.goal, inputHash: decision.candidates[0]?.inputHash
            }));
            return GoalState.setBatch(pending).then((saved) => {
                const savedById = new Map(saved.map((snapshot) => [Number(snapshot.characterId), snapshot]));
                for (const { state, decision, previous } of decisions) {
                    const result = savedById.get(Number(state.characterId));
                    if (!decision.unchanged && result) invoke('GameServer/Bot/AI/BotClanChat').onGoal(state, result.current, previous, timestamp);
                }
                return decisions.map(({ state, decision }) => withCandidates(
                    decision.unchanged ? decision.result : savedById.get(Number(state.characterId)) || null,
                    decision.candidates, decision.economy));
            });
        });
    }
};

GoalService.reviewSpot = reviewSpot;

GoalState.watch = {
    put(characterId, nextReviewAt) {
        // No goal, no review time: a bot without one is not given one here.
        if (!nextReviewAt) {
            due.delete(characterId);
            return;
        }
        due.set(characterId, nextReviewAt);
        arm(nextReviewAt);
    },
    reset() {
        due.clear();
        if (timer) clearTimeout(timer);
        timer = null;
        armedAt = Infinity;
    }
};

module.exports = GoalService;
