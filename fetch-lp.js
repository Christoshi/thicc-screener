// fetch-lp.js — pools.trade backfill + tRPC stats + Bitquery sides (top 100)
import fs from "fs/promises";

const OUTPUT_PATH = "data.json";
const HISTORY_PATH = "data/history.json";
const LAUNCHES_PATH = "data/launches.json";
const TOP_N = 100;
const SIDES_CAP = 100;

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * MS_24H;
const MS_30D = 30 * MS_24H;

const LAUNCHPADS = [
  "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
  "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
  "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2",
  "0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491",
];
const TOPIC_TOKEN_LAUNCHED =
  "0x3b3d2bafdcae274a232217e1f80ee4305d3af6aa25c8b14b1681bd68d18042a4";

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api";
const START_BLOCK = 28519960;
const BLOCKS_PER_RUN = 80_000;
const ENRICH_CAP = 60;

const BITQUERY_URL = "https://streaming.bitquery.io/graphql";
const BITQUERY_KEY = process.env.BITQUERY_API_KEY || "";

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
  if (!token || token.length !== 42) return null;
  return {
    token,
    symbol: l.tokenSymbol || "???",
    name: l.tokenName || "",
    image: l.imageUrl || null,
    emoji: l.imageEmoji || null,
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
  const res = await fetch(
    "https://robinhoodchain.blockscout.com/api/v2/blocks?type=block"
  );
  const json = await res.json();
  const h = json?.items?.[0]?.height;
  if (!h) throw new Error("Could not get latest block");
  return Number(h);
}

function decodeTokenLaunched(log) {
  const topics = log.topics || [];
  let token = null;
  let poolId = null;
  if (topics[1]) poolId = topics[1].toLowerCase();
  if (topics[2] && topics[2].length >= 66) {
    token = ("0x" + topics[2].slice(-40)).toLowerCase();
  }
  if (!token || token.length !== 42) return null;
  const bn =
    typeof log.blockNumber === "string" && log.blockNumber.startsWith("0x")
      ? parseInt(log.blockNumber, 16)
      : Number(log.blockNumber) || 0;
  return { token, poolId, blockNumber: bn, txHash: log.transactionHash || null };
}

async function fetchLogsForRange(fromBlock, toBlock) {
  const found = [];
  for (const addr of LAUNCHPADS) {
    let start = fromBlock;
    while (start <= toBlock) {
      const end = Math.min(start + 15_000 - 1, toBlock);
      const url =
        `${BLOCKSCOUT}?module=logs&action=getLogs` +
        `&fromBlock=${start}&toBlock=${end}` +
        `&address=${addr}&topic0=${TOPIC_TOKEN_LAUNCHED}`;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "thicc-screener/1.0" },
        });
        const json = await res.json();
        const logs = Array.isArray(json.result) ? json.result : [];
        for (const log of logs) {
          const d = decodeTokenLaunched(log);
          if (d) found.push({ ...d, launchpad: addr.toLowerCase() });
        }
      } catch (e) {
        console.log("  log err", addr.slice(0, 10), start, e.message);
      }
      await new Promise((r) => setTimeout(r, 200));
      start = end + 1;
    }
  }
  return found;
}

async function loadLaunchesState() {
  try {
    const raw = await fs.readFile(LAUNCHES_PATH, "utf-8");
    const s = JSON.parse(raw);
    if (!s.startBlock || s.startBlock < START_BLOCK) s.startBlock = START_BLOCK;
    if (s.lastScannedBlock > 0 && s.lastScannedBlock < START_BLOCK - 1) {
      s.lastScannedBlock = START_BLOCK - 1;
      s.backfillDone = false;
    }
    return s;
  } catch {
    return {
      backfillDone: false,
      lastScannedBlock: START_BLOCK - 1,
      startBlock: START_BLOCK,
      tokens: {},
    };
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

function closestRow(byToken, token, targetTs) {
  const rows = byToken.get(token);
  if (!rows?.length) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.ts - targetTs);
    if (d < bestDiff) {
      bestDiff = d;
      best = r;
    }
  }
  if (best == null || bestDiff > 12 * 3600e3) return null;
  return best;
}

function dollarChange(now, then) {
  if (then == null || now == null) return null;
  return +(now - then).toFixed(6);
}
function pctChange(now, then) {
  if (then == null || then === 0 || now == null) return null;
  return +(((now - then) / then) * 100).toFixed(2);
}

async function fetchPoolSides(poolId) {
  if (!BITQUERY_KEY || !poolId) return null;
  const pid = poolId.startsWith("0x") ? poolId.toLowerCase() : "0x" + poolId.toLowerCase();
  const query = `
    query {
      EVM(network: robinhood) {
        DEXPoolEvents(
          limit: { count: 1 }
          orderBy: { descending: Block_Time }
          where: {
            PoolEvent: {
              Pool: { PoolId: { is: "${pid}" } }
            }
          }
        ) {
          PoolEvent {
            Liquidity {
              AmountCurrencyA
              AmountCurrencyB
            }
          }
        }
      }
    }`;
  try {
    const res = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BITQUERY_KEY}`,
        "X-API-KEY": BITQUERY_KEY,
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      console.log("  bitquery HTTP", res.status, pid.slice(0, 12));
      return null;
    }
    const json = await res.json();
    if (json.errors?.length) {
      console.log("  bitquery err", json.errors[0]?.message || json.errors);
      return null;
    }
    const row = json?.data?.EVM?.DEXPoolEvents?.[0]?.PoolEvent?.Liquidity;
    if (!row) return null;
    const eth = Number(row.AmountCurrencyA);
    const tok = Number(row.AmountCurrencyB);
    if (!Number.isFinite(eth) && !Number.isFinite(tok)) return null;
    return {
      eth_side: Number.isFinite(eth) ? +eth.toFixed(6) : null,
      token_side: Number.isFinite(tok) ? +tok.toFixed(4) : null,
    };
  } catch (e) {
    console.log("  bitquery fail", e.message);
    return null;
  }
}

async function main() {
  await fs.mkdir("data", { recursive: true });

  const state = await loadLaunchesState();
  let latest = 0;
  try {
    latest = await getLatestBlock();
    console.log("Latest block:", latest);
  } catch (e) {
    console.log("Block height fail:", e.message);
  }

  if (latest > 0) {
    if (!state.lastScannedBlock || state.lastScannedBlock < state.startBlock - 1) {
      state.lastScannedBlock = state.startBlock - 1;
    }
    const fromBlock = state.lastScannedBlock + 1;
    const toBlock = Math.min(fromBlock + BLOCKS_PER_RUN - 1, latest);

    if (fromBlock <= latest) {
      console.log(
        `Scanning TokenLaunched ${fromBlock} → ${toBlock}` +
          (state.backfillDone ? " (incremental)" : " (backfill)")
      );
      const events = await fetchLogsForRange(fromBlock, toBlock);
      console.log("  events:", events.length);
      let added = 0;
      for (const e of events) {
        if (!state.tokens[e.token]) {
          state.tokens[e.token] = {
            token: e.token,
            poolId: e.poolId,
            blockNumber: e.blockNumber,
            launchpad: e.launchpad,
          };
          added++;
        }
      }
      console.log("  new tokens:", added);
      state.lastScannedBlock = toBlock;
      if (!state.backfillDone && state.lastScannedBlock >= latest - 100) {
        state.backfillDone = true;
        console.log("Backfill complete.");
      } else if (!state.backfillDone) {
        const pct = (
          ((state.lastScannedBlock - state.startBlock) /
            Math.max(1, latest - state.startBlock)) *
          100
        ).toFixed(2);
        console.log(`Backfill progress ~${pct}% (cursor ${state.lastScannedBlock})`);
      }
      await fs.writeFile(LAUNCHES_PATH, JSON.stringify(state, null, 2));
    }
  }

  const launchTokens = Object.keys(state.tokens);
  console.log("Known launches in launches.json:", launchTokens.length);

  const map = new Map();

  async function pullList(sortBy) {
    try {
      const list = (await trpc("curve.listLaunches", { sortBy })) || [];
      const arr = Array.isArray(list) ? list : [];
      console.log(`  listLaunches ${sortBy}:`, arr.length);
      for (const l of arr) {
        const m = mapLaunch(l, "curve");
        if (m && (!map.has(m.token) || m.lp_value > (map.get(m.token).lp_value || 0))) {
          map.set(m.token, m);
        }
      }
    } catch (e) {
      console.log(`  listLaunches ${sortBy} skip:`, e.message);
    }
  }

  console.log("Fetching tRPC lists...");
  await pullList("volume");
  await pullList("trending");
  await pullList("recency");

  try {
    const auctions = (await trpc("cca.listAuctions", {})) || [];
    const arr = Array.isArray(auctions) ? auctions : [];
    console.log("  listAuctions:", arr.length);
    for (const a of arr) {
      if (a.status !== "graduated" && !a.poolKeyHash && !a.poolStats) continue;
      const m = mapLaunch(a, "cca");
      if (m && (!map.has(m.token) || m.lp_value > (map.get(m.token).lp_value || 0))) {
        map.set(m.token, m);
      }
    }
  } catch (e) {
    console.log("  cca skip:", e.message);
  }

  const needEnrich = launchTokens.filter((t) => {
    const existing = map.get(t);
    return !existing || existing.lp_value <= 0;
  });
  needEnrich.sort(
    (a, b) =>
      (state.tokens[b]?.blockNumber || 0) - (state.tokens[a]?.blockNumber || 0)
  );

  console.log("Enrich candidates:", needEnrich.length, "→ cap", ENRICH_CAP);
  for (const token of needEnrich.slice(0, ENRICH_CAP)) {
    try {
      const data = await trpc("curve.getLaunchByAddress", { tokenAddress: token });
      const m = mapLaunch(data, "curve");
      if (m && (m.lp_value > 0 || m.fdv > 0)) map.set(m.token, m);
      await new Promise((r) => setTimeout(r, 120));
    } catch {
      /* skip */
    }
  }

  for (const [token, m] of map) {
    if (!m.pool_id && state.tokens[token]?.poolId) {
      m.pool_id = state.tokens[token].poolId;
    }
  }

  const ranked = [...map.values()]
    .filter((t) => t.lp_value > 0 || t.fdv > 0)
    .sort((a, b) => b.lp_value - a.lp_value)
    .slice(0, TOP_N);

  console.log("Ranked", ranked.length);
  if (ranked[0]) console.log("Top:", ranked[0].symbol, "LP $", ranked[0].lp_value);

  if (BITQUERY_KEY) {
    console.log(`Fetching Bitquery sides for top ${SIDES_CAP}...`);
    let ok = 0;
    for (const t of ranked.slice(0, SIDES_CAP)) {
      if (!t.pool_id) continue;
      const sides = await fetchPoolSides(t.pool_id);
      if (sides) {
        t.eth_side = sides.eth_side;
        t.token_side = sides.token_side;
        ok++;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log("  sides ok:", ok);
  } else {
    console.log("BITQUERY_API_KEY not set — skipping sides");
  }

  const now = Date.now();
  let history = await loadHistory();
  for (const t of ranked) {
    history.push({
      token: t.token,
      ts: now,
      lp_value: t.lp_value,
      eth_side: t.eth_side ?? null,
      token_side: t.token_side ?? null,
    });
  }
  history = history
    .filter((h) => h.ts >= now - 45 * MS_24H)
    .map((h) => ({
      token: h.token,
      ts: h.ts,
      lp_value: h.lp_value ?? h.lp_usd ?? 0,
      eth_side: h.eth_side ?? null,
      token_side: h.token_side ?? null,
    }));

  const byToken = new Map();
  for (const h of history) {
    if (!byToken.has(h.token)) byToken.set(h.token, []);
    byToken.get(h.token).push(h);
  }

  for (const t of ranked) {
    const r24 = closestRow(byToken, t.token, now - MS_24H);
    const r7 = closestRow(byToken, t.token, now - MS_7D);
    const r30 = closestRow(byToken, t.token, now - MS_30D);

    t.lp_change_24h = dollarChange(t.lp_value, r24?.lp_value);
    t.lp_change_24h_pct = pctChange(t.lp_value, r24?.lp_value);
    t.lp_change_7d = dollarChange(t.lp_value, r7?.lp_value);
    t.lp_change_7d_pct = pctChange(t.lp_value, r7?.lp_value);
    t.lp_change_30d = dollarChange(t.lp_value, r30?.lp_value);
    t.lp_change_30d_pct = pctChange(t.lp_value, r30?.lp_value);

    if (t.eth_side != null) {
      t.eth_change_24h = dollarChange(t.eth_side, r24?.eth_side);
      t.eth_change_24h_pct = pctChange(t.eth_side, r24?.eth_side);
      t.eth_change_7d = dollarChange(t.eth_side, r7?.eth_side);
      t.eth_change_7d_pct = pctChange(t.eth_side, r7?.eth_side);
      t.eth_change_30d = dollarChange(t.eth_side, r30?.eth_side);
      t.eth_change_30d_pct = pctChange(t.eth_side, r30?.eth_side);
    }
    if (t.token_side != null) {
      t.token_change_24h = dollarChange(t.token_side, r24?.token_side);
      t.token_change_24h_pct = pctChange(t.token_side, r24?.token_side);
      t.token_change_7d = dollarChange(t.token_side, r7?.token_side);
      t.token_change_7d_pct = pctChange(t.token_side, r7?.token_side);
      t.token_change_30d = dollarChange(t.token_side, r30?.token_side);
      t.token_change_30d_pct = pctChange(t.token_side, r30?.token_side);
    }
  }

  const withSides = ranked.filter((t) => t.eth_side != null);
  const stats = {
    pools: ranked.length,
    total_lp_usd: +ranked.reduce((s, t) => s + (t.lp_value || 0), 0).toFixed(2),
    total_volume_24h: +ranked.reduce((s, t) => s + (t.volume_24h || 0), 0).toFixed(2),
    total_eth_side: withSides.length
      ? +withSides.reduce((s, t) => s + (t.eth_side || 0), 0).toFixed(4)
      : null,
    sides_tracked: withSides.length,
  };

  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));
  await fs.writeFile(
    OUTPUT_PATH,
    JSON.stringify({ updated: now, stats, tokens: ranked }, null, 2)
  );
  console.log("Done. stats:", stats);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
