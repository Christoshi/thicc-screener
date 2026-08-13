import fs from "fs/promises";

const API_KEY = process.env.BITQUERY_API_KEY;
const LAUNCHPADS = [
  "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
  "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
  "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2",
  "0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491",
];
const HISTORY_PATH = "data/history.json";
const KNOWN_PATH = "data/known.json";   // persistent list of token + poolId
const OUTPUT_PATH = "data.json";
const TOP_N = 120;
const MAX_POOLS_PER_RUN = 800;          // keep under free-tier limits

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

async function getNewLaunches() {
  const query = `
    {
      EVM(network: robinhood) {
        Events(
          limit: {count: 1500}
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
  for (const ev of data.EVM.Events || []) {
    let token = null, poolId = null;
    for (const arg of ev.Arguments) {
      if (arg.Name === "token" && arg.Value?.address) {
        token = arg.Value.address.toLowerCase();
      }
      if (arg.Name === "poolId" && arg.Value?.hex) {
        const hex = arg.Value.hex;
        poolId = (hex.startsWith("0x") ? hex : "0x" + hex).toLowerCase();
      }
    }
    if (token && poolId) launches.push({ token, poolId });
  }

  // dedupe
  const seen = new Set();
  return launches.filter(l => {
    if (seen.has(l.token)) return false;
    seen.add(l.token);
    return true;
  });
}

async function getLP(poolIds) {
  if (poolIds.length === 0) return {};
  // split into chunks of 200 to stay safe
  const chunks = [];
  for (let i = 0; i < poolIds.length; i += 200) {
    chunks.push(poolIds.slice(i, i + 200));
  }

  const map = {};
  for (const chunk of chunks) {
    const query = `
      {
        EVM(network: robinhood) {
          DEXPoolEvents(
            limit: {count: 2000}
            orderBy: {descending: Block_Time}
            where: {
              PoolEvent: {Pool: {PoolId: {in: ${JSON.stringify(chunk)}}}}
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
    for (const row of data.EVM.DEXPoolEvents || []) {
      const id = row.PoolEvent.Pool.PoolId.toLowerCase();
      if (!map[id]) {
        const eth = parseFloat(row.PoolEvent.Liquidity.AmountCurrencyAInUSD || 0);
        map[id] = eth * 2;
      }
    }
  }
  return map;
}

async function getSymbols(tokens) {
  if (tokens.length === 0) return {};
  const query = `
    {
      EVM(network: robinhood) {
        Transfers(
          limit: {count: ${Math.min(tokens.length * 2, 400)}}
          where: {
            Transfer: {
              Sender: {is: "0x0000000000000000000000000000000000000000"}
              Currency: {SmartContract: {in: ${JSON.stringify(tokens)}}}
            }
          }
        ) {
          Transfer {
            Currency { SmartContract Symbol Name }
          }
        }
      }
    }
  `;
  const data = await bitqueryFetch(query);
  const map = {};
  for (const row of data.EVM.Transfers || []) {
    const c = row.Transfer.Currency;
    if (c?.SmartContract) {
      map[c.SmartContract.toLowerCase()] = {
        symbol: c.Symbol || "???",
        name: c.Name || ""
      };
    }
  }
  return map;
}

async function loadJSON(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function closest(entries, target) {
  let best = null, bestDiff = Infinity;
  for (const e of entries) {
    const d = Math.abs(e.ts - target);
    if (d < bestDiff) { bestDiff = d; best = e; }
  }
  return best;
}

async function main() {
  console.log("Loading known tokens...");
  let known = await loadJSON(KNOWN_PATH, []); // [{token, poolId}]
  const knownMap = new Map(known.map(k => [k.token, k.poolId]));

  console.log("Fetching new launches...");
  const newLaunches = await getNewLaunches();
  console.log(`New launches found: ${newLaunches.length}`);

  // Merge new launches into known list
  for (const l of newLaunches) {
    if (!knownMap.has(l.token)) {
      known.push({ token: l.token, poolId: l.poolId });
      knownMap.set(l.token, l.poolId);
    }
  }

  // Limit how many we query this run (newest first)
  const toQuery = known.slice(-MAX_POOLS_PER_RUN);
  const poolIds = toQuery.map(k => k.poolId);

  console.log(`Querying LP for ${poolIds.length} pools...`);
  const lpMap = await getLP(poolIds);

  let candidates = toQuery
    .map(k => ({
      token: k.token,
      poolId: k.poolId,
      lp_usd: lpMap[k.poolId] || 0
    }))
    .filter(t => t.lp_usd > 15)
    .sort((a, b) => b.lp_usd - a.lp_usd)
    .slice(0, TOP_N);

  console.log(`Ranked ${candidates.length} tokens`);

  // symbols
  const symbols = await getSymbols(candidates.map(c => c.token));
  candidates = candidates.map(c => ({
    ...c,
    symbol: symbols[c.token]?.symbol || c.token.slice(0, 6),
    name: symbols[c.token]?.name || ""
  }));

  // history for changes
  let history = await loadJSON(HISTORY_PATH, []);
  const now = Date.now();
  for (const t of candidates) {
    history.push({ token: t.token, ts: now, lp_usd: t.lp_usd });
  }
  if (history.length > 60000) history = history.slice(-50000);

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(KNOWN_PATH, JSON.stringify(known));
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history));

  const DAY = 86400000;
  const output = candidates.map(t => {
    const th = history.filter(h => h.token === t.token);
    const genesis = th.length ? th.reduce((a, b) => a.ts < b.ts ? a : b) : null;
    const d1 = closest(th, now - DAY);
    const d7 = closest(th, now - 7 * DAY);
    const d30 = closest(th, now - 30 * DAY);

    const ch = (p) => p && p.lp_usd > 0
      ? { usd: +(t.lp_usd - p.lp_usd).toFixed(2), pct: +(((t.lp_usd - p.lp_usd) / p.lp_usd) * 100).toFixed(1) }
      : null;

    return {
      token: t.token,
      symbol: t.symbol,
      name: t.name,
      current_lp_usd: +t.lp_usd.toFixed(2),
      genesis_lp_usd: genesis ? +genesis.lp_usd.toFixed(2) : null,
      genesis_ts: genesis?.ts || null,
      change_24h: ch(d1),
      change_7d: ch(d7),
      change_30d: ch(d30)
    };
  });

  await fs.writeFile(OUTPUT_PATH, JSON.stringify({ updated: now, tokens: output }, null, 2));
  console.log(`Done. Tracked ${output.length} tokens. Known total: ${known.length}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
