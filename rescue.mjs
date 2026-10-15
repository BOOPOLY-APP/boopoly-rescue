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
  if (envVal) { try { return getAddress(envVal); } catch { line(`${C.red}环境变量地址格式不对,改用手动输入。${C.x}`); } }
  while (true) { const a = await ask(promptText); try { return getAddress(a); } catch { line(`${C.red}   地址格式不对,请重贴。${C.x}`); } }
}
// Private-key input -> viem account, with PRIVATE_KEY env override.
async function askAccount(envVal) {
  const norm = (k) => (k.startsWith("0x") ? k : "0x" + k);
  if (envVal) { const k = norm(envVal); if (/^0x[0-9a-fA-F]{64}$/.test(k)) { try { return privateKeyToAccount(k); } catch {} } line(`${C.red}环境变量 PRIVATE_KEY 无效,改用手动输入。${C.x}`); }
  while (true) {
    const k = norm(await askHidden(`   > `));
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) { line(`${C.red}   私钥应为 64 位十六进制,请重输。${C.x}`); continue; }
    try { return privateKeyToAccount(k); } catch { line(`${C.red}   私钥无效,请重输。${C.x}`); }
  }
}

async function pause(msg = "\n按 Enter 继续… ") { await ask(C.dim + msg + C.x); }
function bye(code = 0) { rl.close(); process.exit(code); }
async function fatal(msg) { line(`\n${C.red}❌ ${msg}${C.x}`); await pause("\n按 Enter 关闭… "); bye(1); }

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
    if (!approved) await sendTx(wallet, { address: CTF, abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [getAddress(NEG_RISK_ADAPTER), true] }, "授权 NegRiskAdapter");
    for (const w of negRisk) {
      const amounts = new Array(Math.max(w.outcomeIndex + 1, 2)).fill(0n);
      amounts[w.outcomeIndex] = w.bal;
      await sendTx(wallet, { address: getAddress(NEG_RISK_ADAPTER), abi: NEGRISK_ABI, functionName: "redeemPositions", args: [w.conditionId, amounts] }, `赎回(neg-risk) ${w.title.slice(0, 30)}`)
        .catch((e) => line(`     ${C.dim}(跳过: ${(e?.shortMessage || e?.message || "").slice(0, 60)})${C.x}`));
    }
  }
  const seen = new Set();
  for (const w of regular) {
    if (!w.conditionId || seen.has(w.conditionId)) continue;
    seen.add(w.conditionId);
    for (const col of REDEEM_COLLATERALS) {
      await sendTx(wallet, { address: CTF, abi: REDEEM_ABI, functionName: "redeemPositions", args: [getAddress(col), ZERO32, w.conditionId, [1n, 2n]] }, `赎回 ${w.title.slice(0, 30)} (${col === PUSD ? "pUSD" : "USDC.e"})`)
        .catch((e) => line(`     ${C.dim}(跳过: ${(e?.shortMessage || e?.message || "").slice(0, 60)})${C.x}`));
    }
  }
}
// Phase 3: unwrap all pUSD on the EOA -> USDC.e (permissionless, 1:1).
async function unwrapPusd(wallet, eoa) {
  const bal = await pub.readContract({ address: PUSD, abi: ERC20_ABI, functionName: "balanceOf", args: [eoa] });
  if (bal <= 0n) return 0n;
  await sendTx(wallet, { address: PUSD, abi: ERC20_ABI, functionName: "approve", args: [getAddress(OFFRAMP), bal] }, "授权 Offramp 花费 pUSD");
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
  line(`\n${C.b}③ 你要最终收到哪种币?${C.x}`);
  line(`  ${C.grn}1) USDC.e${C.x}     ${C.dim}无滑点、无手续费,直接到账${C.x}`);
  let slipPct = null, slipTxt = "有微小滑点";
  if (estRaw > 0n) {
    const q = await quoteUsdceToUsdc(estRaw);
    if (q !== null) {
      slipPct = Math.max(0, (Number(formatUnits(estRaw - q, 6)) / Number(formatUnits(estRaw, 6))) * 100);
      slipTxt = `滑点+手续费约 ${slipPct.toFixed(3)}%`;
    }
  }
  line(`  ${C.grn}2) USDC(原生)${C.x}  ${C.dim}经 DEX 兑换,${slipTxt}(交易所/钱包兼容性更广)${C.x}`);
  const pick = (await ask(`输入 1 或 2(直接按 Enter = 1 USDC.e）： `)).trim();
  return { token: pick === "2" ? "usdc" : "usdce", slipPct };
}
// Phase 4: send the EOA's USDC.e to DEST as the chosen token (swap if "usdc"),
// plus any native USDC already on the EOA.
async function deliver(wallet, eoa, dest, payoutToken) {
  const usdceBal = await pub.readContract({ address: USDC_E, abi: ERC20_ABI, functionName: "balanceOf", args: [eoa] });
  if (usdceBal > 0n) {
    const quoted = payoutToken === "usdc" ? await quoteUsdceToUsdc(usdceBal) : null;
    if (payoutToken === "usdc" && quoted !== null) {
      const minOut = (quoted * 995n) / 1000n; // 0.5% 容差
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      await sendTx(wallet, { address: USDC_E, abi: ERC20_ABI, functionName: "approve", args: [getAddress(SWAP_ROUTER), usdceBal] }, "授权 DEX 花费 USDC.e");
      await sendTx(wallet, { address: getAddress(SWAP_ROUTER), abi: SWAP_ABI, functionName: "exactInputSingle",
        args: [{ tokenIn: getAddress(USDC_E), tokenOut: getAddress(USDC), fee: SWAP_FEE, recipient: dest, deadline, amountIn: usdceBal, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] },
        `兑换 USDC.e ${fmt(usdceBal)} -> USDC 并转到 ${dest.slice(0, 8)}…`);
    } else {
      if (payoutToken === "usdc") line(`   ${C.ylw}DEX 暂时无法兑换,改为直接转 USDC.e。${C.x}`);
      await sendTx(wallet, { address: USDC_E, abi: ERC20_ABI, functionName: "transfer", args: [dest, usdceBal] }, `转出 USDC.e ${fmt(usdceBal)} -> ${dest.slice(0, 8)}…`);
    }
  }
  // 钱包里若本来就有原生 USDC,一并转出
  const usdcBal = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [eoa] });
  if (usdcBal > 0n) await sendTx(wallet, { address: USDC, abi: ERC20_ABI, functionName: "transfer", args: [dest, usdcBal] }, `转出 USDC ${fmt(usdcBal)} -> ${dest.slice(0, 8)}…`);
}
// After rescue: keep using the site (unpause -> normal) or stay paused.
async function offerUnpause(wallet, dw) {
  line(`\n${C.b}是否还要继续使用 BOOPOLY 网站?${C.x}`);
  line(`${C.dim}  • 要继续用  → 把钱包恢复正常状态(unpause),网站才能再正常操作它`);
  line(`  • 不再使用  → 保持当前(暂停)状态即可,之后想用再跑本工具 unpause${C.x}`);
  const keepUsing = await ask(`输入 ${C.b}YES${C.x} 继续使用网站（解除暂停），或按 Enter 保持暂停： `);
  if (keepUsing.toUpperCase() === "YES") {
    await sendTx(wallet, { address: dw, abi: DW_ABI, functionName: "unpause" }, "解除暂停(unpause),恢复网站正常使用");
    line(`${C.grn}✅ 钱包已恢复正常,可继续使用 BOOPOLY 网站。${C.x}`);
  } else {
    line(`${C.dim}钱包保持暂停状态。之后想继续使用网站,重跑本工具按提示解除暂停即可。${C.x}`);
  }
}

// Shares an earlier rescue moved to the EOA before their market settled: once
// settled they redeem straight from the EOA — no pause, no timelock.
async function rescueEoaWinners(wallet, eoa, winners) {
  line(`\n${C.grn}🏆 你 EOA 上有 ${winners.length} 笔已结算的赢单,可以直接赎回。${C.x}`);
  const est = winners.reduce((s, w) => s + w.bal, 0n);
  const { token: payoutToken } = await askPayoutToken(est);
  const payoutName = payoutToken === "usdc" ? "USDC" : "USDC.e";
  line(`\n${C.b}收款地址${C.x}（建议填你自己的钱包,如 MetaMask）：`);
  const dest = await askAddress(process.env.DEST, `   > `);
  for (const w of winners) line(`   ${C.grn}🏆 $${w.value.toFixed(2)}${C.x} ${w.title.slice(0, 40)}`);
  const conf = await ask(`\n输入 ${C.b}RESCUE${C.x} 确认赎回并转出 ${payoutName} 到 ${dest}，或 q 取消： `);
  if (conf !== "RESCUE") { line(`${C.dim}已取消,未动任何资金。${C.x}`); return; }
  await redeemWinners(wallet, eoa, winners);
  await unwrapPusd(wallet, eoa);
  await deliver(wallet, eoa, dest, payoutToken);
  line(`\n${C.grn}${C.b}🎉 完成!资金已转到 ${dest}${C.x}`);
}

// ── Flow ────────────────────────────────────────────────────────────
async function main() {
  line(`${C.b}${C.cyn}╔══════════════════════════════════════════════╗`);
  line(`║          BOOPOLY 资金救援工具 (rescue)         ║`);
  line(`╚══════════════════════════════════════════════╝${C.x}`);
  line(`${C.dim}本工具在你自己的电脑上运行,直连 Polygon 区块链,把你 deposit`);
  line(`钱包里的资金提到你指定的地址。不依赖 BOOPOLY / Polymarket / 任何服务器。`);
  line(`你的私钥只在本机用于签名,绝不显示、保存或上传。${C.x}\n`);

  // ① 私钥 —— 唯一必需的输入。其余全部由它推导,完全不需要网站提供任何东西。
  line(`${C.b}① 你的私钥${C.x}（从 Privy 导出的那把；输入时以 * 显示,不会被记录）`);
  const account = await askAccount(process.env.PRIVATE_KEY);
  const wallet = createWalletClient({ account, chain: polygon, transport });

  // deposit 钱包地址 = 由私钥地址 CREATE2 确定性推导(新旧两种钱包都会试),不需要网站提供任何东西。
  line(`\n${C.dim}你的钱包地址 (EOA): ${account.address}${C.x}`);
  line(`${C.dim}推导并核对你的 deposit 钱包…${C.x}`);
  let candidates = await depositWalletCandidates(account.address);
  if (process.env.DEPOSIT_WALLET) { try { candidates = [getAddress(process.env.DEPOSIT_WALLET)]; } catch {} } // 高级覆盖（一般用不到）
  let dw = null, wrongOwner = null;
  for (const c of candidates) {
    let owner;
    try { owner = await pub.readContract({ address: c, abi: DW_ABI, functionName: "owner" }); } catch { continue; }
    if (getAddress(owner) === getAddress(account.address)) { dw = c; break; }
    wrongOwner = { c, owner };
  }
  if (!dw && wrongOwner) {
    return fatal(`链上 owner 与你的私钥不符(异常情况)。\n   钱包: ${wrongOwner.c}\n   钱包 owner: ${wrongOwner.owner}\n   你的私钥地址: ${account.address}\n   已中止,未动任何资金。`);
  }
  if (!dw) {
    return fatal(`读不到你的 deposit 钱包:它可能还没在链上建立(从没在网站完成开户),或网络暂时不通。\n   推导地址: ${candidates.join(" / ")}\n   请确认私钥正确,稍后再试。未动任何资金。`);
  }
  line(`${C.b}你的 deposit 钱包: ${dw}${C.x}`);
  line(`${C.grn}✅ 验证通过:这把私钥拥有这个钱包${C.x}`);
  const eoa = getAddress(account.address);

  // 状态循环（可重复运行、可断点续跑）
  while (true) {
    line(`\n${C.dim}查询链上状态…${C.x}`);
    const [{ paused, delay, unlockAt, unlocked }, pol, erc20, ctf, eoaCtf] = await Promise.all([
      readState(dw), pub.getBalance({ address: account.address }), erc20Balances(dw), ctfPositions(dw), ctfPositions(eoa),
    ]);
    // 上一次救援时还没结算、留在 EOA 的持仓,结算后可直接在 EOA 赎回(不需要暂停/等待)。
    const eoaWinners = categorize(eoaCtf).winners;

    line(`\n${C.b}── 你的资产（在 ${dw.slice(0, 8)}…${dw.slice(-4)}）──${C.x}`);
    if (!erc20.length && !ctf.length) line(`   (空)`);
    for (const t of erc20) line(`   现金 ${t.name.padEnd(6)} ${C.grn}${fmt(t.bal, t.dec)}${C.x}`);
    for (const p of ctf) line(`   持仓 ${p.redeemable ? C.grn + "可赎回" : C.dim + "未结算"}${C.x} $${Number(p.value).toFixed(2)}  ${p.outcome} · ${p.title.slice(0, 40)}`);
    if (eoaCtf.length) {
      line(`\n${C.b}── 之前提出、留在你 EOA 的持仓 ──${C.x}`);
      for (const p of eoaCtf) line(`   持仓 ${p.redeemable ? C.grn + "可赎回" : C.dim + "未结算"}${C.x} $${Number(p.value).toFixed(2)}  ${p.outcome} · ${p.title.slice(0, 40)}`);
    }

    const gasLow = pol < MIN_GAS;
    line(`\n   ⛽ Gas（你EOA上的POL）：${formatUnits(pol, 18)} ${gasLow ? C.ylw + "← 偏低,建议充值 ~0.12 POL" + C.x : ""}`);

    if (gasLow) {
      line(`\n${C.ylw}需要先给这个地址充值约 0.12 POL 当手续费：${C.x}\n   ${C.b}${account.address}${C.x}`);
      const a = await ask(`\n充好后按 Enter 重新检查,或输入 q 退出： `);
      if (a.toLowerCase() === "q") return bye(0);
      continue;
    }

    // deposit 钱包已空,但 EOA 上有已结算的赢单 → 直接赎回并转出(不需要 pause)。
    if (!erc20.length && !ctf.length && eoaWinners.length) {
      await rescueEoaWinners(wallet, eoa, eoaWinners);
      await pause("\n按 Enter 关闭… ");
      return bye(0);
    }

    if (paused === 0n) {
      line(`\n${C.b}下一步:启动提领（会先发 pause(),开始 ${(Number(delay) / 3600).toFixed(1)} 小时的安全倒计时）${C.x}`);
      const a = await ask(`输入 ${C.b}YES${C.x} 确认发送 pause()，或 q 退出： `);
      if (a.toLowerCase() === "q") return bye(0);
      if (a !== "YES") { line(`${C.dim}未确认,跳过。${C.x}`); continue; }
      line(`${C.dim}发送 pause()…${C.x}`);
      const hash = await wallet.writeContract({ address: dw, abi: DW_ABI, functionName: "pause" });
      line(`   交易：https://polygonscan.com/tx/${hash}`);
      await pub.waitForTransactionReceipt({ hash });
      line(`${C.grn}✅ 已暂停。${(Number(delay) / 3600).toFixed(1)} 小时后回来再跑一次本工具即可提领（你可以现在关掉)。${C.x}`);
      const a2 = await ask(`\n要现在就挂着等吗？输入 wait 原地等待倒计时,或按 Enter 退出稍后再来： `);
      if (a2.toLowerCase() !== "wait") return bye(0);
      continue;
    }

    if (!unlocked) {
      const mins = Math.max(0, Math.ceil(Number(unlockAt - BigInt(Math.floor(Date.now() / 1000))) / 60));
      line(`\n${C.ylw}🔒 已暂停,提领将在约 ${mins} 分钟后解锁（${new Date(Number(unlockAt) * 1000).toLocaleString()})。${C.x}`);
      const a = await ask(`输入 wait 原地等待并自动继续,或按 Enter 退出稍后再来： `);
      if (a.toLowerCase() !== "wait") return bye(0);
      while (BigInt(Math.floor(Date.now() / 1000)) <= unlockAt) {
        const l = Math.max(0, Math.ceil(Number(unlockAt - BigInt(Math.floor(Date.now() / 1000))) / 60));
        process.stdout.write(`\r   ${C.dim}倒计时… 约 ${l} 分钟${C.x}    `);
        await sleep(30_000);
      }
      line(`\n${C.grn}✅ 时间锁已过,可以提领了。${C.x}`);
      continue;
    }

    // 解锁 → 救援（Option A:全部在你 EOA 上做,最终把干净的 USDC.e 转到你指定地址)
    line(`\n${C.grn}🔓 时间锁已过。${C.x}`);
    const { winners: dwWinners, unresolved, worthless } = categorize(ctf);
    const winners = [...dwWinners, ...eoaWinners]; // EOA 上已结算的旧持仓一并赎回

    // deposit 钱包已空(可能上一轮已提领完)→ 直接问是否解除暂停,不必再走提领。
    if (erc20.length === 0 && dwWinners.length === 0 && unresolved.length === 0) {
      line(`${C.dim}deposit 钱包里没有可提领的资产。${C.x}`);
      await offerUnpause(wallet, dw);
      await pause("\n按 Enter 关闭… ");
      return bye(0);
    }

    // ③ 选择最终收到的币种 (USDC.e / USDC)
    const estRaw = erc20.reduce((s, t) => s + t.bal, 0n) + winners.reduce((s, w) => s + w.bal, 0n);
    const { token: payoutToken, slipPct } = await askPayoutToken(estRaw);
    const isUsdc = payoutToken === "usdc";
    const payoutName = isUsdc ? "USDC" : "USDC.e";

    // ④ 核对所选币种合约地址 + 填收款地址(提示随选择变)
    line(`\n${C.b}请核对 ${isUsdc ? "USDC（Polygon 链）" : "USDC.e"} 合约地址,确保能正确提领并到帐:${C.x}`);
    line(`${C.dim}  ${isUsdc ? USDC : USDC_E}${C.x}`);
    const destHint = isUsdc
      ? `经 DEX 兑换,滑点+手续费约 ${slipPct !== null ? slipPct.toFixed(3) + "%" : "极小"}`
      : `建议填你自己的钱包,如 MetaMask;交易所地址可能不支持 USDC.e`;
    line(`\n${C.b}④ 收款地址${C.x}（${destHint}）：`);
    const dest = await askAddress(process.env.DEST, `   > `);

    line(`\n${C.b}计划:${C.x}`);
    for (const t of erc20) line(`   现金 ${t.name} ${fmt(t.bal, t.dec)}${t.name === "pUSD" ? " → 换成 USDC.e" : ""}`);
    for (const w of winners) line(`   ${C.grn}🏆 赢 $${w.value.toFixed(2)}${C.x} ${w.title.slice(0, 38)} → 赎回成 USDC.e`);
    for (const u of unresolved) line(`   ${C.ylw}⏳ 未结算 $${u.value.toFixed(2)}${C.x} ${u.title.slice(0, 38)} → 暂时无法提领,需等待结算后才能提领`);
    if (worthless.length) line(`   ${C.dim}(忽略 ${worthless.length} 笔 $0 废份额)${C.x}`);
    line(`   ${C.b}→ 全部换成 ${payoutName} 转到: ${dest}${C.x}`);

    const conf = await ask(`\n输入 ${C.b}RESCUE${C.x} 确认开始（约 8~12 笔交易，备好 ~0.12 POL），或 q 取消： `);
    if (conf !== "RESCUE") { line(`${C.dim}已取消,未动任何资金。${C.x}`); return bye(0); }

    // [1/4] 逃生提领 — deposit 钱包 → 你的 EOA
    line(`\n${C.b}[1/4] 从 deposit 钱包提出 → 你的 EOA${C.x}`);
    for (const t of erc20) await sendTx(wallet, { address: dw, abi: DW_ABI, functionName: "withdrawERC20", args: [getAddress(t.addr), eoa, t.bal] }, `提出 ${t.name} ${fmt(t.bal, t.dec)}`);
    const moveShares = [...dwWinners, ...unresolved];
    if (moveShares.length) await sendTx(wallet, { address: dw, abi: DW_ABI, functionName: "withdrawERC1155", args: [getAddress(CTF), eoa, moveShares.map((p) => p.id), moveShares.map((p) => p.bal)] }, `提出 ${moveShares.length} 笔持仓份额`);

    // [2/4] 赎回赢的持仓 → pUSD/USDC.e
    line(`\n${C.b}[2/4] 赎回赢的持仓${C.x}`);
    if (winners.length) await redeemWinners(wallet, eoa, winners); else line(`   (无)`);

    // [3/4] pUSD → USDC.e
    line(`\n${C.b}[3/4] 把 pUSD 换成 USDC.e${C.x}`);
    if ((await unwrapPusd(wallet, eoa)) === 0n) line(`   (无 pUSD)`);

    // [4/4] 按你选的币种转到收款地址
    line(`\n${C.b}[4/4] 把 ${payoutName} 转到收款地址${C.x}`);
    await deliver(wallet, eoa, dest, payoutToken);

    line(`\n${C.grn}${C.b}🎉 完成!资金已转到 ${dest}${C.x}`);
    if (unresolved.length) {
      line(`${C.ylw}⏳ ${unresolved.length} 笔持仓暂时无法提领,需等待结算后才能提领(份额留在你的 EOA ${eoa}):${C.x}`);
      for (const u of unresolved) line(`   ${C.dim}· ${u.title.slice(0, 46)}${C.x}`);
    }

    // 提领后:问是否还要继续使用网站 → 要则 unpause(恢复正常);不要则保持暂停。
    await offerUnpause(wallet, dw);

    await pause("\n按 Enter 关闭… ");
    return bye(0);
  }
}

main().catch(async (e) => { await fatal(e?.shortMessage || e?.message || String(e)); });
