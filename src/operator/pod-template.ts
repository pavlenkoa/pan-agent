/**
 * Per-person Pod spec (architecture doc section 3). Compiled into the
 * operator binary, not a manifest in git — image tag is the only thing
 * overridable via env (PERSON_POD_IMAGE).
 */
import type { V1Pod } from '@kubernetes/client-node';

import type { OperatorConfig } from './config.js';

export const RUNNER_PORT = 8080;

export function podName(slug: string): string {
  return `person-${slug}`;
}

function secretEnv(name: string, secretName: string, key: string) {
  return { name, valueFrom: { secretKeyRef: { name: secretName, key } } };
}

export function buildPersonPodSpec(
  cfg: OperatorConfig,
  slug: string,
  chatId: number,
  tz: string,
  tasksToken: string,
): V1Pod {
  const name = podName(slug);
  const peopleHome = `${cfg.nfsRootPath}/people/${slug}`;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: cfg.namespace,
      labels: {
        'app.kubernetes.io/name': 'pan-agent',
        'app.kubernetes.io/component': 'person-pod',
        'pan-agent.pavlenko.io/person': slug,
      },
    },
    spec: {
      restartPolicy: 'Always',
      nodeSelector: { 'kubernetes.io/hostname': cfg.nodeHostname },
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      containers: [
        {
          name: 'runner',
          image: cfg.image,
          imagePullPolicy: 'Always',
          command: ['node', 'dist/runner/index.js'],
          env: [
            { name: 'PERSON_SLUG', value: slug },
            { name: 'PERSON_CHAT_ID', value: String(chatId) },
            { name: 'PERSON_TASKS_TOKEN', value: tasksToken },
            { name: 'TZ', value: tz },
            { name: 'LANG', value: 'C.UTF-8' },
            { name: 'OPERATOR_TASKS_URL', value: `http://${cfg.operatorServiceHost}:${cfg.tasksApiPort}` },
            secretEnv('CLAUDE_CODE_OAUTH_TOKEN', 'pan-agent-anthropic', 'CLAUDE_CODE_OAUTH_TOKEN'),
            secretEnv('TELEGRAM_BOT_TOKEN', 'pan-agent-telegram', 'TELEGRAM_BOT_TOKEN'),
            secretEnv('TOLOKA_USERNAME', 'pan-agent-toloka', 'TOLOKA_USERNAME'),
            secretEnv('TOLOKA_PASSWORD', 'pan-agent-toloka', 'TOLOKA_PASSWORD'),
            secretEnv('EMBY_API_KEY', 'pan-agent-emby', 'EMBY_API_KEY'),
            secretEnv('TMDB_API_KEY', 'pan-agent-tmdb', 'TMDB_API_KEY'),
            secretEnv('GH_TOKEN', 'pan-agent-github', 'GH_TOKEN'),
            secretEnv('SEEDPOOL_API_KEY', 'pan-agent-seedpool', 'SEEDPOOL_API_KEY'),
          ],
          ports: [{ containerPort: RUNNER_PORT, name: 'http' }],
          resources: {
            requests: { cpu: '100m', memory: '512Mi' },
            limits: { cpu: '2', memory: '2Gi' },
          },
          readinessProbe: {
            httpGet: { path: '/healthz', port: RUNNER_PORT },
            initialDelaySeconds: 5,
            periodSeconds: 10,
            failureThreshold: 6,
          },
          volumeMounts: [
            { name: 'claude-home', mountPath: '/home/claude/.claude' },
            { name: 'workspace', mountPath: '/home/claude/workspace' },
            { name: 'tracking', mountPath: '/tracking' },
            { name: 'media', mountPath: '/media', subPath: 'emby' },
            { name: 'persona', mountPath: '/config', readOnly: true },
          ],
        },
      ],
      volumes: [
        { name: 'claude-home', nfs: { server: cfg.nfsServer, path: `${peopleHome}/claude` } },
        { name: 'workspace', nfs: { server: cfg.nfsServer, path: `${peopleHome}/workspace` } },
        { name: 'tracking', nfs: { server: cfg.nfsServer, path: `${cfg.nfsRootPath}/tracking` } },
        { name: 'media', persistentVolumeClaim: { claimName: cfg.mediaPvcName } },
        { name: 'persona', configMap: { name: cfg.personaConfigMapName } },
      ],
    },
  };
}
