#!/usr/bin/env node
/**
 * Scheduled watcher: compares the three public repos + latest release with the
 * saved state and sends one FCM message per new item to the "murshid-updates"
 * topic. Runs from GitHub Actions every ~5 minutes.
 */
const fs = require('fs');
const crypto = require('crypto');

const STATE_FILE = 'notify-state.json';
const TOPIC = 'murshid-updates';
const OWNER = 'jalalamanj1';
const REPOS = [
  { key: 'letters', name: 'murshidletters', label: 'مخاطبة جديدة في مخاطبات التربية' },
  { key: 'files', name: 'murshidfiles', label: 'ملف جديد في الملفات والدلائل' },
  { key: 'covers', name: 'murshidcovers', label: 'غلاف جديد في أغلفة السجلات' },
];
const SUPPORTED = ['pdf', 'png', 'jpg', 'jpeg', 'doc', 'docx', 'xls', 'xlsx'];

const token = process.env.GITHUB_TOKEN || '';
const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
if (!serviceAccountRaw) {
  console.error('FIREBASE_SERVICE_ACCOUNT secret is missing.');
  process.exit(1);
}
const serviceAccount = JSON.parse(serviceAccountRaw);

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(serviceAccount.private_key);
  const jwt = `${signingInput}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function sendPush(accessToken, title, body) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          topic: TOPIC,
          notification: { title, body },
          android: {
            priority: 'high',
            notification: { channel_id: 'murshid_updates', sound: 'default' },
          },
          data: { screen: 'notifications' },
        },
      }),
    }
  );
  if (!res.ok) {
    console.error(`FCM ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

async function listRepoFiles(repo) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/contents/`, {
    headers,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`GitHub ${repo}: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (item) =>
        item.type === 'file' &&
        item.name !== 'library.json' &&
        !item.name.startsWith('.') &&
        SUPPORTED.includes((item.name.split('.').pop() || '').toLowerCase())
    )
    .map((item) => item.name);
}

async function latestVersion() {
  const res = await fetch(
    `https://raw.githubusercontent.com/${OWNER}/murshidmobile-releases/main/latest.json?t=${Date.now()}`,
    { cache: 'no-store' }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.version === 'string' ? data.version : null;
}

(async () => {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = {};
  }

  const firstRun = !state.initialized;
  const next = { ...state, repos: { ...(state.repos || {}) }, initialized: true };

  const pending = [];
  for (const repo of REPOS) {
    let names = [];
    try {
      names = await listRepoFiles(repo.name);
    } catch (err) {
      console.error(err.message);
      continue;
    }

    const known = new Set(next.repos[repo.key] || []);
    if (!firstRun) {
      for (const name of names) {
        if (!known.has(name)) pending.push({ title: repo.label, body: name });
      }
    }
    next.repos[repo.key] = names;
  }

  try {
    const version = await latestVersion();
    if (version) {
      if (!firstRun && state.updateVersion && version !== state.updateVersion) {
        pending.push({ title: `إصدار جديد من مرشد: ${version}`, body: 'افتح التطبيق لتثبيت التحديث.' });
      }
      next.updateVersion = version;
    }
  } catch (err) {
    console.error(err.message);
  }

  if (pending.length > 0) {
    // One message per new item, but never flood the phone: a big batch becomes
    // a single summary notification.
    const items = pending.slice(0, 5);
    if (pending.length > 5) {
      items.push({
        title: 'جديد في مرشد',
        body: `${pending.length} عنصر جديد — افتح التطبيق للمزيد.`,
      });
    }

    const accessToken = await getAccessToken();
    let sent = 0;
    let failed = 0;
    for (const item of items) {
      if (await sendPush(accessToken, item.title, item.body)) sent += 1;
      else failed += 1;
    }
    console.log(`Sent ${sent} notification(s), ${failed} failed, ${pending.length} change(s).`);
    if (sent === 0 && failed > 0) {
      // Nothing reached the phone: fail the job so it is visible in Actions.
      process.exitCode = 1;
    }
  } else {
    console.log('No changes.');
  }

  fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
