/* End-to-end on-chain flow against an already-deployed DualRate contract.
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... GENLAYER_PRIVATE_KEY=0x... node scripts/flow.mjs
 *   # or without a key: an ephemeral account is used (permissionless writes).
 *
 * Steps: request_rate("USD","EUR") -> verify_rate(id) on-chain
 * (validators fetch BOTH providers and must agree per-source and
 * cross-source) -> read it back. Writes evidence.json (tx hashes, final
 * status, agreed record). No key is ever written to disk.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const address = process.env.CONTRACT_ADDRESS || deployment.contractAddress;
if (!address) throw new Error("No contract address: set CONTRACT_ADDRESS or run deploy first");

const account = createAccount(process.env.GENLAYER_PRIVATE_KEY || generatePrivateKey());
console.log("Flow account:", account.address);
console.log("Contract:", address);
const client = createClient({ chain: studionet, account });

async function waitFinal(hash, label) {
  console.log(`${label} tx:`, hash);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.FINALIZED,
    retries: 180,
    interval: 5000,
  });
  console.log(`${label} final:`, receipt.statusName ?? receipt.status);
  return receipt;
}

const requestTx = await client.writeContract({
  address,
  functionName: "request_rate",
  args: ["USD", "EUR"],
  value: 0n,
  leaderOnly: false,
});
await waitFinal(requestTx, "request");

const countRaw = await client.readContract({ address, functionName: "get_count", args: [] });
const count = Number(countRaw);
console.log("Rate count:", count);
const id = BigInt(count - 1);

const verifyTx = await client.writeContract({
  address,
  functionName: "verify_rate",
  args: [id],
  value: 0n,
  leaderOnly: false,
});
const verifyReceipt = await waitFinal(verifyTx, "verify");

const recordRaw = await client.readContract({
  address,
  functionName: "get_rate",
  args: [id],
});
const record = typeof recordRaw === "string" ? JSON.parse(recordRaw) : recordRaw;
console.log("Agreed record:", JSON.stringify(record, null, 2));
if (record.status !== "agreed" || !record.agreed_rate) {
  throw new Error("Flow did not produce an agreed record");
}
const agreed = parseFloat(record.agreed_rate);
if (!(agreed >= 0.88 && agreed <= 0.91)) {
  throw new Error(`Agreed rate ${record.agreed_rate} outside the expected near-0.895 band`);
}

const evidence = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: address,
  explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  flowAccount: account.address,
  rateId: Number(id),
  requestTxHash: requestTx,
  verifyTxHash: verifyTx,
  verifyReceiptStatus: verifyReceipt.statusName ?? ({ 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" }[verifyReceipt.status] ?? String(verifyReceipt.status ?? "")),
  record,
  checkedAt: new Date().toISOString(),
};
writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log("Wrote evidence.json");
