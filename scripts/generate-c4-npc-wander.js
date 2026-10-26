// Preserve source-only NPC classes that the gameplay catalog flattens to Monster.
const fs = require('fs');
const path = require('path');
const source = require('./lib/generate-c4-monster-location');

source.assertLisvusRevision();
const excludedTypes = new Set(['L2RaidBoss', 'L2GrandBoss', 'L2Minion', 'L2Chest',
    'L2Guard', 'L2SepulcherMonster', 'L2FestivalMonster']);
const groups = {};
for (const row of source.tuples('sql/npc.sql')) {
    if (!Number.isInteger(row[0])) continue;
    const reason = excludedTypes.has(row[11]) ? row[11]
        : String(row[4]).toLowerCase() === 'quest monster' ? 'QuestMonster' : null;
    if (reason) (groups[reason] ||= []).push(row[0]);
}
const metadata = { revision: 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975', groups };
// One compact array per source class keeps the generated list reviewable.
const content = JSON.stringify(metadata, (_key, value) => value, 2)
    .replace(/\[\s+([\d,\s]+)\s+\]/g, (_match, values) => `[${values.trim().split(/,\s*/).join(', ')}]`) + '\n';
const file = path.resolve(__dirname, '../data/Npcs/wander-exclusions.json');
if (process.argv.includes('--check')) {
    if (fs.readFileSync(file, 'utf8') !== content) throw new Error('NPC wander exclusions differ from pinned Lisvus');
} else fs.writeFileSync(file, content);
