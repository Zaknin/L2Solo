'use strict';
const Flow = require('./MarketTradeDemand');
const SHOTS = new Set([1463, 1464, 1465, 1466, 1467, 2510, 2511, 2512, 2513, 2514, 3948, 3949, 3950, 3951, 3952]);
const isShot = id => SHOTS.has(Number(id));
// Production uses the same public flow as listings, limited to ammunition.
module.exports = { ...Flow, isShot,
    deal: (id, ...args) => isShot(id) ? Flow.deal(id, ...args) : null,
    forecast: (id, ...args) => isShot(id) ? Flow.forecast(id, ...args) : null,
    towns: (id, ...args) => isShot(id) ? Flow.towns(id, ...args) : [] };
