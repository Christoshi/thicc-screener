// fetch-lp.js — pools.trade backfill + tRPC + DexScreener + CoinGecko + RPC launch counts
import fs from "fs/promises";

const OUTPUT_PATH = "data.json";
const HISTORY_PATH = "data/history.json";
const LAUNCHES_PATH = "data/launches.json";
const LAUNCH_COUNTS_PATH = "data/launch-counts.json";
const TOP_N = 100;

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

const ENTRY_CONTRACTS = [
  "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
];
const TOPIC_TOKEN_CREATED =
  "0x2e2b3f61b70d2d131b2a807371103cc98d51adcaa5e9a8f9c32658ad8426e74e";

const CCA_FACTORY = "0x000000001f26a0044baa66024e7b6599c61963f8";
const TOPIC_AUCTION_CREATED =
  "0x7ede475fad18ccf0039f2b956c4d43a8b4ed0853de4daaa8ae25299f331ae3b9";

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api";
const RPC_URLS = [
  "https://robinhood-rpc.publicnode.com",
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood.drpc.org",
];
const START_BLOCK = 28519960;
const BLOCKS_PER_RUN = 80_000;
const COUNTS_BLOCKS_PER_RUN = 150_000;
const ENRICH_CAP = 60;
const LOG_CHUNK_BS = 15_000;
const LOG_CHUNK_RPC = 8_000;
const LOG_DELAY_MS = 250;
const BLOCK_MS = 100;

const ZERO = "0x0000000000000000000000000000000000000000";
const WETH_RH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function rpcCall(method, params) {
  let lastErr = null;
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "thicc-screener/1.0",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) {
        lastErr = json.error.message || JSON.stringify(json.error);
        continue;
      }
      return json.result;
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(lastErr || "RPC fail");
}

async function getLatestBlockMeta() {
  const block = await rpcCall("eth_getBlockByNumber", ["latest", false]);
  return {
    number: parseInt(block.number, 16),
    tsMs: parseInt(block.timestamp, 16) * 1000,
  };
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

async function fetchLogsChunkBS(address, topic0, fromBlock, toBlock) {
  const url =
    `${BLOCKSCOUT}?module=logs&action=getLogs` +
    `&fromBlock=${fromBlock}&toBlock=${toBlock}` +
    `&address=${address.toLowerCase()}&topic0=${topic0}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "thicc-screener/1.0" },
    });
    const json = await res.json();
    if (!Array.isArray(json.result)) return [];
    return json.result;
  } catch {
    return [];
  }
}

async function fetchLogsForRange(fromBlock, toBlock) {
  const found = [];
  for (const addr of LAUNCHPADS) {
    let start = fromBlock;
    while (start <= toBlock) {
      const end = Math.min(start + LOG_CHUNK_BS - 1, toBlock);
      const logs = await fetchLogsChunkBS(addr, TOPIC_TOKEN_LAUNCHED, start, end);
      for (const log of logs) {
        const d = decodeTokenLaunched(log);
        if (d) found.push({ ...d, launchpad: addr.toLowerCase() });
      }
      await sleep(300);
      start = end + 1;
    }
  }
  return found;
}

async function ethGetLogs(address, topic0, fromBlock, toBlock) {
  const result = await rpcCall("eth_getLogs", [
    {
      address: address.toLowerCase(),
      topics: [topic0],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    },
  ]);
  return Array.isArray(result) ? result : [];
}

function blockToTs(blockNum, tipNum, tipTsMs) {
  return tipTsMs - (tipNum - blockNum) * BLOCK_MS;
}

async function collectTimestampsRpc(address, topic0, fromBlock, toBlock, tip) {
  const ts = [];
  let okChunks = 0;
  let failChunks = 0;
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + LOG_CHUNK_RPC - 1, toBlock);
    try {
      const logs = await ethGetLogs(address, topic0, start, end);
      okChunks++;
      for (const log of logs) {
        const bn =
          typeof log.blockNumber === "string"
            ? parseInt(log.blockNumber, 16)
            : Number(log.blockNumber) || 0;
        const t = blockToTs(bn, tip.number, tip.tsMs);
        if (t > 0) ts.push(t);
      }
    } catch (e) {
      failChunks++;
      console.log("  rpc logs fail", address.slice(0, 12), start, e.message);
      await sleep(1000);
    }
    await sleep(LOG_DELAY_MS);
    start = end + 1;
  }
  return { timestamps: ts, okChunks, failChunks };
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

async function loadLaunchCounts() {
  try {
    const raw = await fs.readFile(LAUNCH_COUNTS_PATH, "utf-8");
    const s = JSON.parse(raw);
    return {
      lastScannedBlock: s.lastScannedBlock ?? START_BLOCK - 1,
      startBlock: s.startBlock ?? START_BLOCK,
      total: Array.isArray(s.total) ? s.total : [],
      crowd: Array.isArray(s.crowd) ? s.crowd : [],
    };
  } catch {
    return {
      lastScannedBlock: START_BLOCK - 1,
      startBlock: START_BLOCK,
      total: [],
      crowd: [],
    };
  }
}

function countSince(arr, sinceMs) {
  let n = 0;
  for (const t of arr) if (t >= sinceMs) n++;
  return n;
}

function launchBuckets(arr, now) {
  return {
    h24: countSince(arr, now - MS_24H),
    d7: countSince(arr, now - MS_7D),
    d30: countSince(arr, now - MS_30D),
    all: arr.length,
  };
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

async function loadPrevSides() {
  const map = new Map();
  try {
    const raw = await fs.readFile(OUTPUT_PATH, "utf-8");
    const data = JSON.parse(raw);
    for (const t of data.tokens || []) {
      if (!t.token) continue;
      if (t.eth_side != null || t.token_side != null) {
        map.set(t.token.toLowerCase(), {
          eth_side: t.eth_side ?? null,
          token_side: t.token_side ?? null,
        });
      }
    }
  } catch {
    /* no prior */
  }
  return map;
}

async function fetchEthUsd() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { headers: { Accept: "application/json", "User-Agent": "thicc-screener/1.0" } }
    );
    if (!res.ok) {
      console.log("  CoinGecko HTTP", res.status);
      return null;
    }
    const json = await res.json();
    const p = Number(json?.ethereum?.usd);
    if (!Number.isFinite(p) || p <= 0) return null;
    console.log("  ETH/USD (CoinGecko):", p);
    return p;
  } catch (e) {
    console.log("  CoinGecko fail:", e.message);
    return null;
  }
}

function isEthAddress(addr) {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === ZERO || a === WETH_RH;
}

function pickEthPair(pairs, tokenAddr, preferredPoolId) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const tok = tokenAddr.toLowerCase();
  const ethPairs = pairs.filter((p) => {
    if ((p.chainId || "").toLowerCase() !== "robinhood") return false;
    const base = (p.baseToken?.address || "").toLowerCase();
    const quote = (p.quoteToken?.address || "").toLowerCase();
    return (
      (base === tok || quote === tok) &&
      (isEthAddress(base) || isEthAddress(quote))
    );
  });
  if (!ethPairs.length) return null;
  if (preferredPoolId) {
    const pid = preferredPoolId.toLowerCase().replace(/^0x/, "");
    const match = ethPairs.find(
      (p) => (p.pairAddress || "").toLowerCase().replace(/^0x/, "") === pid
    );
    if (match) return match;
  }
  ethPairs.sort(
    (a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)
  );
  return ethPairs[0];
}

function sidesFromPair(pair, tokenAddr) {
  if (!pair?.liquidity) return null;
  const tok = tokenAddr.toLowerCase();
  const base = (pair.baseToken?.address || "").toLowerCase();
  const quote = (pair.quoteToken?.address || "").toLowerCase();
  const baseAmt = Number(pair.liquidity.base);
  const quoteAmt = Number(pair.liquidity.quote);
  let eth_side = null;
  let token_side = null;
  if (isEthAddress(quote) && base === tok) {
    eth_side = quoteAmt;
    token_side = baseAmt;
  } else if (isEthAddress(base) && quote === tok) {
    eth_side = baseAmt;
    token_side = quoteAmt;
  } else {
    return null;
  }
  if (!Number.isFinite(eth_side) && !Number.isFinite(token_side)) return null;
  return {
    eth_side: Number.isFinite(eth_side) ? +eth_side.toFixed(6) : null,
    token_side: Number.isFinite(token_side) ? +token_side.toFixed(4) : null,
  };
}

async function fetchDexBatch(addresses) {
  const list = addresses.map((a) => a.toLowerCase()).filter(Boolean);
  if (!list.length) return [];
  const url = `https://api.dexscreener.com/tokens/v1/robinhood/${list.join(",")}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "thicc-screener/1.0" },
    });
    if (!res.ok) {
      console.log("  dexscreener HTTP", res.status);
      return [];
    }
    const json = await res.json();
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.pairs)) return json.pairs;
    return [];
  } catch (e) {
    console.log("  dexscreener fail:", e.message);
    return [];
  }
}

async function fetchAllDexSides(ranked) {
  const byToken = new Map();
  for (let i = 0; i < ranked.length; i += 30) {
    const chunk = ranked.slice(i, i + 30);
    const addrs = chunk.map((t) => t.token);
    console.log(
      `  DexScreener batch ${Math.floor(i / 30) + 1}/${Math.ceil(ranked.length / 30)} (${addrs.length} tokens)`
    );
    const pairs = await fetchDexBatch(addrs);
    for (const p of pairs) {
      const base = (p.baseToken?.address || "").toLowerCase();
      const quote = (p.quoteToken?.address || "").toLowerCase();
      for (const addr of [base, quote]) {
        if (!addr || addr === ZERO || addr === WETH_RH) continue;
        if (!byToken.has(addr)) byToken.set(addr, []);
        byToken.get(addr).push(p);
      }
    }
    await sleep(250);
  }
  let ok = 0;
  for (const t of ranked) {
    const pair = pickEthPair(byToken.get(t.token) || [], t.token, t.pool_id);
    const sides = pair ? sidesFromPair(pair, t.token) : null;
    if (sides) {
      t.eth_side = sides.eth_side;
      t.token_side = sides.token_side;
      ok++;
    }
  }
  return ok;
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

async function main() {
  await fs.mkdir("data", { recursive: true });

  const prevSides = await loadPrevSides();
  console.log("Previous sides cached:", prevSides.size);

  const ethUsd = await fetchEthUsd();

  const state = await loadLaunchesState();
  const counts = await loadLaunchCounts();

  let latest = 0;
  try {
    latest = await getLatestBlock();
    console.log("Latest block:", latest);
  } catch (e) {
    console.log("Block height fail:", e.message);
  }

  let tip = null;
  try {
    tip = await getLatestBlockMeta();
    console.log("RPC tip:", tip.number, "ts", tip.tsMs);
  } catch (e) {
    console.log("RPC tip fail:", e.message);
  }

  // --- TokenLaunched discovery (Blockscout, unchanged) ---
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

  // --- Launch counts (public RPC eth_getLogs) ---
  if (tip) {
    if (
      !counts.lastScannedBlock ||
      counts.lastScannedBlock < counts.startBlock - 1 ||
      (counts.total.length < 50 &&
        counts.lastScannedBlock < tip.number - COUNTS_BLOCKS_PER_RUN * 2)
    ) {
      counts.lastScannedBlock = Math.max(
        counts.startBlock - 1,
        tip.number - COUNTS_BLOCKS_PER_RUN
      );
      console.log("  launch-counts cursor reset near tip →", counts.lastScannedBlock);
    }

    const cFrom = counts.lastScannedBlock + 1;
    const cTo = Math.min(cFrom + COUNTS_BLOCKS_PER_RUN - 1, tip.number);
    if (cFrom <= tip.number) {
      console.log(`Scanning launch counts (RPC) ${cFrom} → ${cTo}`);
      let newTotal = 0;
      let newCrowd = 0;
      let okChunks = 0;
      let failChunks = 0;

      for (const addr of ENTRY_CONTRACTS) {
        const r = await collectTimestampsRpc(
          addr,
          TOPIC_TOKEN_CREATED,
          cFrom,
          cTo,
          tip
        );
        counts.total.push(...r.timestamps);
        newTotal += r.timestamps.length;
        okChunks += r.okChunks;
        failChunks += r.failChunks;
      }
      {
        const r = await collectTimestampsRpc(
          CCA_FACTORY,
          TOPIC_AUCTION_CREATED,
          cFrom,
          cTo,
          tip
        );
        counts.crowd.push(...r.timestamps);
        newCrowd += r.timestamps.length;
        okChunks += r.okChunks;
        failChunks += r.failChunks;
      }

      console.log("  new TokenCreated:", newTotal, "AuctionCreated:", newCrowd);
      console.log("  chunks ok/fail:", okChunks, failChunks);

      if (failChunks === 0 || okChunks >= failChunks) {
        counts.lastScannedBlock = cTo;
        console.log("  counts cursor →", counts.lastScannedBlock);
      } else {
        console.log("  counts cursor NOT advanced");
      }

      counts.total = [...new Set(counts.total)].sort((a, b) => a - b);
      counts.crowd = [...new Set(counts.crowd)].sort((a, b) => a - b);
      await fs.writeFile(LAUNCH_COUNTS_PATH, JSON.stringify(counts));
      console.log(
        "  totals so far — TokenCreated:",
        counts.total.length,
        "Crowd:",
        counts.crowd.length
      );
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
      await sleep(120);
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

  for (const t of ranked) {
    const prev = prevSides.get(t.token);
    if (prev) {
      t.eth_side = prev.eth_side;
      t.token_side = prev.token_side;
    }
  }

  console.log("Fetching DexScreener sides for top", ranked.length, "...");
  const dexOk = await fetchAllDexSides(ranked);
  console.log("  dexscreener sides ok:", dexOk);

  for (const t of ranked) {
    if (t.eth_side != null && ethUsd != null) {
      t.eth_side_usd = +(t.eth_side * ethUsd).toFixed(2);
    }
    if (t.token_side != null && t.price != null && t.price > 0) {
      t.token_side_usd = +(t.token_side * t.price).toFixed(2);
    }
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
  let ethNow = 0;
  let ethThen = 0;
  let ethPairs = 0;
  for (const t of withSides) {
    ethNow += t.eth_side || 0;
    const r24 = closestRow(byToken, t.token, now - MS_24H);
    if (r24?.eth_side != null) {
      ethThen += r24.eth_side;
      ethPairs++;
    }
  }
  const totalEthChg24 =
    ethPairs > 0 && ethThen > 0
      ? +(((ethNow - ethThen) / ethThen) * 100).toFixed(2)
      : null;

  const totalB = launchBuckets(counts.total, now);
  const crowdB = launchBuckets(counts.crowd, now);
  const instantB = {
    h24: Math.max(0, totalB.h24 - crowdB.h24),
    d7: Math.max(0, totalB.d7 - crowdB.d7),
    d30: Math.max(0, totalB.d30 - crowdB.d30),
    all: Math.max(0, totalB.all - crowdB.all),
  };

  const stats = {
    pools: ranked.length,
    total_lp_usd: +ranked.reduce((s, t) => s + (t.lp_value || 0), 0).toFixed(2),
    total_volume_24h: +ranked.reduce((s, t) => s + (t.volume_24h || 0), 0).toFixed(2),
    total_eth_side: withSides.length ? +ethNow.toFixed(4) : null,
    total_eth_change_24h_pct: totalEthChg24,
    eth_usd: ethUsd,
    sides_tracked: withSides.length,
    sides_source: "dexscreener",
    instant_launches: instantB,
    crowd_launches: crowdB,
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
