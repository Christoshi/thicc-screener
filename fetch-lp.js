import fs from "fs/promises";

const API_KEY = process.env.BITQUERY_API_KEY;
const LAUNCHPADS = [
  "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
  "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
  "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2",
  "0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491",
];

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
  console.log(JSON.stringify(json, null, 2));
  return json;
}

const query = `
{
  EVM(network: robinhood) {
    Events(
      limit: {count: 5}
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

bitqueryFetch(query);
