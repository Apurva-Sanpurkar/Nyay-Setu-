/**
 * Deploys the three NyaySetu contracts, grants the operator roles listed in
 * .env, and writes a single artefact the backend consumes at boot:
 *
 *   contracts/deployed/<network>.json
 *
 * That file carries both addresses and ABIs so the backend needs no build-time
 * dependency on the Hardhat artifacts directory.
 *
 * Usage:
 *   npx hardhat node                    # terminal 1, for the local chain
 *   npm run deploy:local                # terminal 2
 *   npm run deploy:sepolia              # once SEPOLIA_RPC_URL + key are set
 */
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";

const CONTRACT_NAMES = ["EvidenceChain", "SummonsChain", "BailChain"] as const;

const ROLE_ENV: Record<string, string> = {
  POLICE_ROLE: "POLICE_ADDRESSES",
  FORENSIC_ROLE: "FORENSIC_ADDRESSES",
  PROSECUTOR_ROLE: "PROSECUTOR_ADDRESSES",
  JUDGE_ROLE: "JUDGE_ADDRESSES",
  DEFENCE_ROLE: "DEFENCE_ADDRESSES",
  ACCUSED_ROLE: "ACCUSED_ADDRESSES",
  COURT_ADMIN_ROLE: "COURT_ADMIN_ADDRESSES",
  KEEPER_ROLE: "KEEPER_ADDRESSES",
};

function addressesFrom(envKey: string): string[] {
  return (process.env[envKey] ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
}

async function main() {
  const { ethers, network, artifacts } = hre;
  const [deployer] = await ethers.getSigners();

  if (!deployer) {
    throw new Error(
      "No signer available. Set DEPLOYER_PRIVATE_KEY in contracts/.env for a live network."
    );
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`\nNetwork  : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer : ${deployer.address}`);
  console.log(`Balance  : ${ethers.formatEther(balance)} ETH\n`);

  if (balance === 0n && network.name !== "hardhat") {
    throw new Error("Deployer has no ETH. Fund it from a Sepolia faucet first.");
  }

  const deployedContracts: Record<string, { address: string; abi: unknown[] }> = {};
  const instances: Record<string, any> = {};

  for (const name of CONTRACT_NAMES) {
    const factory = await ethers.getContractFactory(name);
    // Every contract takes the initial admin address in its constructor.
    const contract = await factory.deploy(deployer.address);
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    const { abi } = await artifacts.readArtifact(name);

    deployedContracts[name] = { address, abi };
    instances[name] = contract;
    console.log(`  ${name.padEnd(14)} -> ${address}`);
  }

  // ---------------------------------------------------------------- roles
  //
  // The NyayRoles constructor grants the admin only DEFAULT_ADMIN_ROLE,
  // COURT_ADMIN_ROLE and KEEPER_ROLE. It deliberately does not grant POLICE,
  // FORENSIC, PROSECUTOR, JUDGE or ACCUSED, because in a real deployment those
  // belong to different wallets.
  //
  // A single-machine demo has one wallet for everything, so any role with no
  // address listed in .env falls back to the deployer. Without this the first
  // registerEvidence call reverts with AccessControlUnauthorizedAccount, which
  // is correct behaviour and a baffling first experience.
  console.log("\nGranting roles ...");
  let grantCount = 0;
  const fallbackRoles: string[] = [];

  for (const [roleName, envKey] of Object.entries(ROLE_ENV)) {
    let addresses = addressesFrom(envKey);

    if (addresses.length === 0) {
      addresses = [deployer.address];
      fallbackRoles.push(roleName);
    }

    for (const name of CONTRACT_NAMES) {
      const contract = instances[name];
      const roleId: string = await contract[roleName]();

      // grantRoleBatch is idempotent in effect, but skipping accounts that
      // already hold the role keeps the gas bill honest on a live network.
      const pending: string[] = [];
      for (const address of addresses) {
        if (!(await contract.hasRole(roleId, address))) pending.push(address);
      }
      if (pending.length === 0) continue;

      const tx = await contract.grantRoleBatch(roleId, pending);
      await tx.wait();
      grantCount += pending.length;
    }

    if (!fallbackRoles.includes(roleName)) {
      console.log(`  ${roleName.padEnd(18)} -> ${addresses.join(", ")}`);
    }
  }

  if (fallbackRoles.length > 0) {
    console.log(`  ${fallbackRoles.length} role(s) not listed in .env, granted to the deployer:`);
    console.log(`    ${fallbackRoles.join(", ")}`);
    console.log("  That is what makes a single-machine demo work. Split them for a real deployment.");
  }
  console.log(`  ${grantCount} role assignment(s) written`);

  // ------------------------------------------------------- bail grace period
  const grace = Number(process.env.BAIL_GRACE_PERIOD_SECONDS ?? "0");
  if (Number.isFinite(grace) && grace >= 0) {
    const tx = await instances.BailChain.setGracePeriod(BigInt(grace));
    await tx.wait();
    console.log(`\nBailChain grace period set to ${grace}s`);
  }

  // ------------------------------------------------------------- write file
  const outDir = path.join(__dirname, "..", "deployed");
  fs.mkdirSync(outDir, { recursive: true });

  const payload = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 0),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    blockNumber: await ethers.provider.getBlockNumber(),
    gracePeriodSeconds: grace,
    contracts: deployedContracts,
  };

  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

  // A stable filename so the backend can point at one path across networks.
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(payload, null, 2));

  console.log(`\nWrote ${path.relative(process.cwd(), outFile)} and deployed/latest.json`);
  console.log("\nNext: copy these addresses into backend/.env\n");
  for (const name of CONTRACT_NAMES) {
    const envName = name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase() + "_ADDRESS";
    console.log(`  ${envName}=${deployedContracts[name].address}`);
  }
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
