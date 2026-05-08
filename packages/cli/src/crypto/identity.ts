import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { CONFIG_DIR, IDENTITY_PATH } from "../config.js";

export function getOrCreateIdentity() {
  if (process.env.AEGIS_PRIVATE_KEY) {
    let pk = process.env.AEGIS_PRIVATE_KEY;
    if (!pk.startsWith("0x")) pk = `0x${pk}`;
    return { account: privateKeyToAccount(pk as `0x${string}`) };
  }
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (existsSync(IDENTITY_PATH)) {
    try {
      const data = JSON.parse(readFileSync(IDENTITY_PATH, "utf-8"));
      if (data.privateKey)
        return { account: privateKeyToAccount(data.privateKey) };
    } catch {
      /* gen new */
    }
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  writeFileSync(
    IDENTITY_PATH,
    JSON.stringify(
      {
        address: account.address,
        privateKey,
        created: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { account };
}

const { account: userAccount } = getOrCreateIdentity();

export const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL),
});

export const walletClient = createWalletClient({
  account: userAccount,
  chain: base,
  transport: http(process.env.BASE_RPC_URL),
});

/** Primary user wallet derived from `identity.json` or `AEGIS_PRIVATE_KEY`. */
export { userAccount };
