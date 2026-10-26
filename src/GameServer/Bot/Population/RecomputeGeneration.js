'use strict';

const { isMainThread } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const Rates = require('../../ProgressionRates');
let initialized = false, metadata = null, lastProfile = null, identity = null;
const digest = value => createHash('sha256').update(value).digest('hex');

function configure(value) {
    initialized = true;
    metadata = value && /^[a-f0-9]{40}$/.test(value.code) && /^[a-f0-9]{64}$/.test(value.config)
        ? Object.freeze({ code: value.code, config: value.config }) : null;
    lastProfile = null; identity = null;
}

function published() {
    if (!initialized && isMainThread) {
        initialized = true;
        try {
            // lazy: worker never reads a filesystem or a Git checkout. Deploy
            // publishes a clean detached checkout; branch/test trees abstain.
            const fs = require('node:fs'), path = require('node:path');
            const root = path.resolve(__dirname, '../../../..');
            const git = path.join(root, '.git');
            const pointer = fs.statSync(git).isDirectory() ? git
                : path.resolve(root, fs.readFileSync(git, 'utf8').trim().replace(/^gitdir:\s*/, ''));
            const code = fs.readFileSync(path.join(pointer, 'HEAD'), 'utf8').trim();
            const config = globalThis.options?.default;
            configure(config && typeof config === 'object' ? { code, config: digest(JSON.stringify(config)) } : null);
        } catch (_) { configure(null); }
    }
    return metadata;
}

function current() {
    const value = published();
    if (!value) return null;
    const profile = Rates.profile();
    if (profile !== lastProfile) {
        identity = digest(JSON.stringify([value.code, value.config, profile]));
        lastProfile = profile;
    }
    return identity;
}

module.exports = { configure, metadata: published, current };
