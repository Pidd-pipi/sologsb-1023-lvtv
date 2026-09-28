import { effectScope } from 'vue';
import { useCollation } from '../src/composables/useCollation';

export const V1_KEY = 'sologsb-1023/multi-version-collation/v1';

/** 每个用例独立的 effect scope，避免 watcher 与 onMounted 互相干扰 */
export function makeStore() {
  const scope = effectScope();
  const store = scope.run(() => useCollation())!;
  return {
    ...store,
    dispose: () => scope.stop()
  };
}
