/**
 * Grants roles on already-deployed contracts, reading the addresses from
 * contracts/deployed/<network>.json and the accounts from .env.
 *
 * Use this after adding a new officer wallet, so you do not have to redeploy.
 *
 *   npm run grant:sepolia
 */
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";

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

async function main() {
  const { ethers, network } = hre;
  const file = path.join(__dirname, "..", "deployed", `${network.name}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}. Run the deploy script first.`);
  }

  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();
  console.log(`\nSigner: ${signer.address}\nNetwork: ${network.name}\n`);

  let total = 0;

  for (const [name, info] of Object.entries<any>(deployment.contracts)) {
    const contract = new ethers.Contract(info.address, info.abi, signer);

    for (const [roleName, envKey] of Object.entries(ROLE_ENV)) {
      const addresses = (process.env[envKey] ?? "")
        .split(",")
        .map((a) => a.trim())
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

      if (addresses.length === 0) continue;

      const roleId: string = await contract[roleName]();
      const pending: string[] = [];
      for (const address of addresses) {
        if (!(await contract.hasRole(roleId, address))) pending.push(address);
      }
      if (pending.length === 0) continue;

      const tx = await contract.grantRoleBatch(roleId, pending);
      await tx.wait();
      total += pending.length;
      console.log(`  ${name}.${roleName} += ${pending.join(", ")}`);
    }
  }

  console.log(total === 0 ? "\nNothing to grant; all listed accounts already hold their roles.\n" : `\nGranted ${total} role assignments.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
