# BOOPOLY 资金救援工具 (boopoly-rescue)

**你的资金永远不会被困住。** 这个开源工具在**你自己的电脑**上运行,直连
**Polygon** 区块链,把你 Polymarket V2 deposit 钱包里的所有资产提到**任何你
指定的地址**。它**不依赖本站**——即使 BOOPOLY、polymarket.com 和所有
Polymarket relayer 全部下线,它依然能用。

它直接调用 deposit 钱包合约内建的 **owner 逃生函数**:

```
pause()                    ← owner 盖上「暂停」时间戳
… 等 1 小时 …               ← 合约自身的 anti-rug 时间锁(不是我们加的)
withdrawERC20(...)         ← 提走 USDC.e / pUSD / USDC 现金
withdrawERC1155(...)       ← 提走你的 outcome 持仓份额
```

只有钱包的 **owner 本人**(你的私钥)能调用,且必须等满 1 小时时间锁。
新旧两种 deposit 钱包都支持:2026 年 5 月底以前建立的(UUPS,实现
`0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB`),以及之后建立的(Beacon,
由 factory `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` 的 `beacon()` 决定)。

---

## 给一般用户:双击就能用,不用装任何东西

你只需要**两样**东西:
1. **你的私钥** —— 从 Privy 导出的那把（embedded wallet 的私钥）。这是**唯一**必需、也是**只有你能提供**的东西。
2. **约 0.12 POL** —— 放在你的钱包地址(EOA)上当手续费,整套约 8~12 笔交易。

> 💡 你**不需要**知道 deposit 钱包地址。它是用 CREATE2 从你的私钥地址
> **确定性推导**出来的——工具会同时算出新旧两种可能的地址,再到链上核对哪一个
> 属于你,完全不需要 BOOPOLY 或任何网站提供信息。

### 步骤

1. **双击 `启动救援工具.bat`**（推荐;它会把视窗设成 UTF-8 让中文正常显示）。
   也可以直接双击 `BOOPOLY-Rescue.exe`。
2. 跟着画面提示走:
   - 贴上你的 **私钥**(输入时以 `*` 显示,绝不会被记录或上传);
   - 工具会**自动找到你的 deposit 钱包**,并**核对链上 owner**,确认这把钥匙确实拥有它——不符就立刻中止,**不动任何资金**;
   - 它显示你的余额和持仓后,引导你确认 **`pause`** 启动 1 小时倒计时;
   - **等约 1 小时**(你可以关掉视窗,1 小时后再双击跑一次——工具会自动接续);
   - 时间到后,选择要收 USDC.e 还是原生 USDC,**贴上你的收款地址**,确认 `RESCUE`,工具会自动跑完下面整套。

> ⏱️ 全程约 **1 小时**——这是合约本身的 anti-rug 时间锁,不是我们加的。

### 你最终拿到的是干净的稳定币(不是 pUSD,不是原始份额)
确认后,工具会**全自动**(全部在你 EOA 上、零 relayer/网站依赖):
1. 用逃生函数把现金 + 持仓份额从 deposit 钱包提到你的 EOA;
2. 对**赢的(已结算)持仓**调 `redeemPositions` 赎回(普通市场走 ConditionalTokens、neg-risk 走 NegRiskAdapter);
3. 把所有 **pUSD 通过 CollateralOfframp 换成 USDC.e**(permissionless、1:1、无手续费);
4. 把 **USDC.e 转到你填的收款地址**;若选了原生 USDC,则经 Uniswap V3(0.01% 池)兑换后直接转过去。

> ⏳ **未结算的持仓**(例如还没打完的赛事)暂时无法赎回——工具会把这些份额留在
> 你的 EOA(你用私钥完全掌控)。**结算后再跑一次本工具**,它会发现 EOA 上已结算的
> 赢单,直接赎回并转到你的收款地址(这一步不需要暂停、不用等 1 小时)。$0 的废份额则忽略。

> 🔁 **提领完成后**,工具会问你「是否还要继续使用 BOOPOLY 网站?」——要继续用就解除
> 暂停(`unpause`)让钱包回到正常状态;不再使用就保持暂停即可(之后想用再跑本工具解除)。

### 安全
- 私钥**只在本机**用于签名,**绝不**显示、保存或上传。
- 工具只连接公开的 Polygon RPC 节点(读链上状态、送出你签好的交易)和
  Polymarket 公开的 data-api(查你的持仓列表),不连接 BOOPOLY 的任何服务器。
- 工具**拒绝运行**,除非 deposit 钱包的 `owner()` 等于你私钥的地址。
- 在你输入 `YES`(暂停)、再输入 `RESCUE`(提领)之前,不会动任何资金。
- 即使整套中途因故中断,**资金也安全停在你 EOA**(你用私钥完全掌控),重跑即可接续。

---

## 给开发者:如何打包出那个 .exe

源码只有一个文件 `rescue.mjs`(可自行审阅)。打包成单个、免安装的 Windows
.exe:

```bash
npm ci               # 安装 viem + esbuild + pkg
npm run build        # 产出 dist/BOOPOLY-Rescue.exe
```

`npm run build` 会先用 esbuild 把脚本和 viem 打包成单文件,再用 pkg 内嵌
Node.js 生成 `dist/BOOPOLY-Rescue.exe`(约 43 MB,双击即用)。把这个 .exe 和
`启动救援工具.bat` 一起发给用户即可。

也可以直接用 Node 跑(需本机有 Node 18+):
```bash
node rescue.mjs
# 或非互动方式(老手;deposit 钱包仍自动推导,DEST 可选,RPC_URL 可换节点):
PRIVATE_KEY=0x... DEST=0x... node rescue.mjs
```
