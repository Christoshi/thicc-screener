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
const TOP_N = 50;

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
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function getRecentLaunches() {
  const query = `
    {
      EVM(network: robinhood) {
        Events(
          limit: {count: 300}
          orderBy: {descending: Block_Time}
          where: {
            LogHeader: {Address: {in: ${JSON.stringify(LAUNCHPADS)}}}
            Log: {Signature: {Name: {is: "TokenLaunched"}}}
          }
        ) {
          Arguments {
            Name
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
      if (arg.Name === "token" && arg.Value?.address) token = arg.Value.address.toLowerCase();
      if (arg.Name === "poolId" && arg.Value?.hex) {
        poolId = arg.Value.hex.startsWith("0x") ? arg.Value.hex.toLowerCase() : ("0x" + arg.Value.hex).toLowerCase();
      }
    }
    if (token && poolId) launches.push({ token, poolId });
  }
  // dedupe by token
  const seen = new Set();
  return launches.filter(l => {
    if (seen.has(l.token)) return false;
    seen.add(l.token);
    return true;
  });
}

async function getCurrentLP(poolIds) {
  const query = `
    {
      EVM(network: robinhood) {
        DEXPoolEvents(
          limit: {count: 2000}
          orderBy: {descending: Block_Time}
          where: {
            PoolEvent: {Pool: {PoolId: {in: ${JSON.stringify(poolIds)}}}}
          }
        ) {
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
    const id = row.PoolEvent.Pool.PoolId.toLowerCase();
    if (!latestByPool[id]) {
      const ethSide = parseFloat(row.PoolEvent.Liquidity.AmountCurrencyAInUSD || "0");
      latestByPool[id] = ethSide * 2; // estimate full TVL
    }
  }
  return latestByPool;
}

async function loadHistory() {
  try {
    return JSON.parse(await fs.readFile(HISTORY_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function closestEntry(entries, targetTs) {
  let best = null, bestDiff = Infinity;
  for (const e of entries) {
    const diff = Math.abs(e.ts - targetTs);
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }
  return best;
}

async function main() {
  console.log("Fetching launches...");
  const launches = await getRecentLaunches();
  console.log(`Found ${launches.length} unique tokens`);

  const poolIds = launches.map(l => l.poolId);
  const lpByPool = await getCurrentLP(poolIds);

  const ranked = launches
    .map(l => ({ token: l.token, poolId: l.poolId, lp_usd: lpByPool[l.poolId] || 0 }))
    .filter(t => t.lp_usd > 50)
    .sort((a, b) => b.lp_usd - a.lp_usd)
    .slice(0, TOP_N);

  console.log(`Ranked ${ranked.length} tokens with LP > $50`);

  const now = Date.now();
  let history = await loadHistory();

  for (const t of ranked) {
    history.push({ token: t.token, ts: now, lp_usd: t.lp_usd });
  }
  // keep history from getting too big
  if (history.length > 20000) history = history.slice(-15000);

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));

  const DAY = 86400000;
  const output = ranked.map(t => {
    const th = history.filter(h => h.token === t.token);
    const genesis = th.reduce((a, b) => a.ts < b.ts ? a : b, th[0]);
    const d1 = closestEntry(th, now - DAY);
    const d7 = closestEntry(th, now - 7 * DAY);
    const d30 = closestEntry(th, now - 30 * DAY);

    const change = (past) => past && past.lp_usd > 0
      ? { usd: +(t.lp_usd - past.lp_usd).toFixed(2), pct: +(((t.lp_usd - past.lp_usd) / past.lp_usd) * 100).toFixed(1) }
      : null;

    return {
      token: t.token,
      current_lp_usd: +t.lp_usd.toFixed(2),
      genesis_lp_usd: genesis ? +genesis.lp_usd.toFixed(2) : null,
      genesis_ts: genesis?.ts || null,
      change_24h: change(d1),
      change_7d: change(d7),
      change_30d: change(d30),
    };
  });

  await fs.writeFile(OUTPUT_PATH, JSON.stringify({ updated: now, tokens: output }, null, 2));
  console.log(`Done. Tracked ${output.length} tokens.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
