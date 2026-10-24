'use strict';

const Config = require('./ClanSimulationConfig');
const Policy = require('./ClanStrategyPolicy');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const Budget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const Database = invoke('Database');
const pending = new Map();
const MAX_PROMPT_TOKENS = 1800;
const MAX_COMPLETION_TOKENS = 128;
const SYSTEM = 'Choose one supplied strategic objective for this Lineage 2 clan. Consider the leader drive and traits (0..10), actual capable roster, money, current progress and recent outcomes. Ambition favors advancement; caution favors reserves and safe preparation; empathy favors weaker members; sociability favors recruitment; commitment favors finishing; resilience tolerates setbacks; assertiveness favors a focused direction. Preferences never override native safety or player authority. Costs and prerequisites are server facts. Keep useful progressing work. Return only the supplied choice ID and a reason code. The server owns execution.';

function configured() {
    const cfg = Gateway.config({ maxTokens: MAX_COMPLETION_TOKENS, timeoutMs: 10000, reasoningEffort: 'off' });
    return Config.llmGoalManagementEnabled !== false && Gateway.isConfigured(cfg) ? cfg : null;
}

function schema(candidates) {
    return { name: 'clan_strategy', schema: { type: 'object', properties: {
        choice: { type: 'string', enum: candidates.map(row => row.id) },
        reason: { type: 'string', enum: Policy.REASONS }
    }, required: ['choice', 'reason'], additionalProperties: false } };
}

async function inputsFor(clan) {
    const [warehouse, halls, contributions] = await Promise.all([
        Database.fetchClanWarehouseItems(clan.id), Database.fetchClanHallAuctions(),
        clan.level < 2 ? Database.fetchClanContributionSummary(clan.id, clan.level) : []
    ]);
    const economic = require('./ClanEconomyContext').forClan(clan, { warehouse, halls });
    return { warehouse, halls, contributed: Number(contributions[0]?.amount || 0), income: economic.incomePerHour };
}

async function generate(clan, snap, cfg) {
    const responseSchema = schema(snap.candidates);
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(snap.context) }];
    const estimated = Math.ceil(JSON.stringify({ messages, responseSchema }).length / 4);
    if (estimated > MAX_PROMPT_TOKENS) return { ok: false, reason: 'strategy_prompt_budget', estimated, requests: 0 };
    const admission = Budget.reserveForBotId(clan.leaderId, { event: 'clan_strategy', priority: 'background',
        estimatedPromptTokens: estimated, maxCompletionTokens: MAX_COMPLETION_TOKENS,
        maxRequests: 1, promptBudget: MAX_PROMPT_TOKENS, completionBudget: MAX_COMPLETION_TOKENS });
    if (!admission.ok) return { ok: false, reason: admission.reason, estimated, requests: 0 };
    let result;
    try {
        Budget.markStarted(admission.reservation);
        result = await Gateway.request({ config: cfg, circuitKey: 'clan-strategy',
            sessionId: `clan-strategy:${clan.id}`, requestId: `clan-strategy:${clan.id}:${snap.key}`,
            source: 'clan_strategy', botId: clan.leaderId, messages, responseSchema,
            maxPromptTokens: MAX_PROMPT_TOKENS, maxCompletionTokens: MAX_COMPLETION_TOKENS,
            maxTotalCompletionTokens: MAX_COMPLETION_TOKENS,
            // Generic JSON rescue expands to 2048 tokens. This two-field choice
            // instead falls back without a second generation.
            repairSchema: false });
        const choice = result.ok && snap.candidates.find(candidate => candidate.id === result.data?.choice);
        return { ok: !!choice, choice: choice || null, reason: choice ? result.data.reason : result.reason || 'invalid_strategy_choice',
            usage: result.usage || null, estimated, requests: Number(result.telemetry?.attempts || 1) };
    } catch (error) {
        return { ok: false, reason: 'strategy_provider_failed', estimated, requests: 1 };
    } finally { Budget.settle(admission.reservation, result?.usage); }
}

async function save(clan, strategy, eventType = null) {
    const saved = await Database.updateAutonomousClanStrategy({ clanId: clan.id, leaderId: clan.leaderId,
        expectedUpdatedAt: Number(clan.state?.updatedAt || 0), strategy, eventType });
    if (saved.ok) clan.state = saved.state;
    return saved;
}

async function review(clan, options = {}) {
    if (Config.strategicManagementEnabled === false || clan?.state?.mode !== 'autonomous'
        || clan.state.goal?.controlledBy === 'player' && clan.state.goal.status !== 'completed') return { ok: true, managed: false };
    const cfg = configured(), previous = Policy.active(clan);
    // Unconfigured installations retain the legacy deterministic lifecycle.
    if (!cfg && !previous && !options.force) return { ok: true, managed: false };
    const timestamp = options.now ?? Date.now();
    for (const [id, entry] of pending) if (timestamp - entry.createdAt > 60000) pending.delete(id);
    const inputs = options.inputs || await inputsFor(clan);
    let snap = Policy.snapshot(clan, inputs);
    const status = previous ? Policy.progress(previous, clan, inputs) : null;
    const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
    const committed = Equipment.activeRaidPartyForClan(clan.id) || Equipment.raidAssemblyCommitted(clan, clan.state.goal)
        || Equipment.raidAssemblyCommitted(clan, clan.state.productionGoal)
        || clan.state.goal?.plan?.kind === 'alliance_trial' && clan.state.goal.status !== 'completed' && Policy.trialReady(clan);
    if (previous && (committed || !pending.has(Number(clan.id)) && !Policy.shouldReview(previous, snap, status, timestamp))) {
        const next = { ...previous, ...status, progressAt: status.progress > previous.progress ? timestamp : previous.progressAt };
        if (JSON.stringify(next) !== JSON.stringify(previous)) {
            const result = await save(clan, next, status.status === 'completed' ? 'strategy_completed' : null);
            if (!result.ok) return result;
        }
        return { ok: true, managed: true, strategy: next, inputs };
    }
    if (committed) return { ok: true, managed: false };
    let entry = pending.get(Number(clan.id)), result = entry?.result;
    if (entry && !result) return { ok: true, managed: true, pending: true, reason: 'clan_llm_pending' };
    if (entry && entry.key !== snap.key) {
        // Let an old request settle before starting another. A changing world
        // uses a fresh deterministic choice and a persisted retry backoff.
        result = { ...result, ok: false, reason: 'strategy_inputs_changed' };
        entry.snapshot = snap;
    }
    if (!entry && cfg) {
        // Reuse the existing bounded native planner only at a strategic choice,
        // rather than hydrate routes on every cheap review.
        if (!options.inputs && clan.level >= 3) {
            const discovery = { ...clan, state: { ...clan.state, strategy: null } };
            const planning = await Equipment.planningForClan(discovery, clan.state.goal?.type === 'equipment'
                ? clan.state.goal : clan.state.productionGoal, options);
            await Equipment.validatePlanning(clan, planning);
            inputs.plans = planning.plans;
            snap = Policy.snapshot(clan, inputs);
        }
        if (snap.candidates.length > 1) {
            entry = { key: snap.key, createdAt: timestamp, snapshot: snap, result: null };
            pending.set(Number(clan.id), entry);
            entry.promise = generate(clan, snap, cfg).then(result => { entry.result = result; return result; });
            return { ok: true, managed: true, pending: true, reason: 'clan_llm_pending' };
        }
    }
    const decisionSnapshot = entry?.snapshot || snap;
    let choice = result?.ok ? result.choice : null;
    // A response is consumed only by the queue's fresh clan projection. The
    // transactional write fences membership/player/leader races after this read.
    if (choice && Policy.progress(choice, clan, inputs).status === 'blocked') choice = null;
    const failed = result && (!result.ok || !choice);
    const keepPrevious = failed && previous && previous.status !== 'blocked' && status.status === 'active';
    choice ||= keepPrevious ? previous : Policy.fallback(decisionSnapshot);
    const same = previous && previous.objective === choice.objective
        && Policy.hash(previous.target) === Policy.hash(choice.target);
    const history = [...(previous?.history || [])];
    if (previous && !same) history.push({ objective: previous.objective, status: status.status, reason: previous.reason });
    const usage = result?.usage || {};
    const strategy = { version: 1, objective: choice.objective, label: Policy.LABELS[choice.objective], target: choice.target,
        leaderKey: snap.leaderKey, inputKey: snap.key, selectedAt: same ? previous.selectedAt : timestamp,
        progressAt: same ? previous.progressAt : timestamp, lastStallReviewAt: timestamp,
        source: result?.ok && !failed ? 'llm' : same ? previous.source : 'deterministic',
        reason: keepPrevious ? previous.reason : result?.ok && !failed ? result.reason : 'leader_preference',
        history: history.slice(-3), lastDecisionAt: timestamp, retryAt: failed ? timestamp + Config.strategyRetryMs : 0,
        lastDecisionFailed: !!failed, failure: failed ? String(result.reason || 'strategy_unavailable') : null,
        inference: { requests: Number(previous?.inference?.requests || 0) + Number(result?.requests || 0),
            promptTokens: Number(previous?.inference?.promptTokens || 0) + Number(usage.promptTokens || 0),
            completionTokens: Number(previous?.inference?.completionTokens || 0) + Number(usage.completionTokens || 0),
            estimatedPromptTokens: result?.estimated || 0 } };
    Object.assign(strategy, Policy.progress(strategy, clan, inputs));
    const saved = await save(clan, strategy, same ? null : 'strategy_selected');
    if (saved.ok) pending.delete(Number(clan.id));
    return { ...saved, managed: true, strategy, inputs };
}

function waitingGoal(strategy) {
    return { type: 'strategy', status: strategy.status === 'completed' ? 'completed' : 'executing',
        goalKey: `clan-strategy:${strategy.objective}:${strategy.selectedAt}`,
        progress: strategy.progress, required: strategy.required, target: { name: strategy.label },
        plan: { kind: 'strategy_wait', label: strategy.label, reasonCode: strategy.reason } };
}

async function block(clan) {
    const current = Policy.active(clan);
    if (!current) return { ok: true };
    return save(clan, { ...current, status: 'blocked', reason: 'recovery', retryAt: 0 }, 'strategy_blocked');
}

module.exports = { review, block, inputsFor, configured, schema, waitingGoal, MAX_PROMPT_TOKENS, MAX_COMPLETION_TOKENS,
    async waitFor(clanId) { return pending.get(Number(clanId))?.promise || null; }, reset() { pending.clear(); } };
