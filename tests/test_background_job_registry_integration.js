process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ClanConfig = invoke('GameServer/Clan/ClanSimulationConfig');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const BackgroundJobRegistry = invoke('GameServer/Bot/Population/BackgroundJobRegistry');

async function main() {
    const original = {
        registry: PopulationService.backgroundJobRegistry,
        resolveClanActions: PopulationService.resolveClanActions,
        resolveClanFounders: PopulationService.resolveClanFounders,
        backgroundJobTickMs: Config.backgroundJobTickMs,
        backgroundResolverEnabled: Config.backgroundResolverEnabled,
        clanEnabled: ClanConfig.enabled,
        clanIntervalMs: ClanConfig.resolveIntervalMs
    };

    try {
        PopulationService.backgroundJobRegistry?.stop();
        PopulationService.backgroundJobRegistry = null;
        Object.assign(Config, {
            backgroundJobTickMs: 250,
            backgroundResolverEnabled: true
        });
        ClanConfig.enabled = true;
        ClanConfig.resolveIntervalMs = 60000;
        let actionRuns = 0;
        let founderRuns = 0;
        PopulationService.resolveClanActions = async () => { actionRuns += 1; return {}; };
        PopulationService.resolveClanFounders = async () => { founderRuns += 1; return {}; };

        const registry = PopulationService.startBackgroundJobRegistry();
        await new Promise((resolve) => setImmediate(resolve));
        const snapshot = BackgroundJobRegistry.snapshot();
        assert.strictEqual(snapshot.registered, 2);
        assert.strictEqual(snapshot.tickMs, 250);
        assert.strictEqual(snapshot.jobs.clan_actions.offsetMs, 0);
        assert.strictEqual(snapshot.jobs.clan_actions.intervalMs, 1000, 'clan actions must poll for backlog continuation every governor window');
        for (const name of ['goal_stale_review', 'goal_warehouse_release', 'goal_market_reconcile', 'shot_economy']) {
            assert.strictEqual(snapshot.jobs[name], undefined, 'ordinary cold economy is decided in the worker');
        }
        assert.strictEqual(snapshot.jobs.clan_founders.offsetMs, 30000);
        assert.strictEqual(actionRuns, 1, 'only the zero-offset action pass should run at startup');
        assert.strictEqual(founderRuns, 0);
        registry.stop();
        PopulationService.backgroundJobRegistry = null;
        console.log('Background job registry integration checks passed');
    } finally {
        PopulationService.backgroundJobRegistry?.stop();
        PopulationService.backgroundJobRegistry = original.registry;
        PopulationService.resolveClanActions = original.resolveClanActions;
        PopulationService.resolveClanFounders = original.resolveClanFounders;
        Config.backgroundJobTickMs = original.backgroundJobTickMs;
        Config.backgroundResolverEnabled = original.backgroundResolverEnabled;
        ClanConfig.enabled = original.clanEnabled;
        ClanConfig.resolveIntervalMs = original.clanIntervalMs;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
