import fs from "fs/promises";

const API_KEY = process.env.BITQUERY_API_KEY;
const LAUNCHPADS = [
  "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
  "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
  "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2",
  "0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491",
];
const KNOWN_PATH = "data/known.json";

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
    console.error(JSON.stringify(json.errors, null, 2));
    throw new Error("Bitquery error");
  }
  return json.data;
}

async function getLaunches(since, label) {
  console.log(`Fetching ${label}...`);
  const query = `
    {
      EVM(network: robinhood) {
        Events(
          limit: {count: 2000}
          orderBy: {descending: Block_Time}
          where: {
            LogHeader: {Address: {in: ${JSON.stringify(LAUNCHPADS)}}}
            Log: {Signature: {Name: {is: "TokenLaunched"}}}
            Block: { Time: { since: "${since}" } }
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
  console.log(`  → ${launches.length} events`);
  return launches;
}

async function main() {
  // Progressive backfill – each run goes further back
  const windows = [
    { since: "2026-08-05T00:00:00Z", label: "Aug 5 → now" },
    { since: "2026-07-25T00:00:00Z", label: "Jul 25 → now" },
    { since: "2026-07-15T00:00:00Z", label: "Jul 15 → now" },
    { since: "2026-07-01T00:00:00Z", label: "Jul 1 → now" },
  ];

  let known = [];
  try {
    known = JSON.parse(await fs.readFile(KNOWN_PATH, "utf-8"));
  } catch {}

  const map = new Map(known.map(k => [k.token, k.poolId]));

  for (const w of windows) {
    const launches = await getLaunches(w.since, w.label);
    for (const l of launches) {
      if (!map.has(l.token)) {
        map.set(l.token, l.poolId);
        known.push(l);
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(KNOWN_PATH, JSON.stringify(known, null, 2));
  console.log(`\nDone. Total unique tokens in known.json: ${known.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
