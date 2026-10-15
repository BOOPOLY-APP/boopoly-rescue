#!/usr/bin/env node
/**
 * boopoly-rescue — self-custody escape hatch for a Polymarket V2 deposit wallet.
 *
 * Guided, interactive tool for NON-technical users. Runs entirely on YOUR
 * machine, talks straight to Polygon, and pulls every asset out of your deposit
 * wallet to any address you choose. Zero dependence on BOOPOLY / polymarket.com
 * / any relayer — even if all are offline, this still works, because it calls
 * the deposit wallet contract's built-in owner escape hatch directly:
 *
 *     pause()  -> wait the contract's 1-hour anti-rug timelock -> withdraw...
 *
 * The whole flow is interactive: just answer the prompts. The script is
 * RESUMABLE — close it any time and re-run; it reads the on-chain state and
 * picks up where you left off. Inputs can also be supplied non-interactively
 * via the DEPOSIT_WALLET / PRIVATE_KEY / DEST environment variables.
 *
 * Your private key is read locally, used only to sign, and is NEVER printed,
 * saved, or sent anywhere. The tool refuses to run unless the deposit wallet's
 * owner() matches your key.
 */

import {
  createPublicClient, createWalletClient, http, fallback,
  getAddress, formatUnits, getCreate2Address, keccak256,
  encodeAbiParameters, pad, concat, toHex,
} from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import readline from "node:readline";

// ── Polygon contract addresses ──────────────────────────────────────
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PUSD   = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const USDC   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const CTF    = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045"; // ConditionalTokens (ERC1155)
// Deterministic deposit-wallet derivation (CREATE2 from the EOA) — lets the
// tool compute your deposit wallet from your private key ALONE, with nothing
// from BOOPOLY/Polymarket.
const FACTORY        = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const IMPLEMENTATION = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";
// Redemption + unwrap so users get clean USDC.e (never pUSD, never raw shares).
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"; // neg-risk market redeem
const OFFRAMP          = "0x2957922Eb93258b93368531d39fAcCA3B4dC5854"; // pUSD -> USDC.e, permissionless 1:1
const REDEEM_COLLATERALS = [PUSD, USDC_E]; // regular-CTF positionId derives from the minting collateral; try both
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
// Optional final swap so the user can take native USDC instead of USDC.e.
const SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 SwapRouter
const QUOTER      = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // Uniswap V3 QuoterV2
const SWAP_FEE    = 100; // 0.01% USDC.e/USDC pool — deepest, ~0.002% all-in for ~$80
const ERC20S = [
  { addr: USDC_E, name: "USDC.e" },
  { addr: PUSD,   name: "pUSD"   },
  { addr: USDC,   name: "USDC"   },
];
const DATA_API = "https://data-api.polymarket.com";
const RPCS = [
  process.env.RPC_URL,
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
  "https://polygon-rpc.com",
  "https://1rpc.io/matic",
].filter(Boolean);
const MIN_GAS = 50_000_000_000_000_000n; // 0.05 POL (full rescue ~8-12 txs; recommend topping to ~0.12)

// ── Minimal ABIs ────────────────────────────────────────────────────
const DW_ABI = [
  { type: "function", name: "owner",   stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused",  stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pause",   stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "withdrawERC20", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "withdrawERC1155", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint256[]" }, { type: "uint256[]" }], outputs: [] },
];
const FACTORY_ABI = [{ type: "function", name: "timelockDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals",  stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "approve",   stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer",  stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];
const ERC1155_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isApprovedForAll", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setApprovalForAll", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
];
// redeemPositions(collateral, parentCollectionId, conditionId, indexSets) — regular CTF markets
const REDEEM_ABI = [{ type: "function", name: "redeemPositions", stateMutability: "nonpayable",
  inputs: [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256[]" }], outputs: [] }];
// redeemPositions(conditionId, amounts) — neg-risk markets
const NEGRISK_ABI = [{ type: "function", name: "redeemPositions", stateMutability: "nonpayable",
  inputs: [{ type: "bytes32" }, { type: "uint256[]" }], outputs: [] }];
// unwrap(asset, to, amount) — CollateralOfframp pUSD -> USDC.e
const OFFRAMP_ABI = [{ type: "function", name: "unwrap", stateMutability: "nonpayable",
  inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] }];
// Uniswap V3 QuoterV2.quoteExactInputSingle — for the live USDC.e->USDC quote
const QUOTER_ABI = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }] }];
// Uniswap V3 SwapRouter.exactInputSingle — swap USDC.e -> USDC, output straight to recipient
const SWAP_ABI = [{ type: "function", name: "exactInputSingle", stateMutability: "payable",
  inputs: [{ type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
    { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" }, { name: "amountIn", type: "uint256" },
    { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
  outputs: [{ name: "amountOut", type: "uint256" }] }];

const transport = fallback(RPCS.map((u) => http(u)), { rank: false });
const pub = createPublicClient({ chain: polygon, transport });

// ── Deposit-wallet derivation (Solady ERC-1967 clone via CREATE2) ────
// Mirrors @polymarket/builder-relayer-client deriveDepositWallet: the deposit
// wallet address is a pure function of the owner EOA — derivable offline.
const ERC1967_CONST1 = "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 = "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;
// Beacon-proxy deposit wallets (every wallet created since ~2026-05-28). Same
// constants as @polymarket/builder-relayer-client deriveBeaconDepositWallet.
const ERC1967_BEACON_CONST1 = "0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3";
const ERC1967_BEACON_CONST2 = "0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c";
const ERC1967_BEACON_CONST3 = "0x60195155f3363d3d373d3d363d602036600436635c60da";
const ERC1967_BEACON_PREFIX = 0x6100523d8160233d3973n;
const BEACON_SELECTOR = "0x49493a4d"; // factory.beacon()
function initCodeHashERC1967(implementation, args) {
  const n = BigInt((args.length - 2) / 2);
  const combined = ERC1967_PREFIX + (n << 56n);
  return keccak256(concat([toHex(combined, { size: 10 }), implementation, "0x6009", ERC1967_CONST2, ERC1967_CONST1, args]));
}
function initCodeHashERC1967Beacon(beacon, args) {
  const n = BigInt((args.length - 2) / 2);
  const combined = ERC1967_BEACON_PREFIX + (n << 56n);
  return keccak256(concat([toHex(combined, { size: 10 }), beacon, ERC1967_BEACON_CONST3, ERC1967_BEACON_CONST2, ERC1967_BEACON_CONST1, args]));
}
const walletArgs = (owner) => encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [getAddress(FACTORY), pad(owner, { dir: "left", size: 32 })]);
// Old (UUPS) deposit wallet — wallets created before ~2026-05-28.
function deriveDepositWallet(owner) {
  const args = walletArgs(owner);
  return getCreate2Address({ from: getAddress(FACTORY), salt: keccak256(args), bytecodeHash: initCodeHashERC1967(getAddress(IMPLEMENTATION), args) });
}
// New (beacon) deposit wallet — every wallet created since.
function deriveBeaconDepositWallet(owner, beacon) {
  const args = walletArgs(owner);
  return getCreate2Address({ from: getAddress(FACTORY), salt: keccak256(args), bytecodeHash: initCodeHashERC1967Beacon(getAddress(beacon), args) });
}
// Both possible addresses for this EOA, the likely one first — the same rule
// Polymarket's own SDK uses: an old wallet already on-chain keeps its address,
// otherwise the beacon address. The caller confirms by reading owner().
async function depositWalletCandidates(owner) {
  const uups = deriveDepositWallet(owner);
  let beacon = null;
  try {
    const { data } = await pub.call({ to: getAddress(FACTORY), data: BEACON_SELECTOR });
    const b = "0x" + String(data || "").slice(-40);
    if (/^0x[0-9a-fA-F]{40}$/.test(b) && BigInt(b) !== 0n) beacon = getAddress(b);
  } catch {}
  if (!beacon) return [uups];
  const beaconAddr = deriveBeaconDepositWallet(owner, beacon);
  let uupsDeployed = false;
  try { const code = await pub.getCode({ address: uups }); uupsDeployed = !!code && code !== "0x"; } catch {}
  return uupsDeployed ? [uups, beaconAddr] : [beaconAddr, uups];
}

// ── Console / input helpers ─────────────────────────────────────────
const C = { dim: "\x1b[2m", red: "\x1b[31m", grn: "\x1b[32m", ylw: "\x1b[33m", cyn: "\x1b[36m", b: "\x1b[1m", x: "\x1b[0m" };
const line = (s = "") => console.log(s);
const fmt = (v, d = 6) => Number(formatUnits(v, d)).toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// Input closed (piped run reached EOF, or the window is closing): every later
// prompt answers "" instead of throwing on a closed readline.
let rlClosed = false;
rl.on("close", () => { rlClosed = true; });
const ask = (q) => (rlClosed ? Promise.resolve("") : new Promise((res) => rl.question(q, (a) => res(a.trim()))));

// Masked secret entry. On a real terminal (double-click) it uses raw mode so
// keystrokes show as '*' and never echo. When stdin is piped (non-TTY) it
// falls back to the shared readline so automated runs still work.
function askHidden(q) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(q);
  return new Promise((res) => {
    rl.pause();
    process.stdout.write(q);
    stdin.setRawMode(true); stdin.resume();
    let buf = "";
    const CTRL_C = "", BS1 = "", BS2 = "";
    const onData = (d) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\n" || ch === "\r") {
          stdin.setRawMode(false); stdin.removeListener("data", onData);
          process.stdout.write("\n"); rl.resume(); return res(buf.trim());
        } else if (ch === CTRL_C) { process.stdout.write("\n"); process.exit(1); }
        else if (ch === BS1 || ch === BS2) { if (buf.length) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); } }
        else if (ch >= " ") { buf += ch; process.stdout.write("*"); }
      }
    };
    stdin.on("data", onData);
  });
}

// Address input with an env-var override for non-interactive runs.
async function askAddress(envVal, promptText) {
  if (envVal) { try { return getAddress(envVal); } catch { line(`${C.red}The address in the environment variable is invalid. Please enter it manually.${C.x}`); } }
  while (true) { const a = await ask(promptText); try { return getAddress(a); } catch { line(`${C.red}   That is not a valid address. Please paste it again.${C.x}`); } }
}
// Private-key input -> viem account, with PRIVATE_KEY env override.
async function askAccount(envVal) {
  const norm = (k) => (k.startsWith("0x") ? k : "0x" + k);
  if (envVal) { const k = norm(envVal); if (/^0x[0-9a-fA-F]{64}$/.test(k)) { try { return privateKeyToAccount(k); } catch {} } line(`${C.red}PRIVATE_KEY in the environment is invalid. Please enter it manually.${C.x}`); }
  while (true) {
    const k = norm(await askHidden(`   > `));
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) { line(`${C.red}   A private key is 64 hexadecimal characters. Please enter it again.${C.x}`); continue; }
    try { return privateKeyToAccount(k); } catch { line(`${C.red}   That private key is invalid. Please enter it again.${C.x}`); }
  }
}

async function pause(msg = "\nPress Enter to continue… ") { await ask(C.dim + msg + C.x); }
function bye(code = 0) { rl.close(); process.exit(code); }
async function fatal(msg) { line(`\n${C.red}❌ ${msg}${C.x}`); await pause("\nPress Enter to close… "); bye(1); }

// ── On-chain reads ──────────────────────────────────────────────────
async function readState(dw) {
  const [factory, paused] = await Promise.all([
    pub.readContract({ address: dw, abi: DW_ABI, functionName: "factory" }),
    pub.readContract({ address: dw, abi: DW_ABI, functionName: "paused" }),
  ]);
  const delay = await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: "timelockDelay" });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const unlockAt = paused === 0n ? null : paused + delay;
  return { paused, delay, unlockAt, unlocked: paused !== 0n && now > unlockAt };
}
async function erc20Balances(dw) {
  const out = [];
  for (const t of ERC20S) {
    try {
      const [bal, dec] = await Promise.all([
        pub.readContract({ address: t.addr, abi: ERC20_ABI, functionName: "balanceOf", args: [dw] }),
        pub.readContract({ address: t.addr, abi: ERC20_ABI, functionName: "decimals" }),
      ]);
      if (bal > 0n) out.push({ ...t, bal, dec });
    } catch {}
  }
  return out;
}
async function ctfPositions(dw) {
  let rows = [];
  try {
    const r = await fetch(`${DATA_API}/positions?user=${dw}&sizeThreshold=0.000001&limit=200`);
    rows = await r.json(); if (!Array.isArray(rows)) rows = rows.positions ?? [];
  } catch {}
  const out = [];
  for (const p of rows) {
    if (!p.asset) continue;
    try {
      const bal = await pub.readContract({ address: CTF, abi: ERC1155_ABI, functionName: "balanceOf", args: [dw, BigInt(p.asset)] });
      if (bal > 0n) out.push({
        id: BigInt(p.asset), bal, title: p.title || "", outcome: p.outcome || "",
        value: Number(p.currentValue ?? 0), redeemable: !!p.redeemable,
        conditionId: p.conditionId, outcomeIndex: Number(p.outcomeIndex ?? 0), negativeRisk: !!p.negativeRisk,
      });
    } catch {}
  }
  return out;
}

// ── Rescue phases (all run from your EOA — no relayer, no site) ──────
async function sendTx(wallet, params, label) {
  line(`   ${label}…`);
  const hash = await wallet.writeContract(params);
  line(`     ${C.dim}https://polygonscan.com/tx/${hash}${C.x}`);
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
// Split positions: resolved winners / open-with-value (unresolved) / worthless.
function categorize(positions) {
  const winners = [], unresolved = [], worthless = [];
  for (const p of positions) {
    if (p.redeemable && p.value >= 0.01) winners.push(p);
    else if (!p.redeemable && p.value >= 0.01) unresolved.push(p);
    else worthless.push(p);
  }
  return { winners, unresolved, worthless };
}
// Phase 2: redeem resolved winners held by the EOA -> pUSD/USDC.e to the EOA.
async function redeemWinners(wallet, eoa, winners) {
  const negRisk = winners.filter((w) => w.negativeRisk);
  const regular = winners.filter((w) => !w.negativeRisk);
  if (negRisk.length) {
    const approved = await pub.readContract({ address: CTF, abi: ERC1155_ABI, functionName: "isApprovedForAll", args: [eoa, getAddress(NEG_RISK_ADAPTER)] });
    if (!approved) await sendTx(wallet, { address: CTF, abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [getAddress(NEG_RISK_ADAPTER), true] }, "Approve NegRiskAdapter");
    for (const w of negRisk) {
      const amounts = new Array(Math.max(w.outcomeIndex + 1, 2)).fill(0n);
      amounts[w.outcomeIndex] = w.bal;
      await sendTx(wallet, { address: getAddress(NEG_RISK_ADAPTER), abi: NEGRISK_ABI, functionName: "redeemPositions", args: [w.conditionId, amounts] }, `Redeem (neg-risk) ${w.title.slice(0, 30)}`)
        .catch((e) => line(`     ${C.dim}(skipped: ${(e?.shortMessage || e?.message || "").slice(0, 60)})${C.x}`));
    }
  }
  const seen = new Set();
  for (const w of regular) {
    if (!w.conditionId || seen.has(w.conditionId)) continue;
    seen.add(w.conditionId);
    for (const col of REDEEM_COLLATERALS) {
      await sendTx(wallet, { address: CTF, abi: REDEEM_ABI, functionName: "redeemPositions", args: [getAddress(col), ZERO32, w.conditionId, [1n, 2n]] }, `Redeem ${w.title.slice(0, 30)} (${col === PUSD ? "pUSD" : "USDC.e"})`)
        .catch((e) => line(`     ${C.dim}(skipped: ${(e?.shortMessage || e?.message || "").slice(0, 60)})${C.x}`));
    }
  }
}
// Phase 3: unwrap all pUSD on the EOA -> USDC.e (permissionless, 1:1).
async function unwrapPusd(wallet, eoa) {
  const bal = await pub.readContract({ address: PUSD, abi: ERC20_ABI, functionName: "balanceOf", args: [eoa] });
  if (bal <= 0n) return 0n;
  await sendTx(wallet, { address: PUSD, abi: ERC20_ABI, functionName: "approve", args: [getAddress(OFFRAMP), bal] }, "Approve the Offramp to spend pUSD");
  await sendTx(wallet, { address: getAddress(OFFRAMP), abi: OFFRAMP_ABI, functionName: "unwrap", args: [getAddress(USDC_E), eoa, bal] }, `unwrap pUSD ${fmt(bal)} -> USDC.e`);
  return bal;
}
// Live USDC.e -> USDC quote via Uniswap V3 QuoterV2 (null if it can't quote).
async function quoteUsdceToUsdc(amountIn) {
  try {
    const r = await pub.simulateContract({ address: getAddress(QUOTER), abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
      args: [{ tokenIn: getAddress(USDC_E), tokenOut: getAddress(USDC), amountIn, fee: SWAP_FEE, sqrtPriceLimitX96: 0n }] });
    return r.result[0];
  } catch { return null; }
}
// Ask upfront which token to receive: USDC.e (no slippage) or native USDC
// (DEX swap). estRaw is an estimate of the total USDC.e, used only for the
// live slippage preview. Returns "usdce" | "usdc".
async function askPayoutToken(estRaw) {
  line(`\n${C.b}③ Which token do you want to receive?${C.x}`);
  line(`  ${C.grn}1) USDC.e${C.x}     ${C.dim}no slippage, no fee — sent as is${C.x}`);
  let slipPct = null, slipTxt = "a tiny slippage";
  if (estRaw > 0n) {
    const q = await quoteUsdceToUsdc(estRaw);
    if (q !== null) {
      slipPct = Math.max(0, (Number(formatUnits(estRaw - q, 6)) / Number(formatUnits(estRaw, 6))) * 100);
      slipTxt = `about ${slipPct.toFixed(3)}% slippage + fee`;
    }
  }
  line(`  ${C.grn}2) USDC (native)${C.x}  ${C.dim}swapped on a DEX, ${slipTxt} (accepted by more exchanges and wallets)${C.x}`);
  const pick = (await ask(`Type 1 or 2 (Enter = 1, USDC.e): `)).trim();
  return { token: pick === "2" ? "usdc" : "usdce", slipPct };
}
// Phase 4: send the EOA's USDC.e to DEST as the chosen token (swap if "usdc"),
// plus any native USDC already on the EOA.
async function deliver(wallet, eoa, dest, payoutToken) {
  const usdceBal = await pub.readContract({ address: USDC_E, abi: ERC20_ABI, functionName: "balanceOf", args: [eoa] });
  if (usdceBal > 0n) {
    const quoted = payoutToken === "usdc" ? await quoteUsdceToUsdc(usdceBal) : null;
    if (payoutToken === "usdc" && quoted !== null) {
      const minOut = (quoted * 995n) / 1000n; // 0.5% tolerance
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      await sendTx(wallet, { address: USDC_E, abi: ERC20_ABI, functionName: "approve", args: [getAddress(SWAP_ROUTER), usdceBal] }, "Approve the DEX to spend USDC.e");
      await sendTx(wallet, { address: getAddress(SWAP_ROUTER), abi: SWAP_ABI, functionName: "exactInputSingle",
        args: [{ tokenIn: getAddress(USDC_E), tokenOut: getAddress(USDC), fee: SWAP_FEE, recipient: dest, deadline, amountIn: usdceBal, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] },
        `Swap USDC.e ${fmt(usdceBal)} -> USDC and send to ${dest.slice(0, 8)}…`);
    } else {
      if (payoutToken === "usdc") line(`   ${C.ylw}The DEX can't swap right now — sending USDC.e instead.${C.x}`);
      await sendTx(wallet, { address: USDC_E, abi: ERC20_ABI, functionName: "transfer", args: [dest, usdceBal] }, `Send USDC.e ${fmt(usdceBal)} -> ${dest.slice(0, 8)}…`);
    }
  }
  // Any native USDC already on the EOA goes out too
  const usdcBal = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [eoa] });
  if (usdcBal > 0n) await sendTx(wallet, { address: USDC, abi: ERC20_ABI, functionName: "transfer", args: [dest, usdcBal] }, `Send USDC ${fmt(usdcBal)} -> ${dest.slice(0, 8)}…`);
}
// After rescue: keep using the site (unpause -> normal) or stay paused.
async function offerUnpause(wallet, dw) {
  line(`\n${C.b}Will you keep using the BOOPOLY website?${C.x}`);
  line(`${C.dim}  • Yes → un-pause the wallet so the website can operate it again`);
  line(`  • No  → leave it paused; run this tool again any time to un-pause${C.x}`);
  const keepUsing = await ask(`Type ${C.b}YES${C.x} to un-pause and keep using the site, or press Enter to stay paused: `);
  if (keepUsing.toUpperCase() === "YES") {
    await sendTx(wallet, { address: dw, abi: DW_ABI, functionName: "unpause" }, "Un-pause the wallet (unpause)");
    line(`${C.grn}✅ The wallet is back to normal — you can keep using BOOPOLY.${C.x}`);
  } else {
    line(`${C.dim}The wallet stays paused. To use the website again later, run this tool and un-pause.${C.x}`);
  }
}

// Shares an earlier rescue moved to the EOA before their market settled: once
// settled they redeem straight from the EOA — no pause, no timelock.
async function rescueEoaWinners(wallet, eoa, winners) {
  line(`\n${C.grn}🏆 Your EOA holds ${winners.length} settled winning position(s) — they can be redeemed now.${C.x}`);
  const est = winners.reduce((s, w) => s + w.bal, 0n);
  const { token: payoutToken } = await askPayoutToken(est);
  const payoutName = payoutToken === "usdc" ? "USDC" : "USDC.e";
  line(`\n${C.b}Payout address${C.x} (your own wallet, e.g. MetaMask):`);
  const dest = await askAddress(process.env.DEST, `   > `);
  for (const w of winners) line(`   ${C.grn}🏆 $${w.value.toFixed(2)}${C.x} ${w.title.slice(0, 40)}`);
  const conf = await ask(`\nType ${C.b}RESCUE${C.x} to redeem and send ${payoutName} to ${dest}, or q to cancel: `);
  if (conf !== "RESCUE") { line(`${C.dim}Cancelled — no funds were moved.${C.x}`); return; }
  await redeemWinners(wallet, eoa, winners);
  await unwrapPusd(wallet, eoa);
  await deliver(wallet, eoa, dest, payoutToken);
  line(`\n${C.grn}${C.b}🎉 Done! Funds sent to ${dest}${C.x}`);
}

// ── Flow ────────────────────────────────────────────────────────────
async function main() {
  line(`${C.b}${C.cyn}╔══════════════════════════════════════════════╗`);
  line(`║             BOOPOLY Rescue Tool              ║`);
  line(`╚══════════════════════════════════════════════╝${C.x}`);
  line(`${C.dim}This tool runs on your own computer and talks straight to Polygon. It`);
  line(`moves everything in your deposit wallet to an address you choose — no BOOPOLY, Polymarket or any server needed.`);
  line(`Your private key is only used on this machine to sign. It is never shown, saved or sent.${C.x}\n`);

  // ① The private key — the only required input; everything else is derived from it.
  line(`${C.b}① Your private key${C.x} (the one exported from Privy; typed as *, never recorded)`);
  const account = await askAccount(process.env.PRIVATE_KEY);
  const wallet = createWalletClient({ account, chain: polygon, transport });

  // The deposit wallet is a CREATE2 function of the key's address (both wallet types are tried) — nothing comes from a website.
  line(`\n${C.dim}Your wallet address (EOA): ${account.address}${C.x}`);
  line(`${C.dim}Finding and verifying your deposit wallet…${C.x}`);
  let candidates = await depositWalletCandidates(account.address);
  if (process.env.DEPOSIT_WALLET) { try { candidates = [getAddress(process.env.DEPOSIT_WALLET)]; } catch {} } // advanced override (rarely needed)
  let dw = null, wrongOwner = null;
  for (const c of candidates) {
    let owner;
    try { owner = await pub.readContract({ address: c, abi: DW_ABI, functionName: "owner" }); } catch { continue; }
    if (getAddress(owner) === getAddress(account.address)) { dw = c; break; }
    wrongOwner = { c, owner };
  }
  if (!dw && wrongOwner) {
    return fatal(`The wallet's on-chain owner does not match your key (unexpected).\n   Wallet: ${wrongOwner.c}\n   Owner: ${wrongOwner.owner}\n   Your key's address: ${account.address}\n   Stopped — no funds were moved.`);
  }
  if (!dw) {
    return fatal(`Couldn't read your deposit wallet: it may not exist on-chain yet (sign-up never finished on the website), or the network is unreachable.\n   Derived address: ${candidates.join(" / ")}\n   Check the private key and try again later. No funds were moved.`);
  }
  line(`${C.b}Your deposit wallet: ${dw}${C.x}`);
  line(`${C.grn}✅ Verified: this key owns this wallet${C.x}`);
  const eoa = getAddress(account.address);

  // State loop (re-runnable; resumes where it left off)
  while (true) {
    line(`\n${C.dim}Reading on-chain state…${C.x}`);
    const [{ paused, delay, unlockAt, unlocked }, pol, erc20, ctf, eoaCtf] = await Promise.all([
      readState(dw), pub.getBalance({ address: account.address }), erc20Balances(dw), ctfPositions(dw), ctfPositions(eoa),
    ]);
    // Shares an earlier run left on the EOA before settlement redeem straight from the EOA (no pause, no wait).
    const eoaWinners = categorize(eoaCtf).winners;

    line(`\n${C.b}── Your assets (in ${dw.slice(0, 8)}…${dw.slice(-4)}) ──${C.x}`);
    if (!erc20.length && !ctf.length) line(`   (empty)`);
    for (const t of erc20) line(`   Cash     ${t.name.padEnd(6)} ${C.grn}${fmt(t.bal, t.dec)}${C.x}`);
    for (const p of ctf) line(`   Position ${p.redeemable ? C.grn + "redeemable" : C.dim + "unsettled"}${C.x} $${Number(p.value).toFixed(2)}  ${p.outcome} · ${p.title.slice(0, 40)}`);
    if (eoaCtf.length) {
      line(`\n${C.b}── Positions an earlier run left on your EOA ──${C.x}`);
      for (const p of eoaCtf) line(`   Position ${p.redeemable ? C.grn + "redeemable" : C.dim + "unsettled"}${C.x} $${Number(p.value).toFixed(2)}  ${p.outcome} · ${p.title.slice(0, 40)}`);
    }

    const gasLow = pol < MIN_GAS;
    line(`\n   ⛽ Gas (POL on your EOA): ${formatUnits(pol, 18)} ${gasLow ? C.ylw + "← low, top up to ~0.12 POL" + C.x : ""}`);

    if (gasLow) {
      line(`\n${C.ylw}First send about 0.12 POL to this address for network fees:${C.x}\n   ${C.b}${account.address}${C.x}`);
      const a = await ask(`\nPress Enter to re-check once it arrives, or q to quit: `);
      if (a.toLowerCase() === "q") return bye(0);
      continue;
    }

    // Deposit wallet empty but settled winners on the EOA → redeem and send them (no pause needed).
    if (!erc20.length && !ctf.length && eoaWinners.length) {
      await rescueEoaWinners(wallet, eoa, eoaWinners);
      await pause("\nPress Enter to close… ");
      return bye(0);
    }

    if (paused === 0n) {
      line(`\n${C.b}Next: start the withdrawal — this sends pause() and starts a ${(Number(delay) / 3600).toFixed(1)}-hour safety countdown${C.x}`);
      const a = await ask(`Type ${C.b}YES${C.x} to send pause(), or q to quit: `);
      if (a.toLowerCase() === "q") return bye(0);
      if (a !== "YES") { line(`${C.dim}Not confirmed — skipped.${C.x}`); continue; }
      line(`${C.dim}Sending pause()…${C.x}`);
      const hash = await wallet.writeContract({ address: dw, abi: DW_ABI, functionName: "pause" });
      line(`   Transaction: https://polygonscan.com/tx/${hash}`);
      await pub.waitForTransactionReceipt({ hash });
      line(`${C.grn}✅ Paused. Run this tool again in ${(Number(delay) / 3600).toFixed(1)} hour(s) to withdraw (you can close it now).${C.x}`);
      const a2 = await ask(`\nWait here? Type wait to wait out the countdown, or press Enter to quit and come back later: `);
      if (a2.toLowerCase() !== "wait") return bye(0);
      continue;
    }

    if (!unlocked) {
      const mins = Math.max(0, Math.ceil(Number(unlockAt - BigInt(Math.floor(Date.now() / 1000))) / 60));
      line(`\n${C.ylw}🔒 Paused — withdrawal unlocks in about ${mins} minute(s) (${new Date(Number(unlockAt) * 1000).toLocaleString()}).${C.x}`);
      const a = await ask(`Type wait to wait and continue automatically, or press Enter to quit and come back later: `);
      if (a.toLowerCase() !== "wait") return bye(0);
      while (BigInt(Math.floor(Date.now() / 1000)) <= unlockAt) {
        const l = Math.max(0, Math.ceil(Number(unlockAt - BigInt(Math.floor(Date.now() / 1000))) / 60));
        process.stdout.write(`\r   ${C.dim}Countdown… about ${l} minute(s)${C.x}    `);
        await sleep(30_000);
      }
      line(`\n${C.grn}✅ The timelock has passed — you can withdraw now.${C.x}`);
      continue;
    }

    // Unlocked → rescue (everything runs from your EOA; clean USDC.e/USDC ends up at your address)
    line(`\n${C.grn}🔓 The timelock has passed.${C.x}`);
    const { winners: dwWinners, unresolved, worthless } = categorize(ctf);
    const winners = [...dwWinners, ...eoaWinners]; // settled leftovers on the EOA are redeemed too

    // Deposit wallet empty (an earlier run already withdrew) → only offer to un-pause.
    if (erc20.length === 0 && dwWinners.length === 0 && unresolved.length === 0) {
      line(`${C.dim}There is nothing left to withdraw in the deposit wallet.${C.x}`);
      await offerUnpause(wallet, dw);
      await pause("\nPress Enter to close… ");
      return bye(0);
    }

    // ③ Choose the payout token (USDC.e / USDC)
    const estRaw = erc20.reduce((s, t) => s + t.bal, 0n) + winners.reduce((s, w) => s + w.bal, 0n);
    const { token: payoutToken, slipPct } = await askPayoutToken(estRaw);
    const isUsdc = payoutToken === "usdc";
    const payoutName = isUsdc ? "USDC" : "USDC.e";

    // ④ Show the chosen token's contract + ask for the payout address
    line(`\n${C.b}Check the ${isUsdc ? "USDC (Polygon)" : "USDC.e"} contract address so the funds arrive where you expect:${C.x}`);
    line(`${C.dim}  ${isUsdc ? USDC : USDC_E}${C.x}`);
    const destHint = isUsdc
      ? `swapped on a DEX, about ${slipPct !== null ? slipPct.toFixed(3) + "%" : "a tiny"} slippage + fee`
      : `use your own wallet, e.g. MetaMask; an exchange address may not accept USDC.e`;
    line(`\n${C.b}④ Payout address${C.x} (${destHint}):`);
    const dest = await askAddress(process.env.DEST, `   > `);

    line(`\n${C.b}Plan:${C.x}`);
    for (const t of erc20) line(`   Cash ${t.name} ${fmt(t.bal, t.dec)}${t.name === "pUSD" ? " → converted to USDC.e" : ""}`);
    for (const w of winners) line(`   ${C.grn}🏆 Won $${w.value.toFixed(2)}${C.x} ${w.title.slice(0, 38)} → redeemed to USDC.e`);
    for (const u of unresolved) line(`   ${C.ylw}⏳ Unsettled $${u.value.toFixed(2)}${C.x} ${u.title.slice(0, 38)} → can't be redeemed until the market settles`);
    if (worthless.length) line(`   ${C.dim}(ignoring ${worthless.length} worthless $0 position(s))${C.x}`);
    line(`   ${C.b}→ everything as ${payoutName} to: ${dest}${C.x}`);

    const conf = await ask(`\nType ${C.b}RESCUE${C.x} to start (about 8–12 transactions, keep ~0.12 POL), or q to cancel: `);
    if (conf !== "RESCUE") { line(`${C.dim}Cancelled — no funds were moved.${C.x}`); return bye(0); }

    // [1/4] Escape-hatch withdrawal — deposit wallet → your EOA
    line(`\n${C.b}[1/4] Withdraw from the deposit wallet → your EOA${C.x}`);
    for (const t of erc20) await sendTx(wallet, { address: dw, abi: DW_ABI, functionName: "withdrawERC20", args: [getAddress(t.addr), eoa, t.bal] }, `Withdraw ${t.name} ${fmt(t.bal, t.dec)}`);
    const moveShares = [...dwWinners, ...unresolved];
    if (moveShares.length) await sendTx(wallet, { address: dw, abi: DW_ABI, functionName: "withdrawERC1155", args: [getAddress(CTF), eoa, moveShares.map((p) => p.id), moveShares.map((p) => p.bal)] }, `Withdraw ${moveShares.length} position(s)`);

    // [2/4] Redeem winning positions → pUSD/USDC.e
    line(`\n${C.b}[2/4] Redeem winning positions${C.x}`);
    if (winners.length) await redeemWinners(wallet, eoa, winners); else line(`   (none)`);

    // [3/4] pUSD → USDC.e
    line(`\n${C.b}[3/4] Convert pUSD to USDC.e${C.x}`);
    if ((await unwrapPusd(wallet, eoa)) === 0n) line(`   (no pUSD)`);

    // [4/4] Send the chosen token to the payout address
    line(`\n${C.b}[4/4] Send ${payoutName} to the payout address${C.x}`);
    await deliver(wallet, eoa, dest, payoutToken);

    line(`\n${C.grn}${C.b}🎉 Done! Funds sent to ${dest}${C.x}`);
    if (unresolved.length) {
      line(`${C.ylw}⏳ ${unresolved.length} position(s) can't be redeemed until their market settles (the shares stay on your EOA ${eoa}). Run this tool again after settlement:${C.x}`);
      for (const u of unresolved) line(`   ${C.dim}· ${u.title.slice(0, 46)}${C.x}`);
    }

    // After the rescue: un-pause to keep using the site, or stay paused.
    await offerUnpause(wallet, dw);

    await pause("\nPress Enter to close… ");
    return bye(0);
  }
}

main().catch(async (e) => { await fatal(e?.shortMessage || e?.message || String(e)); });
