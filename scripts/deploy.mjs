/* Deploy DualRate to Stable Studionet (chain 61999) only.
 *
 * Usage:
 *   GENLAYER_PRIVATE_KEY=0x... node scripts/deploy.mjs
 *   # or, for a throwaway test deployer (Studionet is gasless, 0 GEN):
 *   node scripts/deploy.mjs
 *
 * The private key is NEVER written to disk or to deployment.json. If no
 * key is supplied, an ephemeral key is generated for this run only; the
 * contract is permissionless, so losing that key loses nothing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codePath = path.join(root, "contracts", "dualrate.py");
const code = readFileSync(codePath, "utf-8");

const suppliedKey = process.env.GENLAYER_PRIVATE_KEY;
const privateKey = suppliedKey || generatePrivateKey();
if (!suppliedKey) {
  console.log("No GENLAYER_PRIVATE_KEY supplied: using an ephemeral deployer key for this run only.");
}
const account = createAccount(privateKey);
console.log("Deployer:", account.address);
console.log("Network: Stable Studionet, chain 61999, https://studio.genlayer.com/api");

const client = createClient({ chain: studionet, account });
const txHash = await client.deployContract({ code, args: [], leaderOnly: false });
console.log("Deploy tx:", txHash);

const receipt = await client.waitForTransactionReceipt({
  hash: txHash,
  status: TransactionStatus.FINALIZED,
  retries: 180,
  interval: 5000,
});
console.log("Receipt status:", receipt.status, receipt.statusName ?? "");

const address =
  receipt?.data?.contract_address ??
  receipt?.txDataDecoded?.contractAddress ??
  receipt?.contractAddress ??
  null;
if (!address) {
  console.log("Full receipt (no private key):", JSON.stringify(receipt, null, 2).slice(0, 4000));
  throw new Error("Could not find contract address in deploy receipt");
}
console.log("Contract address:", address);

const deployment = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  explorer: `https://explorer-studio.genlayer.com/address/${address}`,
  studio: `https://studio.genlayer.com/?import-contract=${address}`,
  contractAddress: address,
  deployTxHash: txHash,
  deployer: account.address,
  contractFile: "contracts/dualrate.py",
  contractSha256: createHash("sha256").update(code).digest("hex"),
  deployedAt: new Date().toISOString(),
  receiptStatus: receipt.statusName ?? ({ 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" }[receipt.status] ?? String(receipt.status ?? "")),
};
writeFileSync(path.join(root, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");
console.log("Wrote deployment.json");
