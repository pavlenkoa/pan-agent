import { describe, expect, it } from 'vitest';

import type { CustomEnvVar } from '../shared/types.js';
import { buildPersonPodSpec, RESERVED_ENV_NAMES } from './pod-template.js';

const cfg = {
  namespace: 'pan-agent',
  image: 'ghcr.io/pavlenkoa/pan-agent:latest',
  nfsServer: '192.168.88.3',
  nfsRootPath: '/media/pan-agent',
  nodeHostname: 'macmini',
  mediaPvcName: 'pan-agent-media-nfs',
  personaConfigMapName: 'pan-agent-persona',
  operatorServiceHost: 'pan-agent-operator.pan-agent.svc',
  tasksApiPort: 8081,
} as unknown as import('./config.js').OperatorConfig;

function envMap(pod: ReturnType<typeof buildPersonPodSpec>): Map<string, unknown> {
  const env = pod.spec?.containers?.[0]?.env ?? [];
  return new Map(env.map((e) => [e.name, 'value' in e ? e.value : e.valueFrom]));
}

describe('buildPersonPodSpec — custom env vars', () => {
  it('includes a custom var as a real env entry', () => {
    const customEnv: Record<string, CustomEnvVar> = {
      ESPUTNIK_TOKEN: { value: 'abc123', description: 'for sending SMS', setAt: '2026-08-23T00:00:00.000Z' },
    };
    const pod = buildPersonPodSpec(cfg, 'andrii', 1, 'UTC', 'tasks-token', customEnv);
    expect(envMap(pod).get('ESPUTNIK_TOKEN')).toBe('abc123');
  });

  it('drops a custom var whose name collides with a reserved system name', () => {
    const customEnv: Record<string, CustomEnvVar> = {
      GH_TOKEN: { value: 'evil', description: 'attempted override', setAt: '2026-08-23T00:00:00.000Z' },
    };
    const pod = buildPersonPodSpec(cfg, 'andrii', 1, 'UTC', 'tasks-token', customEnv);
    // The real GH_TOKEN entry must still be the operator's secretEnv, not the plain string "evil".
    const gh = pod.spec?.containers?.[0]?.env?.find((e) => e.name === 'GH_TOKEN');
    expect(gh?.value).toBeUndefined();
    expect(gh?.valueFrom?.secretKeyRef?.name).toBe('pan-agent-github');
  });

  it('publishes name+description (never the value) in PERSON_CUSTOM_VARS_DOC', () => {
    const customEnv: Record<string, CustomEnvVar> = {
      ESPUTNIK_TOKEN: { value: 'abc123', description: 'for sending SMS', setAt: '2026-08-23T00:00:00.000Z' },
    };
    const pod = buildPersonPodSpec(cfg, 'andrii', 1, 'UTC', 'tasks-token', customEnv);
    const doc = envMap(pod).get('PERSON_CUSTOM_VARS_DOC') as string;
    expect(JSON.parse(doc)).toEqual([{ name: 'ESPUTNIK_TOKEN', description: 'for sending SMS' }]);
    expect(doc).not.toContain('abc123');
  });

  it('produces an empty doc and no extra env entries when no custom vars are set', () => {
    const pod = buildPersonPodSpec(cfg, 'andrii', 1, 'UTC', 'tasks-token');
    expect(JSON.parse(envMap(pod).get('PERSON_CUSTOM_VARS_DOC') as string)).toEqual([]);
  });

  it('RESERVED_ENV_NAMES covers every literal name already used in the pod spec', () => {
    for (const name of ['PERSON_SLUG', 'PERSON_CHAT_ID', 'PERSON_TASKS_TOKEN', 'TZ', 'LANG', 'GH_TOKEN']) {
      expect(RESERVED_ENV_NAMES.has(name)).toBe(true);
    }
  });
});
