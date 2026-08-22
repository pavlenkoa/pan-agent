import type { CoreV1Api } from '@kubernetes/client-node';

import type { OperatorConfig } from './config.js';
import type { TelegramClient } from './telegram.js';

/** Shared dependency bag for router.ts and admin-commands.ts (split out to avoid a circular import). */
export interface RouterDeps {
  api: CoreV1Api;
  cfg: OperatorConfig;
  telegram: TelegramClient;
}
