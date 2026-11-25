#!/usr/bin/env node
/**
 * Daily health check for the free services Murshid depends on.
 *
 * 1. Calls the activation RPC so the free Supabase project never pauses.
 * 2. Confirms the three library manifests are reachable.
 * 3. Verifies the published APK still matches latest.json (sha256 + size).
 *
 * Any failure exits non-zero, so GitHub emails the owner instead of the app
 * silently breaking weeks later.
 */
const crypto = require('crypto');

const OWNER = 'jalalamanj1';
const ACTIVATION_URL =
  'https://tpkhfoimtcxjfksxlvmo.supabase.co/rest/v1/rpc/get_activation_status';
const ACTIVATION_KEY = 'sb_publishable_2Y4swUzZu3tKn2o-KuIkMw_nRFud0Jb';
const APPLICATION_KEY = '412ed76c-741a-49d8-afcc-e7eed62e8fcd';

const failures = [];
const notes = [];

async function pingActivation() {
  try {
    const res = await fetch(ACTIVATION_URL, {
      method: 'POST',
      headers: {
        apikey: ACTIVATION_KEY,
        Authorization: `Bearer ${ACTIVATION_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_application_key: APPLICATION_KEY,
        p_device_id: '00000000-0000-0000-0000-000000000000',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    notes.push('activation: awake');
  } catch (err) {
    failures.push(`activation service unreachable (${err.message})`);
  }
}

async function checkManifests() {
  for (const repo of ['murshidletters', 'murshidfiles', 'murshidcovers']) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${OWNER}/${repo}/main/library.json?x=${Date.now()}`,
        { cache: 'no-store' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const count = Object.keys(json.files || {}).length;
      notes.push(`${repo}: ${count} files`);
    } catch (err) {
      failures.push(`${repo} manifest broken (${err.message})`);
    }
  }
}

async function checkRelease() {
  try {
    const manifestRes = await fetch(
      `https://raw.githubusercontent.com/${OWNER}/murshidmobile-releases/main/latest.json?x=${Date.now()}`,
      { cache: 'no-store' }
    );
    if (!manifestRes.ok) throw new Error(`latest.json HTTP ${manifestRes.status}`);
    const manifest = await manifestRes.json();

    const apkUrl = String(manifest.apkUrl || '').split('?')[0];
    if (!apkUrl) throw new Error('latest.json has no apkUrl');

    const apkRes = await fetch(`${apkUrl}?x=${Date.now()}`, { cache: 'no-store' });
    if (!apkRes.ok) throw new Error(`APK HTTP ${apkRes.status}`);
    const bytes = Buffer.from(await apkRes.arrayBuffer());

    if (manifest.size && bytes.length !== Number(manifest.size)) {
      throw new Error(`size ${bytes.length} != ${manifest.size}`);
    }
    if (manifest.sha256) {
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== String(manifest.sha256).toLowerCase()) {
        throw new Error('APK sha256 does not match latest.json');
      }
    }
    notes.push(`release: ${manifest.version} verified (${bytes.length} bytes)`);
  } catch (err) {
    failures.push(`release check failed (${err.message})`);
  }
}

(async () => {
  await Promise.all([pingActivation(), checkManifests(), checkRelease()]);
  for (const note of notes) console.log(`OK   ${note}`);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('All checks passed.');
  }
})();
