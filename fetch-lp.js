// fetch-lp.js — pools.trade tRPC + recent Blockscout launches (free)
import fs from "fs/promises";

const OUTPUT_PATH = "data.json";
const HISTORY_PATH = "data/history.json";
const LAUNCHES_PATH = "data/launches.json";
const TOP_N = 1000;

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * MS_24H;
const MS_30D = 30 * MS_24H;

// Always try to include these (your token + any others you care about)
const FORCE_INCLUDE = [
  "0xe72936b1fe4cc0a521ae82bb9239f28f3fdb1c5d", // THICC
];

// Official pools.trade launchpad contracts only
const LAUNCHPADS = [
  "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
  "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
  "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2",
  "0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491",
];
const TOPIC_TOKEN_LAUNCHED =
  "0x3b3d2bafdcae274a232217e1f80ee4305d3af6aa25c8b14b1681bd68d18042a4";

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api";
// ~30 min of L2 blocks (~0.1s/block) — keep range small for free API
const RECENT_BLOCK_WINDOW = 20_000;

async function trpc(procedure, input) {
  const q = encodeURIComponent(JSON.stringify({ "0": input }));
  const url = `https://pools.trade/api/trpc/${procedure}?batch=1&input=${q}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "thicc-screener/1.0" },
  });
  if (!res.ok) throw new Error(`tRPC ${procedure} HTTP ${res.status}`);
  const json = await res.json();
  const item = Array.isArray(json) ? json[0] : json;
  if (item?.error) throw new Error(`tRPC ${procedure}: ${JSON.stringify(item.error)}`);
  return item?.result?.data ?? item?.result?.data?.json ?? null;
}

function mapLaunch(l, source) {
  if (!l) return null;
  const stats = l.poolStats || {};
  const lp = Number(stats.liquidityUsd ?? l.liquidityUsd ?? 0);
  const price = Number(stats.priceUsd ?? l.clearingPriceUsd ?? l.priceUsd ?? 0);
  const vol = Number(stats.volume24hUsd ?? l.volume24hUsd ?? 0);
  const fdv = Number(l.fdvUsd ?? (price > 0 ? price * 1e9 : 0));
  const token = (l.tokenAddress || l.token || "").toLowerCase();
  if (!token) return null;
  return {
    token,
    symbol: l.tokenSymbol || "???",
    name: l.tokenName || "",
    pool_id: l.poolId || l.poolKeyHash || null,
    source,
    status: l.status || "",
    lp_value: +lp.toFixed(2),
    fdv: +fdv.toFixed(2),
    volume_24h: +vol.toFixed(2),
    price,
    holders: l.holderCount ?? null,
    created_at: l.createdAt || l.graduatedAt || l.startsAt || null,
  };
}

async function getLatestBlock() {
  const res = await fetch("https://robinhoodchain.blockscout.com/api/v2/blocks?type=block");
  const json = await res.json();
  const h = json?.items?.[0]?.height;
  if (!h) throw new Error("Could not get latest block");
  return Number(h);
}

function decodeTokenLaunched(log) {
  // topics[0] = event sig
  // topics[1] = poolId (bytes32) when indexed
  // topics[2] = token (address) when indexed
  const topics = log.topics || [];
  let token = null;
  let poolId = null;
  if (topics[1]) poolId = topics[1].toLowerCase();
  if (topics[2] && topics[2].length === 66) {
    token = ("0x" + topics[2].slice(26)).toLowerCase();
  }
  // fallback: parse data if needed
  if (!token && log.data && log.data.length >= 130) {
    // non-indexed layout varies; skip if we can't decode cleanly
  }
  if (!token || !token.startsWith("0x") || token.length !== 42) return null;
  return {
    token,
    poolId,
    blockNumber: parseInt(log.blockNumber, 16) || Number(log.blockNumber) || 0,
    txHash: log.transactionHash || null,
  };
}

async function fetchRecentLaunches(fromBlock, toBlock) {
  const found = [];
  for (const addr of LAUNCHPADS) {
    const url =
      `${BLOCKSCOUT}?module=logs&action=getLogs` +
      `&fromBlock=${fromBlock}&toBlock=${toBlock}` +
      `&address=${addr}&topic0=${TOPIC_TOKEN_LAUNCHED}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "thicc-screener/1.0" },
      });
      const json = await res.json();
      const logs = Array.isArray(json.result) ? json.result : [];
      for (const log of logs) {
        const d = decodeTokenLaunched(log);
        if (d) found.push({ ...d, launchpad: addr });
      }
      // be nice to free tier
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      console.log("  blockscout skip", addr.slice(0, 10), e.message);
    }
  }
  return found;
}

async function loadLaunchesState() {
  try {
    const raw = await fs.readFile(LAUNCHES_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastScannedBlock: 0, tokens: {} };
  }
}

async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function closestLp(byToken, token, targetTs) {
  const rows = byToken.get(token);
  if (!rows?.length) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.ts - targetTs);
    if (d < bestDiff) {
      bestDiff = d;
      best = r.lp_value;
    }
  }
  if (best == null || bestDiff > 12 * 3600e3) return null;
  return best;
}

function dollarChange(now, then) {
  if (then == null || now == null) return null;
  return +(now - then).toFixed(2);
}
function pctChange(now, then) {
  if (then == null || then === 0 || now == null) return null;
  return +(((now - then) / then) * 100).toFixed(2);
}

async function main() {
  // ── 1. tRPC bulk lists ──────────────────────────────────────────
  console.log("Fetching curve.listLaunches (volume)...");
  let byVolume = [];
  try {
    byVolume = (await trpc("curve.listLaunches", { sortBy: "volume" })) || [];
    if (!Array.isArray(byVolume)) byVolume = [];
    console.log("  got", byVolume.length);
  } catch (e) {
    console.log("  volume fail:", e.message);
  }

  console.log("Fetching curve.listLaunches (trending)...");
  let byTrending = [];
  try {
    byTrending = (await trpc("curve.listLaunches", { sortBy: "trending" })) || [];
    if (!Array.isArray(byTrending)) byTrending = [];
    console.log("  got", byTrending.length);
  } catch (e) {
    console.log("  trending skip:", e.message);
  }

  console.log("Fetching curve.listLaunches (recency)...");
  let byRecency = [];
  try {
    byRecency = (await trpc("curve.listLaunches", { sortBy: "recency" })) || [];
    if (!Array.isArray(byRecency)) byRecency = [];
    console.log("  got", byRecency.length);
  } catch (e) {
    console.log("  recency skip:", e.message);
  }

  console.log("Fetching cca.listAuctions...");
  let auctions = [];
  try {
    auctions = (await trpc("cca.listAuctions", {})) || [];
    if (!Array.isArray(auctions)) auctions = [];
    console.log("  got", auctions.length);
  } catch (e) {
    console.log("  cca skip:", e.message);
  }

  const map = new Map();
  for (const list of [byVolume, byTrending, byRecency]) {
    for (const l of list) {
      const m = mapLaunch(l, "curve");
      if (m && (!map.has(m.token) || m.lp_value > (map.get(m.token).lp_value || 0))) {
        map.set(m.token, m);
      }
    }
  }
  for (const a of auctions) {
    if (a.status !== "graduated" && !a.poolKeyHash && !a.poolStats) continue;
    const m = mapLaunch(a, "cca");
    if (m && (!map.has(m.token) || m.lp_value > (map.get(m.token).lp_value || 0))) {
      map.set(m.token, m);
    }
  }

  // ── 2. Incremental Blockscout (recent window only) ─────────────
  const state = await loadLaunchesState();
  let latest = 0;
  try {
    latest = await getLatestBlock();
    console.log("Latest block:", latest);
  } catch (e) {
    console.log("Block height skip:", e.message);
  }

  if (latest > 0) {
    const fromBlock =
      state.lastScannedBlock > 0
        ? state.lastScannedBlock + 1
        : Math.max(1, latest - RECENT_BLOCK_WINDOW);
    const toBlock = latest;
    if (fromBlock <= toBlock) {
      console.log(`Scanning TokenLaunched blocks ${fromBlock} → ${toBlock}...`);
      const recent = await fetchRecentLaunches(fromBlock, toBlock);
      console.log("  new log events:", recent.length);
      for (const r of recent) {
        if (!state.tokens[r.token]) {
          state.tokens[r.token] = {
            token: r.token,
            poolId: r.poolId,
            blockNumber: r.blockNumber,
            launchpad: r.launchpad,
          };
        }
      }
      state.lastScannedBlock = toBlock;
      await fs.mkdir("data", { recursive: true });
      await fs.writeFile(LAUNCHES_PATH, JSON.stringify(state, null, 2));
    }
  }

  // ── 3. Enrich missing / force-include via getLaunchByAddress ────
  const toEnrich = new Set([
    ...FORCE_INCLUDE.map((t) => t.toLowerCase()),
    ...Object.keys(state.tokens),
  ]);

  // Only fetch ones we don't already have with LP
  const needFetch = [...toEnrich].filter((t) => {
    const existing = map.get(t);
    return !existing || existing.lp_value <= 0;
  });

  console.log("Enriching via getLaunchByAddress:", needFetch.length);
  for (const token of needFetch.slice(0, 80)) {
    // cap per run to stay free/fast
    try {
      const data = await trpc("curve.getLaunchByAddress", { tokenAddress: token });
      const m = mapLaunch(data, "curve");
      if (m && m.lp_value > 0) {
        map.set(m.token, m);
        console.log("  +", m.symbol, "LP $", m.lp_value);
      }
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      // token may be CCA-only or not found
    }
  }

  // ── 4. Rank ────────────────────────────────────────────────────
  const ranked = [...map.values()]
    .filter((t) => t.lp_value > 0 || t.fdv > 0)
    .sort((a, b) => b.lp_value - a.lp_value)
    .slice(0, TOP_N);

  console.log("Ranked", ranked.length, "tokens");
  if (ranked[0]) console.log("Top:", ranked[0].symbol, "LP $", ranked[0].lp_value);

  // ── 5. History / LP change ─────────────────────────────────────
  const now = Date.now();
  let history = await loadHistory();
  for (const t of ranked) {
    history.push({ token: t.token, ts: now, lp_value: t.lp_value });
  }
  history = history
    .filter((h) => h.ts >= now - 45 * MS_24H)
    .map((h) => ({
      token: h.token,
      ts: h.ts,
      lp_value: h.lp_value ?? h.lp_usd ?? 0,
    }));

  const byToken = new Map();
  for (const h of history) {
    if (!byToken.has(h.token)) byToken.set(h.token, []);
    byToken.get(h.token).push(h);
  }

  for (const t of ranked) {
    const lp24 = closestLp(byToken, t.token, now - MS_24H);
    const lp7 = closestLp(byToken, t.token, now - MS_7D);
    const lp30 = closestLp(byToken, t.token, now - MS_30D);
    t.lp_change_24h = dollarChange(t.lp_value, lp24);
    t.lp_change_24h_pct = pctChange(t.lp_value, lp24);
    t.lp_change_7d = dollarChange(t.lp_value, lp7);
    t.lp_change_7d_pct = pctChange(t.lp_value, lp7);
    t.lp_change_30d = dollarChange(t.lp_value, lp30);
    t.lp_change_30d_pct = pctChange(t.lp_value, lp30);
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));
  await fs.writeFile(
    OUTPUT_PATH,
    JSON.stringify({ updated: now, tokens: ranked }, null, 2)
  );
  console.log("Done. Wrote data.json + history + launches");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
