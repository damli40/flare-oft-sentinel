import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Conservative target for Mantle's L2 EVM — avoids PUSH0/newer-opcode
      // surprises during on-chain execution and explorer verification.
      evmVersion: "paris",
    },
  },
  networks: {
    // Mantle Sepolia Testnet — deploy + verify here first (clears the
    // 20 Project Deployment Award bar without spending mainnet MNT).
    mantleSepolia: {
      url: process.env.MANTLE_SEPOLIA_RPC || "https://rpc.sepolia.mantle.xyz",
      chainId: 5003,
      accounts,
    },
    // Mantle Mainnet.
    mantle: {
      url: process.env.MANTLE_RPC || "https://rpc.mantle.xyz",
      chainId: 5000,
      accounts,
    },
    // Flare Mainnet — AuditRegistry for the Flare Summer Signal build.
    flare: {
      url: process.env.FLARE_RPC || "https://flare-api.flare.network/ext/C/rpc",
      chainId: 14,
      accounts,
    },
  },
  // `npx hardhat verify` config for the Mantle explorers (Etherscan-powered).
  // A single string apiKey routes through the Etherscan V2 unified endpoint
  // (https://api.etherscan.io/v2/api?chainid=...); the per-network object form
  // hits the deprecated V1 endpoint, which Mantlescan now rejects.
  etherscan: {
    apiKey: process.env.MANTLESCAN_API_KEY || "",
    customChains: [
      {
        network: "mantle",
        chainId: 5000,
        urls: {
          apiURL: "https://api.mantlescan.xyz/api",
          browserURL: "https://mantlescan.xyz",
        },
      },
      {
        network: "mantleSepolia",
        chainId: 5003,
        urls: {
          apiURL: "https://api-sepolia.mantlescan.xyz/api",
          browserURL: "https://sepolia.mantlescan.xyz",
        },
      },
    ],
  },
};

export default config;
