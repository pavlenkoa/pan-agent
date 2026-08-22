function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export interface RunnerConfig {
  slug: string;
  chatId: number;
  tz: string;
  port: number;
  operatorTasksUrl: string;
  tasksToken: string;
  telegramBotToken: string;
  journalDir: string;
  workspaceCwd: string;
  claudeHome: string;
  sessionIdFile: string;
}

export function loadRunnerConfig(): RunnerConfig {
  const claudeHome = process.env['CLAUDE_HOME'] ?? '/home/claude/.claude';
  return {
    slug: requireEnv('PERSON_SLUG'),
    chatId: Number(requireEnv('PERSON_CHAT_ID')),
    tz: process.env['TZ'] ?? 'Europe/Warsaw',
    port: Number(process.env['PORT'] ?? 8080),
    operatorTasksUrl: requireEnv('OPERATOR_TASKS_URL'),
    tasksToken: requireEnv('PERSON_TASKS_TOKEN'),
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    journalDir: process.env['JOURNAL_DIR'] ?? `${claudeHome}/pan-agent-journal`,
    workspaceCwd: process.env['WORKSPACE_CWD'] ?? '/home/claude/workspace',
    claudeHome,
    sessionIdFile: process.env['SESSION_ID_FILE'] ?? `${claudeHome}/pan-agent-session-id`,
  };
}
