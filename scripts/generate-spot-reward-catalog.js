#!/usr/bin/env node
'use strict';

// Lightweight companion to the offline combat table. It records NPC IDs
// and spawn weights only; no fights or reward Monte Carlo are run here.
const fs = require('node:fs');
const path = require('node:path');
const { buildCatalogue, rewardCatalog } = require('./generate-spot-table');
const file = path.resolve(__dirname, '../data/Bots/spot-reward-npcs.json');
const { profiles } = buildCatalogue();
const catalog = rewardCatalog(profiles);
fs.writeFileSync(file, `${JSON.stringify(catalog)}\n`);
console.log(`Wrote ${catalog.rows.length} native spot compositions`);
