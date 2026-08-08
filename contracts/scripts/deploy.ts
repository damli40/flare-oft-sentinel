import hre from "hardhat";

async function main() {
  const networkName = hre.network.name;
  console.log(`Deploying OFT Sentinel contracts to "${networkName}"...`);

  const registry = await hre.viem.deployContract("AuditRegistry");
  console.log(`✅ AuditRegistry deployed: ${registry.address}`);

  const alertBus = await hre.viem.deployContract("AlertBus");
  console.log(`✅ AlertBus     deployed: ${alertBus.address}`);

  console.log(`\nNext steps:`);
  console.log(`  1. Verify both on the explorer:`);
  console.log(`       npx hardhat verify --network ${networkName} ${registry.address}`);
  console.log(`       npx hardhat verify --network ${networkName} ${alertBus.address}`);
  console.log(`  2. Backend .env: AUDIT_REGISTRY_ADDRESS=${registry.address}`);
  console.log(`                   ALERT_BUS_ADDRESS=${alertBus.address}`);
  console.log(`  3. Fund AlertBus with a little MNT (for nudges) and add the address to the`);
  console.log(`     DoraHacks submission (required deployed contract address).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
