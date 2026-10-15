# BOOPOLY Rescue (boopoly-rescue)

**Your funds can never be trapped.** This open-source tool runs on **your own
computer**, talks straight to the **Polygon** blockchain, and moves everything
in your Polymarket V2 deposit wallet to **any address you choose**. It does
**not depend on BOOPOLY** — it keeps working even if BOOPOLY, polymarket.com
and every Polymarket relayer are offline.

It calls the deposit wallet contract's built-in **owner escape hatch**:

```
pause()                    ← the owner stamps a "paused" time
… wait 1 hour …            ← the contract's own anti-rug timelock (not ours)
withdrawERC20(...)         ← withdraws USDC.e / pUSD / USDC cash
withdrawERC1155(...)       ← withdraws your outcome shares
```

Only the wallet's **owner** (your private key) can call these, and only after
the 1-hour timelock. Both kinds of deposit wallet are supported: wallets created
before late May 2026 (UUPS, implementation
`0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB`) and wallets created since (beacon
proxies, set by `beacon()` on the factory `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`).

---

## For everyone: double-click, nothing to install

Download `BOOPOLY-Rescue.exe` and `Start-Rescue.bat` from the
[Releases](../../releases) page. You need just **two** things:

1. **Your private key** — the one you exported from Privy (your embedded
   wallet's key). It is the **only** required input, and only you have it.
2. **About 0.12 POL** on your wallet address (EOA) for network fees — the full
   rescue is about 8–12 transactions.

> 💡 You **don't** need your deposit wallet address. It is derived from your
> key's address with CREATE2: the tool computes both possible addresses (old
> and new wallet type) and checks on-chain which one is yours — nothing has to
> come from BOOPOLY or any website.

### Steps

1. **Double-click `Start-Rescue.bat`** (recommended — it switches the window to
   UTF-8). You can also double-click `BOOPOLY-Rescue.exe` directly.
2. Follow the prompts:
   - paste your **private key** (shown as `*`, never recorded or uploaded);
   - the tool **finds your deposit wallet** and **checks its on-chain owner**
     matches your key — if not, it stops and **moves nothing**;
   - it lists your balances and positions, then asks you to confirm **`pause`**
     to start the 1-hour countdown;
   - **wait about 1 hour** (you can close the window and run the tool again an
     hour later — it picks up where it left off);
   - when the time is up, choose USDC.e or native USDC, **paste your payout
     address**, type `RESCUE`, and the tool does the rest.

> ⏱️ About **1 hour** end to end — that is the contract's own timelock.

### You receive clean stablecoins (not pUSD, not raw shares)

After you confirm, the tool runs everything from your EOA, with no relayer or
website involved:

1. withdraws cash + outcome shares from the deposit wallet to your EOA;
2. redeems **winning (settled) positions** with `redeemPositions` (regular
   markets through ConditionalTokens, neg-risk markets through NegRiskAdapter);
3. converts all **pUSD to USDC.e** through the CollateralOfframp
   (permissionless, 1:1, no fee);
4. sends the **USDC.e to your payout address** — or, if you chose native USDC,
   swaps it on Uniswap V3 (0.01% pool) straight to that address.

> ⏳ **Unsettled positions** (e.g. a game still being played) can't be redeemed
> yet. Their shares stay on your EOA, which your key fully controls. **Run the
> tool again after the market settles**: it finds the settled winners on your
> EOA, redeems them and sends them to your payout address — no pause and no
> 1-hour wait for this step. Worthless $0 shares are ignored.

> 🔁 **After the rescue** the tool asks whether you'll keep using BOOPOLY. If
> yes, it un-pauses the wallet (`unpause`) so the website can operate it again;
> if not, the wallet simply stays paused (run the tool later to un-pause).

### Safety

- Your private key is used **only on this machine** to sign — **never** shown,
  saved or sent anywhere.
- The tool only talks to public Polygon RPC nodes (to read the chain and send
  the transactions you signed) and Polymarket's public data API (to list your
  positions). It never contacts any BOOPOLY server.
- It **refuses to run** unless the deposit wallet's `owner()` equals your
  key's address.
- Nothing moves until you type `YES` (pause) and then `RESCUE` (withdraw).
- If a run stops halfway, your funds **sit safely on your EOA** (your key
  controls it) — just run the tool again to continue.

---

## For developers: building the .exe

The whole tool is one file, `rescue.mjs` — read it before you run it. To build
a single, install-free Windows .exe:

```bash
npm ci               # installs viem + esbuild + pkg
npm run build        # produces dist/BOOPOLY-Rescue.exe
```

`npm run build` bundles the script and viem into one file with esbuild, then
embeds Node.js with pkg to produce `dist/BOOPOLY-Rescue.exe` (about 43 MB).
Ship it together with `Start-Rescue.bat`.

You can also run it with Node 18+:

```bash
node rescue.mjs
# non-interactive (advanced; the deposit wallet is still derived, DEST is
# optional, RPC_URL lets you use your own node):
PRIVATE_KEY=0x... DEST=0x... node rescue.mjs
```
