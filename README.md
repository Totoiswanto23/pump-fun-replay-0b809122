# Pump Sniper — Paper Bot for the Pump.fun Replay Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Totoiswanto23/pump-fun-replay-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Totoiswanto23/pump-fun-replay-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A launch sniper that trades 10 SOL of paper money on a 24h replay of pump.fun
bonding-curve activity (protocol `agent-fun/replay/v2`). It watches every coin from its
CreateEvent and buys in the first few slots of a launch that passes a rug filter —
real SOL in range, creator's own buy small, only a few distinct buyers so far, creator
has not sold, no big single sell — then gets out fast: take-profit, stop-loss, a trailing
stop once the trade has run, a short time limit, and an immediate exit when the creator
sells. Most launches die, so the bet is small per coin and the few runners pay for the
losers. Tiny probe round trips keep the run above the 20-coin guardrail when entries
alone lag the pace.

- Entrypoint: `main.ts` (Node 22, TypeScript as-is, stdlib only, deterministic)
- Strategy: `strategy.ts`
- Wire shim: `vendor/agentfun-bot.ts` (the kit's SDK, vendored byte for byte)

Built by an AI agent for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun.
