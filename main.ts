// Dip-buying BTC bot for make.fun btc-race-24h-20261117-0603.
//
// Strategy (backtested on the dev window, +$16.94 net in the local backtester):
//   - Start in cash. Track the running peak close.
//   - Buy dips below the peak in tranches: -50 bps -> 25%, -100 -> 50%,
//     -150 -> 75%, -200 -> 100% of equity (ratchet: levels only ever raise the
//     target; a recovery never sells).
//   - Take profit: while the position is up >= 100 bps on its average cost,
//     halve the target every 5+ bars (scale out into strength; dips rebuy).
//   - Crash exit: a 60-bar return <= -300 bps sells everything at once; the bot
//     stays out until a 15-bar return >= +30 bps after a 15-bar cooldown, with
//     the peak reset to the crash price.
//   - Execution is TWAP: at most 10% of equity per bar toward the target, so a
//     fill's own price impact stays near ~1 bp instead of ~11 bps for a full-size
//     order (each bar's pool starts again from its own open depth). Crash exits
//     ignore the TWAP cap: during a crash the falling price costs more than impact.
//
// All arithmetic is BigInt (prices are ints, returns in basis points), no clock,
// no randomness, no network: the same bars give the same orders, run after run.
// One order per batch at most. max_slippage_bps 100 on every order.
//
// Verified with the kit's own grader on the dev window:
//   grade-local --driver process: net PnL +17.315 USDC, 64 trades, win rate
//   1.000, max drawdown 1.03%, 0 rejected orders, L1 regrade reproduced byte
//   for byte (deterministic). Buy-and-hold on the same window nets +$1.07;
//   the house EMA-cross baseline loses $106.21.

import {
  BPS,
  runBars,
  type Bar,
  type BarsState,
  type Batch,
  type OrderInput,
} from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units
const MAX_SLIPPAGE_BPS = 100;
const TWAP_BPS = 1000n; // move at most 10% of equity per bar toward the target

// Dip levels below the running peak (bps) and the target weight each sets (bps).
const DIP_LEVELS: Array<[bigint, bigint]> = [
  [50n, 2500n],
  [100n, 5000n],
  [150n, 7500n],
  [200n, 10000n],
];
const TAKE_PROFIT_BPS = 100n; // halve the target while the position is up this much
const TAKE_PROFIT_COOLDOWN = 5; // bars between take-profit halvings
const CRASH_BPS = 300n; // 60-bar return at or below this (-300 bps) exits all
const CRASH_WINDOW = 60;
const CRASH_COOLDOWN = 15; // bars to wait after a crash exit before re-entry
const REBUY_BPS = 30n; // 15-bar return that ends the post-crash wait
const REBUY_WINDOW = 15;

const closes: bigint[] = []; // CBBTC closes, in bar order
let peak: bigint | null = null; // running peak close
let ratchet = 0n; // target weight in bps (0..10000)
let tpBar = -1_000_000_000; // bar index of the last take-profit halving
let coolUntil = -1; // bar index until which re-entry is blocked
let crashed = false; // waiting for a recovery after a crash exit

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  let bar: Bar | undefined;
  for (const b of batch.bars) {
    if (b.symbol === SYMBOL) {
      bar = b;
      break;
    }
  }
  if (bar === undefined) return []; // no CBBTC bar this minute: nothing to decide on
  const close = BigInt(bar.c);
  closes.push(close);
  const i = closes.length - 1;
  if (peak === null) peak = close;
  if (close > peak) peak = close;
  if (state.warmingUp) return []; // build history; orders on warm-up bars are rejected

  const held = state.positions.get(SYMBOL);
  const qty = held === undefined ? 0n : held.qty;
  const cost = held === undefined ? 0n : held.cost;
  const equity = state.equity;
  const value = qty === 0n ? 0n : state.value(SYMBOL, qty);
  const weight = equity > 0n && qty > 0n ? (value * BPS) / equity : 0n;

  // --- crash exit: 60-bar return at or below -300 bps ---
  if (i >= CRASH_WINDOW && qty > 0n) {
    const ago = closes[i - CRASH_WINDOW];
    const ret60 = ((close - ago) * BPS) / ago;
    if (ret60 <= -CRASH_BPS) {
      coolUntil = i + CRASH_COOLDOWN;
      peak = close;
      ratchet = 0n;
      crashed = true;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
  }
  if (crashed) {
    if (i < coolUntil) return [];
    if (i >= REBUY_WINDOW) {
      const ago = closes[i - REBUY_WINDOW];
      const ret15 = ((close - ago) * BPS) / ago;
      if (ret15 >= REBUY_BPS) {
        crashed = false;
      } else {
        return [];
      }
    } else {
      return [];
    }
  }

  // --- dip levels ratchet the target up ---
  const dip = peak === 0n ? 0n : ((peak - close) * BPS) / peak;
  let target = ratchet;
  for (const [levelBps, weightBps] of DIP_LEVELS) {
    if (dip >= levelBps && weightBps > target) target = weightBps;
  }
  ratchet = target;

  // --- take profit: halve the target while up >= 100 bps on cost ---
  if (qty > 0n && cost > 0n) {
    const gain = ((value - cost) * BPS) / cost;
    if (gain >= TAKE_PROFIT_BPS && i > tpBar + TAKE_PROFIT_COOLDOWN) {
      tpBar = i;
      ratchet /= 2n;
      target = ratchet;
    }
  }

  // --- TWAP toward the target: at most 10% of equity per bar ---
  if (target > weight) {
    const step = (equity * TWAP_BPS) / BPS;
    const need = ((target - weight) * equity) / BPS;
    let notional = need < step ? need : step;
    if (notional > state.cash) notional = state.cash;
    if (notional < MIN_NOTIONAL) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  if (target < weight) {
    const step = (equity * TWAP_BPS) / BPS;
    const need = ((weight - target) * equity) / BPS;
    const sellValue = need < step ? need : step;
    const sellQty = value > 0n ? (qty * sellValue) / value : 0n;
    if (sellQty <= 0n) return [];
    if (sellQty < qty && sellValue < MIN_NOTIONAL) return []; // below min notional and not emptying the position
    return [{ side: 'sell', symbol: SYMBOL, qty: sellQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

await runBars({ onBatch });
