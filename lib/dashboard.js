'use strict';

// Read-only Help Scout dashboard: data fetching, caching and HTTP handling.
// Shared by the local server (server.js) and the Vercel functions (api/).
// Only ever sends GET requests to the Help Scout Inbox API (plus the OAuth token request).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnv(path.join(__dirname, '..', '.env'));

const env = process.env;
const APP_ID = env.HELPSCOUT_APP_ID;
const APP_SECRET = env.HELPSCOUT_APP_SECRET;
const DEMO = process.argv.includes('--demo') || env.DEMO === '1';
const PASSWORD = env.DASHBOARD_PASSWORD || '';
// Individual logins: "name:password,name2:password2" (passwords cannot contain commas).
const USERS = new Map(
  (env.DASHBOARD_USERS || '').split(',').map((entry) => {
    const i = entry.indexOf(':');
    return i > 0 ? [entry.slice(0, i).trim(), entry.slice(i + 1).trim()] : null;
  }).filter((u) => u && u[0] && u[1])
);
const ON_VERCEL = Boolean(env.VERCEL);
const TIMEZONE = env.DASHBOARD_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
// Data for the current month is refreshed after CACHE_MINUTES; finished months are kept for PAST_CACHE_HOURS.
const CACHE_MINUTES = Number(env.CACHE_MINUTES) || 10;
const PAST_CACHE_HOURS = Number(env.PAST_CACHE_HOURS) || 6;
// Breakdowns page through each month's tickets (25 per page); this caps the pages read per month.
const MAX_PAGES = Number(env.MAX_PAGES) || 400;
// Stay well under Help Scout's per-account limit (400/min), which other integrations share.
const MAX_CALLS_PER_MINUTE = Number(env.MAX_CALLS_PER_MINUTE) || 200;
// 'domain' groups companies by customer email domain (no extra calls);
// 'customer' reads the Company field from each customer's profile (one call per customer).
const COMPANY_SOURCE = env.COMPANY_SOURCE === 'customer' ? 'customer' : 'domain';
// Optional shared cache (Upstash Redis, e.g. via the Vercel Marketplace). Without it, cache is per process.
const REDIS_URL = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
const REDIS_TOKEN = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
const MAX_CONCURRENT = 4;
const API = 'https://api.helpscout.net/v2';
const CACHE_PREFIX = 'hsdash:v2:';

const RANGES = {
  '7d': { unit: 'day', days: 7, label: () => 'Last 7 days' },
  '30d': { unit: 'day', days: 30, label: () => 'Last 30 days' },
  lastmonth: { unit: 'day', previousMonth: true, label: (t) => monthName(t.y, t.m - 1) },
  '6m': { unit: 'month', months: 6, label: () => 'Last 6 months' },
  '12m': { unit: 'month', months: 12, label: () => 'Last 12 months' },
};
const DEFAULT_RANGE = '7d';

const CHANNEL_LABELS = { email: 'Email', chat: 'Chat', phone: 'Phone' };

// Help Scout calls open tickets "active"; spam and anything else is grouped as "other".
const statusKey = (status) => (status === 'active' ? 'open' : status === 'pending' || status === 'closed' ? status : 'other');

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'ymail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
  'protonmail.com', 'gmx.com', 'gmx.de', 'mail.com', 'rediffmail.com', 'yandex.com', 'qq.com', '163.com',
]);

function companyFromEmail(email) {
  const domain = String(email || '').split('@')[1]?.trim().toLowerCase();
  if (!domain) return 'No email';
  return PERSONAL_EMAIL_DOMAINS.has(domain) ? 'Personal email' : domain;
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Cache (memory, plus Upstash Redis when configured) ----------

const memory = new Map(); // key -> { value, expiresAt }
const inflight = new Map(); // key -> promise, so concurrent requests share one computation

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis returned ${res.status}`);
  return (await res.json()).result;
}

async function cacheGet(key) {
  const hit = memory.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (!REDIS_URL) return undefined;
  try {
    const raw = await redis(['GET', key]);
    return raw == null ? undefined : JSON.parse(raw);
  } catch (err) {
    console.warn(`Cache read failed: ${err.message}`);
    return undefined;
  }
}

async function cacheSet(key, value, ttlSeconds) {
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  if (memory.size > 500) {
    for (const [k, v] of memory) if (v.expiresAt <= Date.now()) memory.delete(k);
  }
  if (REDIS_URL) {
    await redis(['SET', key, JSON.stringify(value), 'EX', String(Math.ceil(ttlSeconds))]).catch((err) =>
      console.warn(`Cache write failed: ${err.message}`)
    );
  }
}

function cached(key, ttlSeconds, compute, refresh = false) {
  const fullKey = CACHE_PREFIX + key;
  if (inflight.has(fullKey)) return inflight.get(fullKey);
  const promise = (async () => {
    if (!refresh) {
      const hit = await cacheGet(fullKey);
      if (hit !== undefined) return hit;
    }
    const value = await compute();
    await cacheSet(fullKey, value, ttlSeconds);
    return value;
  })().finally(() => inflight.delete(fullKey));
  inflight.set(fullKey, promise);
  return promise;
}

// ---------- Help Scout API client ----------

let token = null; // { value, expiresAt }

async function getToken() {
  if (token && Date.now() < token.expiresAt) return token.value;
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: APP_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Help Scout login failed (${res.status}). Check HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET.`);
  }
  const body = await res.json();
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 300) * 1000 };
  return token.value;
}

// Concurrency limiter so a refresh never bursts.
let active = 0;
const queue = [];
function limit(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}
function drain() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn().then(resolve, reject).finally(() => {
      active--;
      drain();
    });
  }
}

// Sliding one-minute window that keeps this process under MAX_CALLS_PER_MINUTE.
const callTimes = [];
async function takeCallSlot() {
  for (;;) {
    const now = Date.now();
    while (callTimes.length && now - callTimes[0] >= 60e3) callTimes.shift();
    if (callTimes.length < MAX_CALLS_PER_MINUTE) {
      callTimes.push(now);
      return;
    }
    await sleep(60e3 - (now - callTimes[0]) + 50);
  }
}

async function hsGet(pathname, params = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return limit(async () => {
    for (let attempt = 0; ; attempt++) {
      await takeCallSlot();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
      if (res.status === 429 && attempt < 5) {
        const wait = Number(res.headers.get('x-ratelimit-retry-after') || res.headers.get('retry-after')) || 10;
        console.warn(`Rate limited by Help Scout, waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      if (!res.ok) {
        throw new Error(`Help Scout API returned ${res.status} for ${pathname}: ${(await res.text()).slice(0, 200)}`);
      }
      return res.json();
    }
  });
}

async function fetchAll(pathname, key) {
  const first = await hsGet(pathname);
  const pages = first.page?.totalPages ?? 1;
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => hsGet(pathname, { page: i + 2 }))
  );
  return [first, ...rest].flatMap((b) => b._embedded?.[key] ?? []);
}

// One request per count: the search response carries the total in page.totalElements.
async function countConversations(params) {
  const body = await hsGet('/conversations', { status: 'all', ...params });
  return body.page?.totalElements ?? 0;
}

async function listConversations(query) {
  const params = { status: 'all', query, sortField: 'createdAt', sortOrder: 'desc' };
  const first = await hsGet('/conversations', params);
  const totalPages = first.page?.totalPages ?? 1;
  const pages = Math.min(totalPages, MAX_PAGES);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => hsGet('/conversations', { ...params, page: i + 2 }))
  );
  return {
    convs: [first, ...rest].flatMap((b) => b._embedded?.conversations ?? []),
    truncated: totalPages > MAX_PAGES,
  };
}

async function customerOrganization(id) {
  return cached(`customer-org:${id}`, 24 * 3600, async () => {
    const customer = await hsGet(`/customers/${id}`);
    return String(customer.organization || '').trim();
  });
}

// ---------- Calendar math in TIMEZONE (servers such as Vercel run in UTC) ----------

const wallClockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function wallClock(ts) {
  const p = {};
  for (const part of wallClockFormat.formatToParts(new Date(ts))) p[part.type] = Number(part.value);
  return p;
}

function offsetAt(ts) {
  const p = wallClock(ts);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ts - (ts % 1000));
}

// The instant the calendar day y-m-d starts in TIMEZONE. Month is 1-based; out-of-range values roll over.
function dayStart(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t);
}

function today() {
  const p = wallClock(Date.now());
  return { y: p.year, m: p.month, d: p.day };
}

function monthName(y, m) {
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function rangeBuckets(rangeKey) {
  const r = RANGES[rangeKey];
  const t = today();
  const buckets = [];
  if (r.days) {
    for (let i = r.days - 1; i >= 0; i--) {
      buckets.push({ start: dayStart(t.y, t.m, t.d - i), end: dayStart(t.y, t.m, t.d - i + 1) });
    }
  } else if (r.months) {
    for (let i = r.months - 1; i >= 0; i--) {
      buckets.push({ start: dayStart(t.y, t.m - i, 1), end: dayStart(t.y, t.m - i + 1, 1) });
    }
  } else {
    const daysInPreviousMonth = new Date(Date.UTC(t.y, t.m - 1, 0)).getUTCDate();
    for (let d = 1; d <= daysInPreviousMonth; d++) {
      buckets.push({ start: dayStart(t.y, t.m - 1, d), end: dayStart(t.y, t.m - 1, d + 1) });
    }
  }
  return buckets;
}

// Splits [start, end) at month boundaries so each month can be fetched and cached on its own.
function monthSegments(start, end) {
  const p = wallClock(start.getTime());
  const segments = [];
  for (let i = 0; ; i++) {
    const s = dayStart(p.year, p.month + i, 1);
    if (s >= end) break;
    const e = dayStart(p.year, p.month + i + 1, 1);
    segments.push({ start: s < start ? start : s, end: e > end ? end : e });
  }
  return segments;
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const createdQuery = (start, end) => `(createdAt:[${iso(start)} TO ${iso(new Date(end - 1000))}])`;

function isPast(end) {
  const t = today();
  return end <= dayStart(t.y, t.m, t.d);
}

// Finished periods change rarely, so they are cached much longer than the current one.
const ttlFor = (end) => (isPast(end) ? PAST_CACHE_HOURS * 3600 : CACHE_MINUTES * 60);

// ---------- Summary ----------

function bump(obj, key, n = 1) {
  obj[key] = (obj[key] || 0) + n;
}

function personName(p) {
  return [p?.first, p?.last].filter(Boolean).join(' ') || p?.email || '';
}

function countCreated(bucket, refresh) {
  return cached(
    `count:${iso(bucket.start)}:${iso(bucket.end)}`,
    ttlFor(bucket.end),
    () => countConversations({ query: createdQuery(bucket.start, bucket.end) }),
    refresh && !isPast(bucket.end)
  );
}

// Counts for one month (or part of one): only small tallies are cached, never ticket content.
function segmentStats(seg, refresh) {
  return cached(
    `segment:${COMPANY_SOURCE}:${iso(seg.start)}:${iso(seg.end)}`,
    ttlFor(seg.end),
    async () => {
      const { convs, truncated } = await listConversations(createdQuery(seg.start, seg.end));
      const orgByCustomer = new Map();
      if (COMPANY_SOURCE === 'customer') {
        const ids = [...new Set(convs.map((c) => c.primaryCustomer?.id).filter(Boolean))];
        await Promise.all(
          ids.map(async (id) => orgByCustomer.set(id, await customerOrganization(id).catch(() => '')))
        );
      }
      const s = { tickets: convs.length, truncated, mailbox: {}, channel: {}, tag: {}, company: {}, companyStatus: {}, assigned: {}, closed: {}, people: {} };
      for (const c of convs) {
        bump(s.mailbox, c.mailboxId);
        bump(s.channel, CHANNEL_LABELS[c.type] || c.type || 'Other');
        for (const t of c.tags || []) bump(s.tag, t.tag);
        const company = orgByCustomer.get(c.primaryCustomer?.id) || companyFromEmail(c.primaryCustomer?.email);
        bump(s.company, company);
        bump((s.companyStatus[company] ||= {}), statusKey(c.status));
        if (c.assignee?.id) {
          bump(s.assigned, c.assignee.id);
          s.people[c.assignee.id] ||= personName(c.assignee);
        } else {
          bump(s.assigned, 'unassigned');
        }
        if (c.status === 'closed' && c.closedBy) {
          bump(s.closed, c.closedBy);
          s.people[c.closedBy] ||= personName(c.closedByUser);
        }
      }
      return s;
    },
    refresh && !isPast(seg.end)
  );
}

function mergeCounts(list, field) {
  const out = {};
  for (const s of list) for (const [k, n] of Object.entries(s[field])) bump(out, k, n);
  return out;
}

function mergeCompanyStatus(segments) {
  const out = {};
  for (const seg of segments) {
    for (const [company, counts] of Object.entries(seg.companyStatus)) {
      for (const [k, n] of Object.entries(counts)) bump((out[company] ||= {}), k, n);
    }
  }
  return out;
}

const withStatus = (companies, statusByCompany) =>
  companies.map((c) => ({ ...c, status: { open: 0, pending: 0, closed: 0, other: 0, ...statusByCompany[c.name] } }));

const toList = (obj, nameOf = (k) => k) =>
  Object.entries(obj)
    .map(([k, count]) => ({ name: nameOf(k), count }))
    .sort((a, b) => b.count - a.count);

async function buildSummary(rangeKey, refresh) {
  const r = RANGES[rangeKey];
  const buckets = rangeBuckets(rangeKey);
  const start = buckets[0].start;
  const end = buckets[buckets.length - 1].end;
  const periodQuery = createdQuery(start, end);

  const [counts, open, pending, closedInPeriod, segments, mailboxes, users] = await Promise.all([
    Promise.all(buckets.map((b) => countCreated(b, refresh))),
    countConversations({ status: 'active' }),
    countConversations({ status: 'pending' }),
    countConversations({ status: 'closed', query: periodQuery }),
    Promise.all(monthSegments(start, end).map((s) => segmentStats(s, refresh))),
    cached('mailboxes', 3600, () => fetchAll('/mailboxes', 'mailboxes'), refresh),
    cached('users', 3600, () => fetchAll('/users', 'users'), refresh),
  ]);

  const mailboxName = new Map(mailboxes.map((m) => [String(m.id), m.name]));
  const userName = new Map(
    users.map((u) => [String(u.id), [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email])
  );
  const people = Object.assign({}, ...segments.map((s) => s.people));
  const agentName = (key) => userName.get(key) || people[key] || `User ${key}`;

  const assigned = mergeCounts(segments, 'assigned');
  const closed = mergeCounts(segments, 'closed');
  const agents = [...new Set([...Object.keys(assigned), ...Object.keys(closed)])]
    .map((key) => ({
      name: key === 'unassigned' ? 'Unassigned' : agentName(key),
      assigned: assigned[key] || 0,
      closed: closed[key] || 0,
      unassigned: key === 'unassigned',
    }))
    .sort((a, b) => b.assigned - a.assigned);

  return {
    demo: false,
    range: rangeKey,
    rangeLabel: r.label(today()),
    unit: r.unit,
    timeZone: TIMEZONE,
    fetchedAt: new Date().toISOString(),
    created: {
      total: counts.reduce((a, b) => a + b, 0),
      buckets: buckets.map((b, i) => ({ start: iso(b.start), count: counts[i] })),
    },
    status: { open, pending, closedInPeriod },
    breakdowns: {
      mailbox: toList(mergeCounts(segments, 'mailbox'), (id) => mailboxName.get(id) || `Mailbox ${id}`),
      channel: toList(mergeCounts(segments, 'channel')),
      tag: toList(mergeCounts(segments, 'tag')),
      company: withStatus(toList(mergeCounts(segments, 'company')), mergeCompanyStatus(segments)),
      agent: agents,
    },
    companySource: COMPANY_SOURCE,
    analyzed: {
      tickets: segments.reduce((a, s) => a + s.tickets, 0),
      truncated: segments.some((s) => s.truncated),
    },
  };
}

// Fake but plausible numbers so the dashboard can be previewed without credentials.
function demoSummary(rangeKey) {
  const r = RANGES[rangeKey];
  const buckets = rangeBuckets(rangeKey);
  const now = Date.now();
  let seed = 42;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const counts = buckets.map((b) => {
    const days = (b.end - b.start) / 864e5;
    const elapsed = Math.min(1, Math.max(0, (now - b.start) / (b.end - b.start)));
    const weekend = r.unit === 'day' && [0, 6].includes(new Date(b.start.getTime() + 12 * 3600e3).getUTCDay());
    return Math.round(52 * days * elapsed * (weekend ? 0.45 : 1) * (0.75 + rand() * 0.5));
  });
  const total = counts.reduce((a, b) => a + b, 0);
  const split = (names, weights) => {
    const sum = weights.reduce((a, b) => a + b, 0);
    return names
      .map((name, i) => ({ name, count: Math.round((total * weights[i]) / sum) }))
      .sort((a, b) => b.count - a.count);
  };
  const assigned = split(['Alex', 'Sam', 'Jordan', 'Riya', 'Chen', 'Unassigned'], [24, 21, 18, 16, 15, 6]);
  const companies = [
    'northwind.io', 'globex.com', 'Personal email', 'initech.com', 'umbrella.co', 'hooli.com', 'piedpiper.com',
    'wayne-ent.com', 'soylent.io', 'vandelay.com', 'contoso.com', 'fabrikam.net', 'tailspin.io', 'litware.com',
    'adatum.com', 'wingtip.co', 'proseware.com', 'lucerne.org', 'margie.travel', 'fourthcoffee.com',
  ];

  return {
    demo: true,
    range: rangeKey,
    rangeLabel: r.label(today()),
    unit: r.unit,
    timeZone: TIMEZONE,
    fetchedAt: new Date().toISOString(),
    created: { total, buckets: buckets.map((b, i) => ({ start: iso(b.start), count: counts[i] })) },
    status: { open: 64, pending: 23, closedInPeriod: Math.round(total * 0.78) },
    breakdowns: {
      mailbox: split(['Support', 'Billing', 'Sales'], [62, 27, 11]),
      channel: split(['Email', 'Chat', 'Phone'], [71, 24, 5]),
      tag: split(
        ['how-to', 'bug', 'billing', 'login', 'feature-request', 'refund', 'integration'],
        [30, 22, 18, 12, 9, 6, 4]
      ),
      company: split(companies, companies.map((_, i) => Math.round(200 / (i + 2)))).map((c) => {
        const open = Math.round(c.count * (0.04 + rand() * 0.12));
        const pending = Math.round(c.count * rand() * 0.06);
        return { ...c, status: { open, pending, closed: c.count - open - pending, other: 0 } };
      }),
      agent: assigned.map((a) => ({
        name: a.name,
        assigned: a.count,
        closed: a.name === 'Unassigned' ? 0 : Math.round(a.count * 0.82),
        unassigned: a.name === 'Unassigned',
      })),
    },
    companySource: COMPANY_SOURCE,
    analyzed: { tickets: total, truncated: false },
  };
}

function getSummary(rangeKey, refresh) {
  if (DEMO) return Promise.resolve(demoSummary(rangeKey));
  return cached(`summary:${COMPANY_SOURCE}:${rangeKey}`, CACHE_MINUTES * 60, () => buildSummary(rangeKey, refresh), refresh);
}

// ---------- HTTP ----------

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

const sendJson = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

// Basic auth: each DASHBOARD_USERS entry logs in with its own name and password, and
// DASHBOARD_PASSWORD (if set) works with any username. One of them is required on Vercel, optional locally.
function authorized(req, res) {
  if (!PASSWORD && !USERS.size) {
    if (!ON_VERCEL) return true;
    send(res, 500, 'text/plain; charset=utf-8', 'Set DASHBOARD_USERS or DASHBOARD_PASSWORD in Vercel to protect this dashboard, then redeploy.');
    return false;
  }
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  const decoded = m ? Buffer.from(m[1], 'base64').toString() : '';
  const i = decoded.indexOf(':');
  const user = i >= 0 ? decoded.slice(0, i) : '';
  const supplied = i >= 0 ? decoded.slice(i + 1) : '';
  const userPassword = USERS.get(user);
  if (userPassword !== undefined && sameSecret(supplied, userPassword)) return true;
  if (PASSWORD && sameSecret(supplied, PASSWORD)) return true;
  send(res, 401, 'text/plain; charset=utf-8', 'Password required', {
    'WWW-Authenticate': 'Basic realm="Support dashboard", charset="UTF-8"',
  });
  return false;
}

async function handleSummary(req, res) {
  if (!authorized(req, res)) return;
  const url = new URL(req.url, 'http://localhost');
  const requested = url.searchParams.get('range');
  const rangeKey = RANGES[requested] ? requested : DEFAULT_RANGE;
  if (!DEMO && (!APP_ID || !APP_SECRET)) {
    return sendJson(res, 500, {
      error: 'Missing HELPSCOUT_APP_ID / HELPSCOUT_APP_SECRET. Set them in .env (local) or in the Vercel project settings.',
    });
  }
  try {
    sendJson(res, 200, await getSummary(rangeKey, url.searchParams.has('refresh')));
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { error: err.message });
  }
}

function handlePage(req, res) {
  if (!authorized(req, res)) return;
  send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html')));
}

// Router for the local server; on Vercel each handler is its own function (see api/).
function handle(req, res) {
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/summary') return handleSummary(req, res);
  if (pathname === '/') return handlePage(req, res);
  send(res, 404, 'text/plain', 'Not found');
}

module.exports = { handle, handleSummary, handlePage, DEMO, TIMEZONE };
