import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  ComparisonRules,
  Confirmation,
  ConfirmationInvalidReason,
  ConfirmationSnapshot,
  DifferenceStatus,
  PersistedCollationState,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';

const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国'
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function normalized(value: string, rules: ComparisonRules) {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (character) => variantMap[character] ?? character).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(/[\s，。！？；：、“”‘’「」『』（）()《》〈〉·,.!?;:'"[\]{}<>—\-…]/g, '');
  }
  return result;
}

function similarity(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function statusFor(left: TextUnit | undefined, right: TextUnit | undefined, ratio: number): DifferenceStatus {
  if (!left) return 'added';
  if (!right) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
}

async function alignUnits(
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  onProgress: (value: number) => void
): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftUnits.length || rightIndex < rightUnits.length) {
    const left = leftUnits[leftIndex];
    const right = rightUnits[rightIndex];

    if (!left) {
      rows.push(makeRow(undefined, right, rules, '自动补齐右侧新增内容'));
      rightIndex += 1;
    } else if (!right) {
      rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容'));
      leftIndex += 1;
    } else {
      const sameParagraph =
        left.paragraphOrder === right.paragraphOrder || Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;
      const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));
      const nextLeftRatio =
        leftUnits[leftIndex + 1] && right
          ? similarity(normalized(leftUnits[leftIndex + 1].text, rules), normalized(right.text, rules))
          : 0;
      const nextRightRatio =
        rightUnits[rightIndex + 1] && left
          ? similarity(normalized(left.text, rules), normalized(rightUnits[rightIndex + 1].text, rules))
          : 0;

      if (sameParagraph && (ratio >= 0.28 || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
        const score = Number(ratio.toFixed(3));
        rows.push({
          id: `row-${rows.length + 1}-${left.id}-${right.id}`,
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          note: '',
          source: '',
          accepted: false,
          manuallyAdjusted: false,
          confirmations: []
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules, '右侧有段落或句子插入'));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules, '左侧有段落或句子缺失'));
        leftIndex += 1;
      }
    }

    if (rows.length % 24 === 0) {
      onProgress(Math.round(((leftIndex + rightIndex) / Math.max(1, leftUnits.length + rightUnits.length)) * 100));
      await yieldToBrowser();
    }
  }
  onProgress(100);
  return rows;
}

function makeRow(
  left: TextUnit | undefined,
  right: TextUnit | undefined,
  rules: ComparisonRules,
  source: string
): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted: false,
    manuallyAdjusted: false,
    confirmations: []
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

/** 取某行当前的正文、校记与规则快照，供确认留痕和漂移比对 */
function takeSnapshot(row: AlignmentRow, rules: ComparisonRules): ConfirmationSnapshot {
  return {
    leftText: row.left?.text ?? '',
    rightText: row.right?.text ?? '',
    note: row.note,
    source: row.source,
    status: row.status,
    rules: clone(rules)
  };
}

export function latestConfirmation(row: AlignmentRow): Confirmation | undefined {
  return row.confirmations[row.confirmations.length - 1];
}

export type RowReviewState = 'active' | 'stale' | 'void' | 'none';

export function rowReviewState(row: AlignmentRow): RowReviewState {
  return latestConfirmation(row)?.state ?? 'none';
}

export const invalidReasonLabel: Record<ConfirmationInvalidReason, string> = {
  text: '正文或配对已变化',
  note: '校记或来源已补改',
  status: '判断类别已变化',
  rules: '比较规则已变化',
  alignment: '已重新执行自动对齐',
  legacy: '旧版本接受记录，缺少处理人与依据',
  withdrawn: '处理人撤回',
  superseded: '已被新的确认取代'
};

export function reviewStateLabel(state: RowReviewState): string {
  return { active: '有效', stale: '待复核', void: '已失效', none: '待处理' }[state];
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const handler = ref('');
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceRows = computed(() => rows.value.filter((row) => row.status !== 'same'));
  const differenceCount = computed(() => differenceRows.value.length);
  const activeRows = computed(() => differenceRows.value.filter((row) => rowReviewState(row) === 'active'));
  const staleRows = computed(() => rows.value.filter((row) => rowReviewState(row) === 'stale'));
  const voidConfirmationCount = computed(
    () => rows.value.reduce((total, row) => total + row.confirmations.filter((item) => item.state === 'void').length, 0)
  );
  const acceptedCount = computed(() => activeRows.value.length);
  const unresolvedCount = computed(
    () => differenceRows.value.filter((row) => rowReviewState(row) !== 'active').length
  );

  function syncAccepted(row: AlignmentRow) {
    row.accepted = rowReviewState(row) === 'active';
  }

  /** 比较确认时快照与当前状态，找出使该行回到待复核的变化 */
  function detectDrift(
    snapshot: ConfirmationSnapshot,
    row: AlignmentRow
  ): { reason: ConfirmationInvalidReason; detail: string } | null {
    if (snapshot.leftText !== (row.left?.text ?? '') || snapshot.rightText !== (row.right?.text ?? '')) {
      return { reason: 'text', detail: '确认后两侧正文或配对发生变化' };
    }
    if (snapshot.status !== row.status) {
      return { reason: 'status', detail: '确认后判断类别发生变化' };
    }
    if (snapshot.note !== row.note || snapshot.source !== row.source) {
      return { reason: 'note', detail: '确认后校记或来源被补改' };
    }
    const currentRules = rules.value;
    if (
      snapshot.rules.ignorePunctuation !== currentRules.ignorePunctuation ||
      snapshot.rules.ignoreVariants !== currentRules.ignoreVariants ||
      snapshot.rules.candidateWindow !== currentRules.candidateWindow
    ) {
      return { reason: 'rules', detail: '确认后比较规则发生变化' };
    }
    return null;
  }

  /**
   * 全量复核：仍有效的确认，只要确认时的正文、校记、类别或规则任一项变化，
   * 就回到待复核；已失效/已取代的旧记录保持原样，不自动复活。
   */
  function reevaluateConfirmations(
    forced?: { rowIds: string[]; reason: ConfirmationInvalidReason; detail: string }
  ) {
    const forcedIds = new Set(forced?.rowIds ?? []);
    const now = new Date().toISOString();
    rows.value.forEach((row) => {
      const current = latestConfirmation(row);
      if (!current || current.state !== 'active') return;
      if (forced && forcedIds.has(row.id)) {
        current.state = 'stale';
        current.invalidReason = forced.reason;
        current.invalidDetail = forced.detail;
        current.invalidAt = now;
      } else {
        const drift = detectDrift(current.snapshot, row);
        if (drift) {
          current.state = 'stale';
          current.invalidReason = drift.reason;
          current.invalidDetail = drift.detail;
          current.invalidAt = now;
        }
      }
      syncAccepted(row);
    });
  }

  function snapshot(): string {
    const data: PersistedCollationState = {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value,
      handler: handler.value
    };
    return JSON.stringify(data);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, snapshot());
  }

  function commit(
    label: string,
    mutate: () => void,
    drift?: { rowIds: string[]; reason: ConfirmationInvalidReason; detail: string }
  ) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    reevaluateConfirmations(drift);
    message.value = label;
    persist();
  }

  function migrateRow(row: AlignmentRow) {
    if (!Array.isArray(row.confirmations)) {
      row.confirmations = [];
      // 旧版本只有 accepted 布尔标记，无法还原处理人与依据，一律回到待复核
      if (row.accepted) {
        row.confirmations.push({
          id: `confirm-legacy-${row.id}`,
          handler: '（旧记录，处理人未详）',
          basis: row.note,
          source: row.source,
          createdAt: '',
          state: 'stale',
          snapshot: takeSnapshot(row, rules.value),
          invalidReason: 'legacy',
          invalidDetail: '旧版本遗留的已接受标记，缺少处理人与依据，请补写后重新确认',
          invalidAt: ''
        });
      }
      syncAccepted(row);
    }
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState;
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rows.value = parsed.rows;
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
    handler.value = parsed.handler ?? '';
    rows.value.forEach((row) => migrateRow(row));
    reevaluateConfirmations();
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    restore(previous);
    message.value = '已撤销上一步操作';
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    restore(next);
    message.value = '已重做上一步操作';
  }

  /** 重新对齐后，把相同配对上的旧确认记录带到新行，并标记为待复核 */
  function carryConfirmations(previousRows: AlignmentRow[], nextRows: AlignmentRow[]) {
    const exactLedger = new Map<string, AlignmentRow>();
    const leftLedger = new Map<string, AlignmentRow>();
    const rightLedger = new Map<string, AlignmentRow>();
    previousRows.forEach((row) => {
      if (!latestConfirmation(row)) return;
      exactLedger.set(`${row.left?.id ?? ''}|${row.right?.id ?? ''}`, row);
      if (row.left) leftLedger.set(row.left.id, row);
      if (row.right) rightLedger.set(row.right.id, row);
    });
    if (!exactLedger.size && !leftLedger.size && !rightLedger.size) return;
    const now = new Date().toISOString();
    const carriedRows = new Set<AlignmentRow>();
    nextRows.forEach((row) => {
      // 优先两侧都相同的配对；其次单侧句段仍在本行（曾为新增/删减或重新对齐改变配对）
      const previous =
        exactLedger.get(`${row.left?.id ?? ''}|${row.right?.id ?? ''}`) ??
        (row.left ? leftLedger.get(row.left.id) : undefined) ??
        (row.right ? rightLedger.get(row.right.id) : undefined);
      if (!previous || carriedRows.has(previous)) return;
      carriedRows.add(previous);
      row.note = previous.note;
      row.source = previous.source;
      row.manuallyAdjusted = previous.manuallyAdjusted;
      row.confirmations = clone(previous.confirmations);
      const current = latestConfirmation(row);
      if (current && current.state !== 'void') {
        current.state = 'stale';
        current.invalidReason = 'alignment';
        current.invalidDetail = '确认后重新执行过自动对齐，请复核配对与判断';
        current.invalidAt = now;
      }
      syncAccepted(row);
    });
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : '';
    const previousRows = rows.value;
    try {
      const result = await alignUnits(leftVersion.value.units, rightVersion.value.units, rules.value, (value) => {
        progress.value = value;
      });
      if (commitHistory) {
        history.value.push(previous);
        future.value = [];
      }
      carryConfirmations(previousRows, result);
      rows.value = result;
      selectedRowId.value = result.find((row) => row.status !== 'same' && rowReviewState(row) !== 'active')?.id ?? result[0]?.id ?? '';
      selectedRowIds.value = [];
      const carried = result.filter((row) => rowReviewState(row) === 'stale').length;
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异${
        carried ? `，${carried} 条旧确认回到待复核` : ''
      }`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  function recalculate() {
    commit('已按比较规则重算差异，规则状态变化的确认回到待复核', () => {
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right) return row;
        const score = Number(
          similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
        );
        return { ...row, similarity: score, status: statusFor(row.left, row.right, score) };
      });
      selectedRowIds.value = [];
    });
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行，受影响的确认回到待复核', () => {
      const row = rows.value.find((item) => item.id === id);
      if (!row) return;
      const { confirmations: _ignored, accepted: _accepted, ...safePatch } = patch;
      Object.assign(row, safePatch, { manuallyAdjusted: true });
    });
  }

  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整错位，相关确认回到待复核' : '已向后调整错位，相关确认回到待复核', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const current = rows.value[index];
      const target = rows.value[targetIndex];
      const currentLeft = current.left;
      current.left = target.left;
      target.left = currentLeft;
      for (const row of [current, target]) {
        if (row.left && row.right) {
          row.similarity = Number(
            similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
          );
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
      }
    }, {
      rowIds: [currentId(id, rows.value), currentId(id, rows.value, direction)].filter(Boolean),
      reason: 'text',
      detail: '确认后挪动过配对关系，底本侧正文发生变化'
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动校勘顺序（行内配对未变，确认仍有效）', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [row] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, row);
      row.manuallyAdjusted = true;
    });
  }

  /**
   * 确认一行或多行：留下处理人、依据及当时两侧正文/校记/类别/规则快照。
   * 未写明依据（校记）的行会跳过；重新确认时旧记录标记为已取代并保留。
   */
  function confirmRows(
    ids: string[],
    confirmHandler: string,
    basisOverride?: string
  ): { confirmed: number; skipped: number } {
    const selected = new Set(ids);
    let confirmed = 0;
    let skipped = 0;
    handler.value = confirmHandler;
    commit(`已确认校勘判断，处理人：${confirmHandler}`, () => {
      const now = new Date().toISOString();
      rows.value.forEach((row) => {
        if (!selected.has(row.id)) return;
        const basis = (basisOverride ?? row.note).trim();
        if (!basis) {
          skipped += 1;
          return;
        }
        if (basisOverride !== undefined) row.note = basisOverride.trim();
        row.source = row.source.trim();
        const previous = latestConfirmation(row);
        if (previous && previous.state !== 'void') {
          previous.state = 'void';
          previous.invalidReason = 'superseded';
          previous.invalidDetail = '处理人依据最新复核重新确认，旧记录归档保留';
          previous.invalidAt = now;
        }
        row.confirmations.push({
          id: `confirm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          handler: confirmHandler,
          basis,
          source: row.source,
          createdAt: now,
          state: 'active',
          snapshot: takeSnapshot(row, rules.value)
        });
        row.accepted = true;
        confirmed += 1;
      });
      selectedRowIds.value = [];
    });
    return { confirmed, skipped };
  }

  /** 撤回确认：当前记录标记为已失效（撤回），记录本身保留 */
  function withdrawConfirmation(id: string) {
    commit('已撤回确认，旧记录标记为已失效并保留', () => {
      const row = rows.value.find((item) => item.id === id);
      const current = row ? latestConfirmation(row) : undefined;
      if (row && current && current.state !== 'void') {
        current.state = 'void';
        current.invalidReason = 'withdrawn';
        current.invalidDetail = '处理人主动撤回确认';
        current.invalidAt = new Date().toISOString();
        syncAccepted(row);
      }
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (row && row.status !== 'same' && rowReviewState(row) !== 'active') {
        selectedRowId.value = row.id;
        message.value = `已跳到第 ${index + 1} 条待复核差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多待复核的差异';
  }

  function addVersion(name: string, source: string, text: string) {
    const id = `version-${Date.now().toString(36)}`;
    const item: VersionDocument = {
      id,
      name: name.trim() || `版本 ${versions.value.length + 1}`,
      source: source.trim() || '手工导入',
      text,
      units: splitIntoUnits(text, id),
      createdAt: new Date().toISOString()
    };
    commit(`已导入版本：${item.name}`, () => {
      versions.value.push(item);
    });
    rightVersionId.value = id;
    void runAlignment();
  }

  function exportMarkdown() {
    const changed = rows.value.filter((row) => row.status !== 'same' || row.note || row.source);
    const activeTotal = rows.value.filter((row) => rowReviewState(row) === 'active').length;
    const staleTotal = rows.value.filter((row) => rowReviewState(row) === 'stale').length;
    const noneTotal = rows.value.filter(
      (row) => row.status !== 'same' && rowReviewState(row) === 'none'
    ).length;
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 确认统计：有效 ${activeTotal} 条 · 待复核 ${staleTotal} 条 · 待处理 ${noneTotal} 条 · 已失效归档 ${voidConfirmationCount.value} 条`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 序 | 类别 | 底本 | 参校本 | 校记（依据） | 来源 | 处理人 | 确认状态 |',
      '|---|---|---|---|---|---|---|---|'
    ];
    changed.forEach((row, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      const current = latestConfirmation(row);
      const state = rowReviewState(row);
      let stateCell: string;
      if (current && (state === 'active' || state === 'stale')) {
        stateCell = `${reviewStateLabel(state)}（${current.handler}${
          current.createdAt ? ` · ${new Date(current.createdAt).toLocaleString('zh-CN')}` : ''
        }）`;
        if (state === 'stale' && current.invalidReason) {
          stateCell += `<br/>复核原因：${invalidReasonLabel[current.invalidReason]}`;
        }
      } else if (state === 'void' && current) {
        stateCell = `已失效（${invalidReasonLabel[current.invalidReason ?? 'withdrawn']}）`;
      } else {
        stateCell = '待处理';
      }
      lines.push(
        `| ${index + 1} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(
          current?.basis ?? row.note
        )} | ${cell(row.source)} | ${cell(current?.handler)} | ${stateCell} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);

    const archived = rows.value.flatMap((row) =>
      row.confirmations
        .filter((item) => item.state === 'void')
        .map((item) => ({ row, item }))
    );
    if (archived.length) {
      lines.push(
        '',
        '## 已失效确认归档',
        '',
        '> 以下旧确认已被撤回、被新确认取代或因重新对齐失效，仅作交接留痕，不作为定稿依据。',
        '',
        '| 处理人 | 时间 | 依据 | 失效原因 | 底本 | 参校本 |',
        '|---|---|---|---|---|---|'
      );
      archived.forEach(({ row, item }) => {
        const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
        lines.push(
          `| ${cell(item.handler)} | ${item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '时间未详'} | ${cell(
            item.basis
          )} | ${invalidReasonLabel[item.invalidReason ?? 'withdrawn']} | ${cell(row.left?.text)} | ${cell(
            row.right?.text
          )} |`
        );
      });
    }
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        handler: handler.value,
        summary: {
          differences: differenceCount.value,
          active: acceptedCount.value,
          stale: staleRows.value.length,
          pending: differenceRows.value.filter((row) => rowReviewState(row) === 'none').length,
          void: voidConfirmationCount.value
        },
        rows: rows.value.map((row) => ({
          ...row,
          reviewState: rowReviewState(row),
          latestConfirmation: latestConfirmation(row) ?? null
        })),
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  function bootstrap() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿';
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        void runAlignment(false);
      }
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    }
  }

  onMounted(bootstrap);

  watch(
    [
      leftVersionId,
      rightVersionId,
      handler,
      () => rules.value.ignorePunctuation,
      () => rules.value.ignoreVariants
    ],
    () => {
      if (!processing.value) persist();
    }
  );

  return {
    versions,
    leftVersionId,
    rightVersionId,
    rows,
    rules,
    selectedRowId,
    selectedRowIds,
    handler,
    processing,
    progress,
    message,
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    acceptedCount,
    staleCount: computed(() => staleRows.value.length),
    voidConfirmationCount,
    unresolvedCount,
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    confirmRows,
    withdrawConfirmation,
    nextDifference,
    addVersion,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    commit,
    bootstrap
  };
}

function currentId(target: string, list: AlignmentRow[], offset = 0) {
  const index = list.findIndex((row) => row.id === target);
  return list[index + offset]?.id ?? '';
}

export function statusLabel(status: DifferenceStatus) {
  return {
    same: '相同',
    changed: '改动',
    added: '右侧新增',
    removed: '左侧删减',
    misaligned: '疑错位'
  }[status];
}
