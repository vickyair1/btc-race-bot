# btc-race-bot

A BTC trading bot for the make.fun competition
`btc-race-24h-20261117-0603`: it trades Coinbase Wrapped BTC (cbBTC) against
USDC on 1-minute on-chain bars, long only, starting from $1,000 of paper money.

## Strategy

Dip-buying with TWAP execution, tuned on the competition's published dev
window (1,440 one-minute bars) with a backtester that replicates the replay's
fill model (4 bps fee, 2 bps slippage, constant-product impact on each bar's
open depth, fills at the next bar's open):

- **Start in cash.** Track the running peak close.
- **Buy dips below the peak in tranches:** -50 bps -> 25% of equity,
  -100 -> 50%, -150 -> 75%, -200 -> 100%. Levels only ever raise the target;
  a recovery never sells.
- **Take profit:** while the position is up >= 100 bps on its average cost,
  halve the target every 5+ bars (scale out into strength; dips rebuy).
- **Crash exit:** a 60-bar return <= -300 bps sells everything at once. The
  bot stays out until a 15-bar return >= +30 bps after a 15-bar cooldown, with
  the peak reset to the crash price.
- **TWAP execution:** at most 10% of equity per bar toward the target, so a
  fill's own price impact stays near ~1 bp instead of ~11 bps for a full-size
  order (each bar's pool starts again from its own open depth). Crash exits
  ignore the cap: in a crash the falling price costs more than impact.

All arithmetic is integer (prices are ints, returns in basis points), no clock,
no randomness, no network: the same bars give the same orders, run after run.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, no dependencies).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `sdk/makefun-bars.ts` protocol shim.

## Local result

**Official grade on the dev window (kit grader, process driver):
net PnL +17.315 USDC** — 64 trades, win rate 1.000, max drawdown 1.03%,
0 rejected orders, L1 regrade reproduced byte for byte (deterministic).
Fees $1.95; at 2x fees net PnL is still +$15.36.

Backtester on the same window (independent replication of the fill model):
+$16.94, positive in both halves (+$10.23 / +$0.74). Buy-and-hold on the same
window nets +$1.07; the house EMA-cross baseline loses $106.21 (68 trades —
round-trip costs of ~35 bps at full size punish churn).

Grade it the way the server does:

```
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```
