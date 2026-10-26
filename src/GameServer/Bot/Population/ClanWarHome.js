'use strict';
const finite = point => point && ['locX', 'locY', 'locZ'].every(key => point[key] != null && Number.isFinite(Number(point[key])));
const same = (a, b) => finite(a) && finite(b) && ['locX', 'locY', 'locZ'].every(key => Number(a[key]) === Number(b[key]));

// A cached spot id can outlive a visit to town. Keep a real home location
// only inside its spot; otherwise use that spot's known arrival geometry.
// Cold routing, native routing and completion must agree on this one anchor.
function point(operation, spot) {
    const Spots = invoke('GameServer/Bot/AI/SpotService');
    if (spot === undefined) spot = Spots.findById(operation.homeSpotId)
        || invoke('GameServer/Bot/Population/SpotProfiles').findById(operation.homeSpotId);
    const candidates = spot ? [operation.homeLoc, spot.center, ...(spot.arrivalPoints || []).slice(0, 8)] : [operation.homeLoc];
    const home = candidates.find(loc => finite(loc) && (!spot || Spots.containsLocation(spot, loc)));
    return home ? { locX: Number(home.locX), locY: Number(home.locY), locZ: Number(home.locZ) } : null;
}
module.exports = { point, same };
