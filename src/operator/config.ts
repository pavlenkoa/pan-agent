function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export interface OperatorConfig {
  namespace: string;
  image: string;
  nfsServer: string;
  nfsRootPath: string;
  telegramBotToken: string;
  telegramAdminChatId: number;
  tasksApiPort: number;
  sweepIntervalMs: number;
  catchUpWindowMs: number;
  personaConfigMapName: string;
  mediaPvcName: string;
  nodeHostname: string;
  defaultTz: string;
  operatorServiceHost: string;
  podReadyTimeoutMs: number;
}

export function loadOperatorConfig(): OperatorConfig {
  const namespace = process.env['NAMESPACE'] ?? 'pan-agent';
  const tasksApiPort = Number(process.env['TASKS_API_PORT'] ?? 8081);
  return {
    namespace,
    image: requireEnv('PERSON_POD_IMAGE'),
    nfsServer: process.env['NFS_SERVER'] ?? '192.168.88.3',
    nfsRootPath: process.env['NFS_ROOT_PATH'] ?? '/media/pan-agent',
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    telegramAdminChatId: Number(requireEnv('TELEGRAM_ADMIN_ID')),
    tasksApiPort,
    sweepIntervalMs: Number(process.env['SWEEP_INTERVAL_MS'] ?? 60_000),
    catchUpWindowMs: Number(process.env['CATCH_UP_WINDOW_MS'] ?? 6 * 60 * 60 * 1000),
    personaConfigMapName: process.env['PERSONA_CONFIGMAP_NAME'] ?? 'pan-agent-persona',
    mediaPvcName: process.env['MEDIA_PVC_NAME'] ?? 'pan-agent-media-nfs',
    nodeHostname: process.env['PERSON_POD_NODE'] ?? 'macmini',
    defaultTz: process.env['DEFAULT_TZ'] ?? 'Europe/Warsaw',
    operatorServiceHost: process.env['OPERATOR_SERVICE_HOST'] ?? `pan-agent-operator.${namespace}.svc`,
    podReadyTimeoutMs: Number(process.env['POD_READY_TIMEOUT_MS'] ?? 120_000),
  };
}
