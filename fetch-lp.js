// fetch-lp.js
// Fetches top pools.trade tokens by LP from Bitquery, updates history,
// and writes data.json for the website to read.

import fs from "fs/promises";

const API_KEY = process.env.BITQUERY_API_KEY;
const LAUNCHPADS = [
  "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
  "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
  "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2",
  "0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491",
];
const HISTORY_PATH = "data/history.json";
const OUTPUT_PATH = "data.json";
const TOP_N = 100;

async function bitqueryFetch(query) {
  const res = await fetch("https://streaming.bitquery.io/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error("Bitquery error: " + JSON.stringify(json.errors));
  }
  return json.data;
}

// Step 1: get recent launches -> token address + poolId
async function getRecentLaunches() {
  const query = `
    {
      EVM(network: robinhood) {
        Events(
          limit: {count: 1000}
          orderBy: {descending: Block_Time}
          where: {
            LogHeader: {Address: {in: ${JSON.stringify(LAUNCHPADS)}}}
            Log: {Signature: {Name: {is: "TokenLaunched"}}}
          }
        ) {
          Arguments {
            Name
            Type
            Index
            Value {
              ... on EVM_ABI_Address_Value_Arg { address }
              ... on EVM_ABI_Bytes_Value_Arg { hex }
            }
          }
        }
      }
    }
  `;
  const data = await bitqueryFetch(query);
  const launches = [];
  for (const ev of data.EVM.Events) {
    let token = null;
    let poolId = null;
    for (const arg of ev.Arguments) {
      if (arg.Name === "token" && arg.Value?.address) token = arg.Value.address;
      if (arg.Name === "poolId" && arg.Value?.hex) poolId = arg.Value.hex;
    }
    if (token && poolId) launches.push({ token, poolId });
  }
  return launches;
}

// Step 2: get current LP (USD) for a batch of poolIds
async function getCurrentLP(poolIds) {
  const query = `
    {
      EVM(network: robinhood) {
        DEXPoolEvents(
          limit: {count: 3000}
          orderBy: {descending: Block_Time}
          where: {
            PoolEvent: {Pool: {PoolId: {in: ${JSON.stringify(poolIds)}}}}
          }
        ) {
          Block { Time }
          PoolEvent {
            Pool { PoolId }
            Liquidity { AmountCurrencyAInUSD }
          }
        }
      }
    }
  `;
  const data = await bitqueryFetch(query);
  const latestByPool = {};
  for (const row of data.EVM.DEXPoolEvents) {
    const id = row.PoolEvent.Pool.PoolId;
    if (!latestByPool[id]) {
      const ethSideUsd = parseFloat(row.PoolEvent.Liquidity.AmountCurrencyAInUSD || "0");
      latestByPool[id] = ethSideUsd * 2; // double the ETH side to estimate total TVL
    }
  }
  return latestByPool;
}

async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function closestEntry(entries, targetTs) {
  let best = null;
  let bestDiff = Infinity;
  for (const e of entries) {
    const diff = Math.abs(e.ts - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = e;
    }
  }
  return best;
}

async function main() {
  const launches = await getRecentLaunches();
  const poolIds = [...new Set(launches.map(l => l.poolId))];

  const chunks = [];
  for (let i = 0; i < poolIds.length; i += 400) {
    chunks.push(poolIds.slice(i, i + 400));
  }

  let lpByPool = {};
  for (const chunk of chunks) {
    const partial = await getCurrentLP(chunk);
    lpByPool = { ...lpByPool, ...partial };
  }

  const ranked = launches
    .map(l => ({ token: l.token, poolId: l.poolId, lp_usd: lpByPool[l.poolId] || 0 }))
    .filter(t => t.lp_usd > 0)
    .sort((a, b) => b.lp_usd - a.lp_usd)
    .slice(0, TOP_N);

  const now = Date.now();
  const history = await loadHistory();

  for (const t of ranked) {
    history.push({ token: t.token, ts: now, lp_usd: t.lp_usd });
  }
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));

  const DAY = 24 * 60 * 60 * 1000;
  const output = ranked.map(t => {
    const tokenHistory = history.filter(h => h.token === t.token);
    const genesis = tokenHistory.reduce((a, b) => (a.ts < b.ts ? a : b));
    const d1 = closestEntry(tokenHistory, now - DAY);
    const d7 = closestEntry(tokenHistory, now - 7 * DAY);
    const d30 = closestEntry(tokenHistory, now - 30 * DAY);
    const d365 = closestEntry(tokenHistory, now - 365 * DAY);

    const change = (past) =>
      past ? { usd: t.lp_usd - past.lp_usd, pct: ((t.lp_usd - past.lp_usd) / past.lp_usd) * 100 } : null;

    return {
      token: t.token,
      current_lp_usd: t.lp_usd,
      genesis_lp_usd: genesis.lp_usd,
      genesis_ts: genesis.ts,
      change_24h: change(d1),
      change_7d: change(d7),
      change_30d: change(d30),
      change_1y: change(d365),
    };
  });

  await fs.writeFile(OUTPUT_PATH, JSON.stringify({ updated: now, tokens: output }, null, 2));
  console.log(`Done. Tracked ${output.length} tokens.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
