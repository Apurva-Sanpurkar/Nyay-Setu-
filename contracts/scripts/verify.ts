/**
 * Submits all three contracts to Etherscan for source verification, reading
 * addresses from contracts/deployed/<network>.json.
 *
 * Needs ETHERSCAN_API_KEY in .env.  Already-verified contracts are skipped
 * rather than treated as failures.
 *
 *   npm run verify:sepolia
 */
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const { network, run } = hre;
  const file = path.join(__dirname, "..", "deployed", `${network.name}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}. Run the deploy script first.`);
  }
  if (!process.env.ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY is not set in contracts/.env");
  }

  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));

  for (const [name, info] of Object.entries<any>(deployment.contracts)) {
    console.log(`\nVerifying ${name} at ${info.address} ...`);
    try {
      await run("verify:verify", {
        address: info.address,
        // Every contract takes the admin address as its single constructor arg.
        constructorArguments: [deployment.deployer],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already verified/i.test(message)) {
        console.log("  already verified");
      } else {
        console.error(`  failed: ${message}`);
      }
    }
  }
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
