import { ethers } from 'ethers';

export const UNIVERSAL_ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
export const WETH = '0x4200000000000000000000000000000000000006';
export const CLANKER_HOOK = '0x3e342a06f9592459D75721d6956B570F02eF2Dc0';
const FEE = 12000;
const TICK_SPACING = 200;
const BASE_CHAIN_ID = 8453;

const BASE_RPCS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://1rpc.io/base',
];

const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const executeIface = new ethers.Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
]);

function encodeV4Swap(tokenAddress: string, amountInWei: bigint): string {
  const weth = ethers.getAddress(WETH);
  const token = ethers.getAddress(tokenAddress);

  // Sort for PoolKey — currency0 must be the smaller address
  const [currency0, currency1] =
    BigInt(weth) < BigInt(token) ? [weth, token] : [token, weth];
  const zeroForOne = currency0 === weth; // true = selling WETH (currency0) for token

  // 0x06 SWAP_EXACT_IN_SINGLE
  // ExactInputSingleParams is a struct with dynamic `bytes hookData` — must encode as tuple (adds 0x20 offset prefix)
  const swapParams = abiCoder.encode(
    ['(address,address,uint24,int24,address,bool,uint128,uint128,bytes)'],
    [[currency0, currency1, FEE, TICK_SPACING, CLANKER_HOOK, zeroForOne, amountInWei, 0, '0x00']]
  );

  // 0x0c SETTLE_ALL: (address currency, uint128 maxAmount)
  const settleParams = abiCoder.encode(
    ['address', 'uint128'],
    [weth, amountInWei]
  );

  // 0x0f TAKE_ALL: (address currency, uint128 minAmount)
  const takeParams = abiCoder.encode(
    ['address', 'uint128'],
    [token, 0]
  );

  // V4_SWAP input: (bytes actions, bytes[] params)
  const v4SwapInput = abiCoder.encode(
    ['bytes', 'bytes[]'],
    ['0x060c0f', [swapParams, settleParams, takeParams]]
  );

  const deadline = Math.floor(Date.now() / 1000) + 120;

  return executeIface.encodeFunctionData('execute', [
    '0x10',        // commands: V4_SWAP
    [v4SwapInput], // inputs
    deadline,
  ]);
}

export async function executeBuy(
  privateKey: string,
  tokenAddress: string,
  ethAmount: string,
): Promise<string> {
  const amountInWei = ethers.parseEther(ethAmount);
  const calldata = encodeV4Swap(tokenAddress, amountInWei);

  // Fetch nonce from fastest RPC
  const provider = new ethers.JsonRpcProvider(BASE_RPCS[0], BASE_CHAIN_ID, {
    staticNetwork: true,
  });
  const wallet = new ethers.Wallet(privateKey, provider);
  const nonce = await wallet.getNonce();

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

  // Sign locally — private key never leaves the browser
  const signedTx = await wallet.signTransaction(tx);

  // Broadcast to all RPCs in parallel — first success wins
  const hash = await Promise.any(
    BASE_RPCS.map(async (url) => {
      const p = new ethers.JsonRpcProvider(url, BASE_CHAIN_ID, {
        staticNetwork: true,
      });
      const resp = await p.broadcastTransaction(signedTx);
      return resp.hash;
    }),
  );

  return hash;
}
