import { ethers } from 'ethers';

export const UNIVERSAL_ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
export const WETH = '0x4200000000000000000000000000000000000006';
export const CLANKER_HOOK = '0x3e342a06f9592459D75721d6956B570F02eF2Dc0';
const BANKR_V2_HOOK = '0xbb7784a4d481184283ed89619a3e3ed143e1adc0';
const CLANKER_AI_HOOK = '0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC';
const BANKR_FEE = 12000;
const BANKR_V2_FEE = 8388608;   // 0x800000 — dynamic fee (new Bankr hook, Feb 2025)
const CLANKER_AI_FEE = 8388608; // 0x800000 — dynamic fee (hook-controlled)
const TICK_SPACING = 200;
const BASE_CHAIN_ID = 8453;

const BASE_RPCS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://1rpc.io/base',
  'https://base.drpc.org',
  'https://base-mainnet.public.blastapi.io',
  'https://base.meowrpc.com',
];

const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const executeIface = new ethers.Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
]);

// --- Pre-cached wallet state (avoids RPC calls on click) ---
let _wallet: ethers.Wallet | null = null;
let _nonce: number | null = null;
let _key: string | null = null;
let _nonceInterval: ReturnType<typeof setInterval> | null = null;

/** Call once when wallet key is set/changed. Fetches nonce + starts auto-refresh. */
export function preloadWallet(privateKey: string) {
  if (_key === privateKey && _wallet) return;
  _key = privateKey;
  if (_nonceInterval) clearInterval(_nonceInterval);
  const provider = new ethers.JsonRpcProvider(BASE_RPCS[0], BASE_CHAIN_ID, {
    staticNetwork: true,
  });
  _wallet = new ethers.Wallet(privateKey, provider);
  _wallet.getNonce().then((n) => { _nonce = n; }).catch(() => {});
  // Auto-refresh nonce every 10s so it stays current after external txs (GMGN sells etc.)
  _nonceInterval = setInterval(() => {
    _wallet?.getNonce().then((n) => { _nonce = n; }).catch(() => {});
  }, 5_000);
}

/** Call when wallet is disconnected */
export function clearWalletCache() {
  if (_nonceInterval) { clearInterval(_nonceInterval); _nonceInterval = null; }
  _wallet = null;
  _nonce = null;
  _key = null;
}

function encodeV4Swap(tokenAddress: string, amountInWei: bigint, factoryType: 'bankr' | 'clanker' = 'bankr'): string {
  const weth = ethers.getAddress(WETH);
  const token = ethers.getAddress(tokenAddress);

  const [currency0, currency1] =
    BigInt(weth) < BigInt(token) ? [weth, token] : [token, weth];
  const zeroForOne = currency0 === weth;

  // Pick pool params based on factory type
  const hook = factoryType === 'clanker' ? CLANKER_AI_HOOK : BANKR_V2_HOOK;
  const fee = factoryType === 'clanker' ? CLANKER_AI_FEE : BANKR_V2_FEE;

  const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
  const CONTRACT_BALANCE = 1n << 255n;

  // Router cmd 0x0b: WRAP_ETH — wrap native ETH → WETH, router keeps it
  const wrapEthInput = abiCoder.encode(
    ['address', 'uint256'],
    [ADDRESS_THIS, amountInWei]
  );

  // V4 action 0x06: SWAP_EXACT_IN_SINGLE
  const swapParams = abiCoder.encode(
    ['(address,address,uint24,int24,address,bool,uint128,uint128,bytes)'],
    [[currency0, currency1, fee, TICK_SPACING, hook, zeroForOne, amountInWei, 0, '0x']]
  );

  // V4 action 0x0b: SETTLE — router settles WETH from its own balance
  const settleParams = abiCoder.encode(
    ['address', 'uint256', 'bool'],
    [weth, amountInWei, false]
  );

  // V4 action 0x0f: TAKE_ALL — take output tokens to msg.sender
  const takeParams = abiCoder.encode(
    ['address', 'uint128'],
    [token, 0]
  );

  // V4_SWAP: SWAP → SETTLE → TAKE_ALL (matches on-chain working format)
  const v4SwapInput = abiCoder.encode(
    ['bytes', 'bytes[]'],
    ['0x060b0f', [swapParams, settleParams, takeParams]]
  );

  const deadline = Math.floor(Date.now() / 1000) + 120;

  return executeIface.encodeFunctionData('execute', [
    '0x0b10',                    // commands: WRAP_ETH + V4_SWAP
    [wrapEthInput, v4SwapInput], // inputs
    deadline,
  ]);
}

/** Raw JSON-RPC broadcast — faster than ethers' broadcastTransaction */
async function rawBroadcast(signedTx: string, rpcUrl: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_sendRawTransaction',
      params: [signedTx],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}


async function signAndBroadcast(
  wallet: ethers.Wallet,
  calldata: string,
  amountInWei: bigint,
  nonce: number,
): Promise<string> {
  const tx: ethers.TransactionRequest = {
    to: UNIVERSAL_ROUTER,
    data: calldata,
    value: amountInWei,
    nonce,
    chainId: BASE_CHAIN_ID,
    type: 2,
    gasLimit: 350_000n,
    maxFeePerGas: ethers.parseUnits('0.5', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('0.01', 'gwei'),
  };

  const signedTx = await wallet.signTransaction(tx);
  return Promise.any(BASE_RPCS.map((url) => rawBroadcast(signedTx, url)));
}

export async function executeBuy(
  privateKey: string,
  tokenAddress: string,
  ethAmount: string,
  factoryType: 'bankr' | 'clanker' = 'bankr',
): Promise<string> {
  const amountInWei = ethers.parseEther(ethAmount);
  const calldata = encodeV4Swap(tokenAddress, amountInWei, factoryType);

  let wallet = _wallet;
  if (!wallet || _key !== privateKey) {
    const provider = new ethers.JsonRpcProvider(BASE_RPCS[0], BASE_CHAIN_ID, {
      staticNetwork: true,
    });
    wallet = new ethers.Wallet(privateKey, provider);
  }

  const nonce = _nonce ?? await wallet.getNonce();

  try {
    const hash = await signAndBroadcast(wallet, calldata, amountInWei, nonce);
    if (_nonce !== null) _nonce++;
    return hash;
  } catch (e: any) {
    // Nonce stale (sold on GMGN etc.) — re-fetch and retry once
    if (e.message?.toLowerCase().includes('nonce')) {
      const freshNonce = await wallet.getNonce();
      _nonce = freshNonce;
      const hash = await signAndBroadcast(wallet, calldata, amountInWei, freshNonce);
      _nonce = freshNonce + 1;
      return hash;
    }
    throw e;
  }
}
