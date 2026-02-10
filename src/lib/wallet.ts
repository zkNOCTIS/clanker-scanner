const PK_KEY = 'clanker_pk';
const BUY_AMT_KEY = 'clanker_buy_eth';
const DEFAULT_BUY_AMOUNT = '0.005';

export function getStoredKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(PK_KEY);
}

export function storeKey(key: string): void {
  localStorage.setItem(PK_KEY, key);
}

export function clearKey(): void {
  localStorage.removeItem(PK_KEY);
}

export function getBuyAmount(): string {
  if (typeof window === 'undefined') return DEFAULT_BUY_AMOUNT;
  return localStorage.getItem(BUY_AMT_KEY) || DEFAULT_BUY_AMOUNT;
}

export function setBuyAmount(amt: string): void {
  localStorage.setItem(BUY_AMT_KEY, amt);
}
