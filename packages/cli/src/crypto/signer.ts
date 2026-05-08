import type { PrivateKeyAccount } from "viem/accounts";

export async function signAegisRequestHeaders(account: PrivateKeyAccount) {
  const timestamp = Date.now().toString();
  const message = `Aegis Auth: ${account.address}:${timestamp}`;
  const signature = await account.signMessage({ message });
  return {
    "x-wallet-address": account.address,
    "x-signature": signature,
    "x-timestamp": timestamp,
  };
}
