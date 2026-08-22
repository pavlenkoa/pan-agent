/**
 * Thin wrapper over @kubernetes/client-node. The operator's entire k8s
 * surface is CRUD (architecture doc section 2): create/get/list/delete Pod,
 * get/create/update ConfigMap. No informers, no watch, no generated
 * controller machinery.
 */
import { ApiException, CoreV1Api, KubeConfig, type V1ConfigMap, type V1Pod } from '@kubernetes/client-node';

export function makeCoreV1Api(): CoreV1Api {
  const kc = new KubeConfig();
  if (process.env['KUBERNETES_SERVICE_HOST']) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc.makeApiClient(CoreV1Api);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiException && err.code === 404;
}

export function isConflict(err: unknown): boolean {
  return err instanceof ApiException && err.code === 409;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

// ---------------------------------------------------------------------------
// ConfigMap JSON helpers — every person/task/index CM in this system stores
// one JSON blob under a single data key.
// ---------------------------------------------------------------------------

export interface JsonConfigMap<T> {
  value: T;
  resourceVersion: string;
}

export async function readJsonConfigMap<T>(
  api: CoreV1Api,
  namespace: string,
  name: string,
  dataKey: string,
): Promise<JsonConfigMap<T> | null> {
  let cm: V1ConfigMap;
  try {
    cm = await api.readNamespacedConfigMap({ name, namespace });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const raw = cm.data?.[dataKey];
  const resourceVersion = cm.metadata?.resourceVersion;
  if (raw === undefined || !resourceVersion) {
    throw new Error(`ConfigMap ${namespace}/${name} is missing data[${dataKey}] or resourceVersion`);
  }
  return { value: JSON.parse(raw) as T, resourceVersion };
}

export async function createJsonConfigMap<T>(
  api: CoreV1Api,
  namespace: string,
  name: string,
  dataKey: string,
  value: T,
  labels?: Record<string, string>,
): Promise<JsonConfigMap<T>> {
  const cm = await api.createNamespacedConfigMap({
    namespace,
    body: {
      metadata: { name, namespace, labels },
      data: { [dataKey]: JSON.stringify(value, null, 2) },
    },
  });
  const resourceVersion = cm.metadata?.resourceVersion;
  if (!resourceVersion) throw new Error(`create ${namespace}/${name} returned no resourceVersion`);
  return { value, resourceVersion };
}

/**
 * Replace a ConfigMap's JSON body, guarded by resourceVersion (optimistic
 * concurrency). Throws ConflictError on a stale write — the caller is
 * expected to re-read and retry (architecture doc section 4: the operator
 * is the only writer, so conflicts only happen across its own restart
 * races).
 */
export async function replaceJsonConfigMap<T>(
  api: CoreV1Api,
  namespace: string,
  name: string,
  dataKey: string,
  value: T,
  resourceVersion: string,
  labels?: Record<string, string>,
): Promise<JsonConfigMap<T>> {
  try {
    const cm = await api.replaceNamespacedConfigMap({
      name,
      namespace,
      body: {
        metadata: { name, namespace, resourceVersion, labels },
        data: { [dataKey]: JSON.stringify(value, null, 2) },
      },
    });
    const newResourceVersion = cm.metadata?.resourceVersion;
    if (!newResourceVersion) throw new Error(`replace ${namespace}/${name} returned no resourceVersion`);
    return { value, resourceVersion: newResourceVersion };
  } catch (err) {
    if (isConflict(err)) throw new ConflictError(`ConfigMap ${namespace}/${name} was updated concurrently`);
    throw err;
  }
}

/**
 * Read-modify-write a JSON ConfigMap, retrying on a resourceVersion
 * conflict. Creates the ConfigMap (via `makeDefault`) if absent.
 */
export async function updateJsonConfigMap<T>(
  api: CoreV1Api,
  namespace: string,
  name: string,
  dataKey: string,
  makeDefault: () => T,
  mutate: (current: T) => T,
  labels?: Record<string, string>,
  maxRetries = 5,
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const existing = await readJsonConfigMap<T>(api, namespace, name, dataKey);
    if (existing === null) {
      try {
        const created = await createJsonConfigMap(api, namespace, name, dataKey, mutate(makeDefault()), labels);
        return created.value;
      } catch (err) {
        // Lost a create race against another operator instance/restart — retry as an update.
        if (!(err instanceof ApiException && err.code === 409)) throw err;
        continue;
      }
    }
    try {
      const replaced = await replaceJsonConfigMap(
        api,
        namespace,
        name,
        dataKey,
        mutate(existing.value),
        existing.resourceVersion,
        labels,
      );
      return replaced.value;
    } catch (err) {
      if (err instanceof ConflictError) continue;
      throw err;
    }
  }
  throw new Error(`Giving up on ${namespace}/${name} after ${maxRetries} conflict retries`);
}

// ---------------------------------------------------------------------------
// Pods
// ---------------------------------------------------------------------------

export async function getPod(api: CoreV1Api, namespace: string, name: string): Promise<V1Pod | null> {
  try {
    return await api.readNamespacedPod({ name, namespace });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function listPersonPods(api: CoreV1Api, namespace: string): Promise<V1Pod[]> {
  const list = await api.listNamespacedPod({
    namespace,
    labelSelector: 'app.kubernetes.io/component=person-pod',
  });
  return list.items;
}

export async function createPod(api: CoreV1Api, namespace: string, pod: V1Pod): Promise<V1Pod> {
  return api.createNamespacedPod({ namespace, body: pod });
}

export async function deletePod(api: CoreV1Api, namespace: string, name: string): Promise<void> {
  try {
    await api.deleteNamespacedPod({ name, namespace });
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

export function isPodReady(pod: V1Pod): boolean {
  const conditions = pod.status?.conditions ?? [];
  return conditions.some((c) => c.type === 'Ready' && c.status === 'True');
}
