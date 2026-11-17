# btc-race-bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/vickyair1/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/vickyair1/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

A BTC trading bot for the [make.fun BTC race bounty](https://make.fun/bounty/btc-race-24h-20261117-0603)
(`btc-race-24h-20261117-0603`): it trades Coinbase Wrapped BTC (cbBTC) against
USDC on 1-minute on-chain bars, long only, starting from $1,000 of paper money.

## Strategy

Dip-buying with TWAP execution, tuned on the competition's published dev
window (1,440 one-minute bars) with a backtester that replicates the replay's
fill model (4 bps fee, 2 bps slippage, constant-product impact on each bar's
open depth, fills at the next bar's open):

- **Start in cash.** Track the running peak close.
- **Buy dips below the peak in back-loaded tranches:** -42 bps -> 2% of
  equity, -84 -> 10%, -126 -> 35%, -168 -> 100%. Levels only ever raise the
  target; a recovery never sells. The edge grows with dip depth (mean
  reversion dominates at 30-120 min horizons), so the deep tranches carry the
  size; the shallow 2% tranche keeps the bot active on mild days.
- **Take profit:** while the position is up >= 165 bps on its average cost,
  SELL EVERYTHING (target 0; the TWAP exit takes ~10 bars for a full
  position). The dev window mean-reverts, so banking the whole gain beats
  scaling out. Dips rebuy afterwards.
- **Peak reset after a take-profit:** after selling everything at the TP, the
  running peak resets to the sell price, so the next dip trigger is measured
  from the post-TP price instead of the old all-time peak — the bot re-enters
  sooner and catches more cycles. TP 160-175 all score >= +$34.89, so 165
  sits mid-plateau, not on a spike.
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
net PnL +35.590 USDC** — 59 trades, win rate 1.000, max drawdown 0.73%,
0 rejected orders, L1 regrade reproduced byte for byte (deterministic).
Fees $2.46; at 2x fees net PnL is still +$33.11.

Backtester on the same window (independent replication of the fill model):
+$35.60, positive in both halves (+$21.93 / +$2.00). Buy-and-hold on the same
window nets +$1.07; the house EMA-cross baseline loses $106.21 (68 trades —
round-trip costs of ~35 bps at full size punish churn).

v1 of this bot (equal 25% tranches at -50/-100/-150/-200, TP 100 bps every
5 bars) graded +$17.32 officially. v2 (back-loaded 5/10/35/50, TP 140 bps
halve every 3 bars) graded +$31.01. v3 (sell-all TP at 145 bps, tranches
2/8/25/65) graded +$33.60. v4 comes from a further grid over 4 dimensions
the earlier grids never tried: resetting the running peak after a take-profit
sell-all (plus TP 145 -> 165) won at +$35.59. Trailing-stop exits, breakout-buy
add-ons, TP rebuys, and shallow 5th dip levels were all tested and rejected.

Grade it the way the server does:

```
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```
