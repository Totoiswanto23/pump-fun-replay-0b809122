// Launch sniper for the pump.fun bonding-curve replay.
//
// Every coin is watched from its CreateEvent. The bot buys in the first few slots of a
// launch that passes a rug filter (real SOL in range, creator's own buy small, only a few
// distinct non-creator buyers so far, creator has not sold, no big single sell, price not
// already run away), then gets out fast: take profit, stop loss, a short time limit, and an
// immediate exit when the creator sells (a trailing stop and a partial take-profit exist as
// options but are off by default). Most launches die, so the bet is small per coin and the
// winners — the few that run hard in their first slots — pay for the losers.
//
// A probe fallback keeps the run above the 20-coin guardrail: when the bot's own filled
// coins lag the pace of the window, it opens tiny round trips on liquid curves.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin in total (each buy still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot, at most (SOL). */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, at most (as a fraction). */
  maxSellRatio: number;
  /** Largest single non-creator sell seen, as a share of the real SOL reserve before it. */
  maxBigSellShare: number;
  /** Price now over the create price, as a fraction: window. */
  minRunup: number;
  maxRunup: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowSol: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Sell this share of the position once it is worth (1 + tp1) of its cost. 0 = off. */
  tp1: number;
  tp1Part: number;
  /** After the first take-profit, the rest stops out at cost * (1 + slAfterTp1). */
  slAfterTp1: number;
  /** Exit when the position is worth (1 + tp) of its cost. */
  tp: number;
  /** Exit when the position is worth (1 - sl) of its cost. */
  sl: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** SOL kept back as a cash reserve (plus one tx fee per order). */
  cashReserveSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.01,
  minBuySol: 0.005,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 0.5,
  minBuyers: 0,
  maxBuyers: 2,
  maxSellRatio: 1,
  maxBigSellShare: 1,
  minRunup: 0,
  maxRunup: 100,
  flowWindow: 10,
  minFlowSol: -1e12,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlipBps: 10_000,
  tp1: 0,
  tp1Part: 0.5,
  slAfterTp1: 0,
  tp: 0.15,
  sl: 0.12,
  trailArm: 0,
  trail: 0.1,
  maxHold: 5,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  targetCoins: 21,
  targetFills: 42,
  paceSecs: 86_400,
  probeSol: 0.02,
  maxProbes: 1,
  maxExposureSol: 4,
  cashReserveSol: 0.05,
};

const LAMPORTS = 1e9;
/** Curve fee on a trade: 1.25% (95 bps protocol + 30 bps creator). */
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: number;
  vt0: number;
  devBuy: number;
  trades: number;
  buyers: Set<Pubkey>;
  bought: number;
  soldByOthers: number;
  bigSellShare: number;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  boughtOnce: boolean;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: number;
  best: number;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        createSlot: -1,
        creator: '',
        vq0: 0,
        vt0: 1,
        devBuy: 0,
        trades: 0,
        buyers: new Set(),
        bought: 0,
        soldByOthers: 0,
        bigSellShare: 0,
        devSold: false,
        lastTradeSlot: -1,
        recent: [],
        boughtOnce: false,
        done: false,
        complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net SOL bought minus sold and the distinct buyers, over the last flowWindow slots. */
  const flow = (c: Coin, now: number): { net: number; buyers: number } => {
    const from = now - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.buy) {
        net += t.sol;
        buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  };

  /** What selling `tokens` against (vq, vt) would pay after curve fees, in SOL. */
  const sellValue = (tokens: number, vq: number, vt: number): number => {
    if (tokens <= 0 || vt <= 0) return 0;
    const q = (tokens * vq) / (vt + tokens);
    return (q / LAMPORTS) * (1 - CURVE_FEE);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.vq0 = Number(e.virtual_quote_reserves);
          c.vt0 = Number(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades++;
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
            const rqBefore = Number(e.real_quote_reserves) / LAMPORTS + sol;
            if (rqBefore > 0) {
              const share = sol / rqBefore;
              if (share > c.bigSellShare) c.bigSellShare = share;
            }
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += Number(f.tx_fee_lamports) / LAMPORTS;
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: Number(f.tx_fee_lamports) / LAMPORTS,
            best: 0,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
            tookTp1: false,
          });
        }
      }
      for (const mint of [...selling]) {
        let stillPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') stillPending = true;
        }
        if (!stillPending) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint)) {
          let buyPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'buy') buyPending = true;
          }
          if (!buyPending) held.delete(mint);
        }
      }
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        if (probes.has(mint)) continue; // probes are closed by the probe loop, not here.
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: now, txPaid: tx, best: 0, devSoldAtOpen: c?.devSold ?? false, tookTp1: false };
          held.set(mint, h);
        }
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : 0;
        const vt = mk ? Number(mk.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : 1;
        const tokens = Number(pos.token_amount);
        const value = sellValue(tokens, vq, vt) - tx;
        const basis = Number(pos.cost_lamports) / LAMPORTS + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0) {
          if (p.tp1 > 0 && !h.tookTp1 && value >= basis * (1 + p.tp1)) {
            const part = Math.floor(tokens * p.tp1Part);
            if (part > 0 && part < tokens) {
              orders.push({ side: 'sell', mint, token_amount: BigInt(part), max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0;
              if (c !== undefined) c.done = true;
              continue;
            }
          }
          if (value >= basis * (1 + p.tp)) exit = true;
          const sl = h.tookTp1 ? -p.slAfterTp1 : p.sl;
          if (value <= basis * (1 - sl)) exit = true;
          if (p.trailArm > 0 && h.best >= basis * (1 + p.trailArm) && value <= h.best * (1 - p.trail)) exit = true;
        }
        if (now - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (now - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!sellingProbe) probes.set(mint, true);
      }

      // Entries: one buy per coin, in its first slots, only if the rug filter passes.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let exposure = 0;
      for (const [mint] of held) {
        exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      }
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.boughtOnce) continue;
        const age = now - c.createSlot;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) {
          continue;
        }
        const rq = Number(curve.real_quote_reserves) / LAMPORTS;
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        // One buy per coin, in its first slots, only if the rug filter passes.
        if (age <= p.maxAge) {
          if (age < p.minAge) {
            continue;
          }
          if (open >= state.hello.caps.max_open_positions) {
            continue;
          }
          if (c.devSold && p.skipDevSold) {
            c.done = true;
            continue;
          }
          if (rq < p.minRealSol || rq > p.maxRealSol) {
            continue;
          }
          if (c.devBuy > p.maxDevBuySol) {
            continue;
          }
          if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) {
            continue;
          }
          if (c.bought > 0 && c.soldByOthers > c.bought * p.maxSellRatio) {
            continue;
          }
          if (c.bigSellShare > p.maxBigSellShare) {
            continue;
          }
          const runup = (vq * c.vt0) / (vt * c.vq0) - 1;
          if (runup < p.minRunup || runup > p.maxRunup) {
            continue;
          }
          const fl = flow(c, now);
          if (fl.net < p.minFlowSol || fl.buyers < p.minRecentBuyers) {
            continue;
          }
          const maxBuy = Math.floor(Number(state.maxBuyLamports(c.mint))) / LAMPORTS;
          const amount = Math.min(p.stakeSol, maxBuy);
          if (amount < p.minBuySol) {
            continue;
          }
          if (free < amount + tx + p.cashReserveSol) {
            continue;
          }
          if (exposure + amount > p.maxExposureSol) {
            continue;
          }
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          c.boughtOnce = true;
          open++;
          continue;
        }
        if (age > p.maxAge) {
          c.done = true;
        }
      }

      // Guardrail pacing: open a probe when filled coins lag the pace of the window.
      if (probes.size < p.maxProbes && open < state.hello.caps.max_open_positions && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of state.curves.keys()) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint)!;
            if (curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx + p.cashReserveSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
