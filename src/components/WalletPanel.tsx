"use client";

import { useState, useEffect, useRef } from "react";
import { ethers } from "ethers";
import { storeKey, clearKey, setBuyAmount as saveBuyAmount } from "@/lib/wallet";

interface WalletPanelProps {
  walletKey: string | null;
  buyAmount: string;
  onWalletChange: (key: string | null) => void;
  onBuyAmountChange: (amt: string) => void;
}

export function WalletPanel({ walletKey, buyAmount, onWalletChange, onBuyAmountChange }: WalletPanelProps) {
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [amtInput, setAmtInput] = useState(buyAmount);
  const ref = useRef<HTMLDivElement>(null);

  const address = walletKey ? (() => { try { return new ethers.Wallet(walletKey).address; } catch { return null; } })() : null;

  // Fetch balance when panel opens
  useEffect(() => {
    if (!open || !address) return;
    const provider = new ethers.JsonRpcProvider("https://mainnet.base.org", 8453, { staticNetwork: true });
    provider.getBalance(address).then((bal) => {
      setBalance(ethers.formatEther(bal));
    }).catch(() => setBalance(null));
  }, [open, address]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleImport = () => {
    const key = keyInput.trim();
    if (!key) return;
    try {
      new ethers.Wallet(key); // validate
      storeKey(key);
      onWalletChange(key);
      setKeyInput("");
    } catch {
      alert("Invalid private key");
    }
  };

  const handleClear = () => {
    clearKey();
    onWalletChange(null);
    setBalance(null);
  };

  const handleAmountSave = () => {
    const amt = parseFloat(amtInput);
    if (isNaN(amt) || amt <= 0) return;
    saveBuyAmount(amtInput);
    onBuyAmountChange(amtInput);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`px-3 py-1 font-mono text-sm border ${
          walletKey
            ? "border-[#00ff88] text-[#00ff88]"
            : "border-yellow-500 text-yellow-500"
        }`}
      >
        {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "WALLET"}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-[#161b22] border border-[#30363d] rounded shadow-lg z-50 p-4">
          {walletKey && address ? (
            <>
              <div className="mb-3">
                <div className="text-[10px] text-gray-500 font-mono">ADDRESS</div>
                <div className="text-sm text-[#00d9ff] font-mono break-all">{address}</div>
              </div>
              <div className="mb-3">
                <div className="text-[10px] text-gray-500 font-mono">BALANCE</div>
                <div className="text-sm text-[#00ff88] font-mono">
                  {balance !== null ? `${parseFloat(balance).toFixed(5)} ETH` : "Loading..."}
                </div>
              </div>
              <div className="mb-3">
                <div className="text-[10px] text-gray-500 font-mono mb-1">BUY AMOUNT (ETH)</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={amtInput}
                    onChange={(e) => setAmtInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAmountSave()}
                    className="flex-1 px-2 py-1 bg-[#0d1117] border border-[#30363d] text-white font-mono text-sm rounded focus:outline-none focus:border-[#00d9ff]"
                  />
                  <button
                    onClick={handleAmountSave}
                    className="px-3 py-1 text-xs font-mono border border-[#00d9ff]/50 text-[#00d9ff] hover:bg-[#00d9ff]/10 rounded"
                  >
                    SET
                  </button>
                </div>
              </div>
              <button
                onClick={handleClear}
                className="w-full py-1.5 text-xs font-mono border border-red-500/50 text-red-400 hover:bg-red-500/10 rounded"
              >
                DISCONNECT
              </button>
            </>
          ) : (
            <>
              <div className="mb-3">
                <div className="text-[10px] text-gray-500 font-mono mb-1">IMPORT PRIVATE KEY</div>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleImport()}
                  placeholder="Paste private key..."
                  className="w-full px-2 py-1.5 bg-[#0d1117] border border-[#30363d] text-white font-mono text-sm rounded focus:outline-none focus:border-[#00d9ff]"
                />
              </div>
              <button
                onClick={handleImport}
                className="w-full py-1.5 text-xs font-mono border border-[#00ff88]/50 text-[#00ff88] hover:bg-[#00ff88]/10 rounded mb-3"
              >
                CONNECT
              </button>
              <div className="text-[10px] text-gray-500 font-mono leading-relaxed">
                Key stays in your browser only. Never sent to any server.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
