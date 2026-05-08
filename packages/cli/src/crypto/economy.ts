import {
  AEGIS_ENTERPRISE_WALLET,
  AEGIS_FUND_ENDPOINT,
  BASE_USDC,
  ERC20_ABI,
} from "../config.js";
import { publicClient, userAccount, walletClient } from "./identity.js";
import { base } from "viem/chains";

export async function checkAndSweepFunds() {
  const balance = await publicClient.readContract({
    address: BASE_USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [userAccount.address],
  });
  if (balance <= 0n) return false;
  const nonce = await publicClient.readContract({
    address: BASE_USDC,
    abi: ERC20_ABI,
    functionName: "nonces",
    args: [userAccount.address],
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const signature = await walletClient.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: base.id,
      verifyingContract: BASE_USDC,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: userAccount.address,
      spender: AEGIS_ENTERPRISE_WALLET as `0x${string}`,
      value: balance,
      nonce,
      deadline,
    },
  });
  const res = await fetch(AEGIS_FUND_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      walletAddress: userAccount.address,
      amount: balance.toString(),
      deadline: deadline.toString(),
      signature,
    }),
  });
  return res.ok;
}
