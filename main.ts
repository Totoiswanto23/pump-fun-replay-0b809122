// pump-sniper: a launch sniper for the agent.fun pump.fun replay (agent-fun/replay/v2).
// The strategy lives in strategy.ts; the SDK shim is the kit's sdk/ts/agentfun-bot.ts,
// vendored byte for byte.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
