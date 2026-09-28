import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  ComparisonRules,
  ConfirmationRecord,
  ConfirmationState,
  DifferenceStatus,
  PersistedCollationState,
  ReviewReason,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v2';
const EDITOR_STORAGE_KEY = 'sologsb-1023/multi-version-collation/editor';

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

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
          id: uid('row'),
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          note: '',
          basis: '',
          source: '',
          manuallyAdjusted: false
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules, '自动标记右侧插入内容'));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容'));
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
    id: uid('row'),
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    basis: '',
    source,
    manuallyAdjusted: false
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

/** 以句段 id 配对为键，在重新对齐后把确认档案带到新行 */
function pairingKey(left?: TextUnit, right?: TextUnit) {
  return `${left?.id ?? '∅'}|${right?.id ?? '∅'}`;
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const editorName = ref('');
  /** rowId -> 该条配对行历次确认档案，最后一条是当前有效/待复核档案 */
  const confirmations = ref<Record<string, ConfirmationRecord[]>>({});
  /** 重新对齐后失去配对行的确认档案，仍随数据导出 */
  const archivedConfirmations = ref<ConfirmationRecord[]>([]);
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);

  const activeConfirmation = (rowId: string) => {
    const list = confirmations.value[rowId];
    return list && list.length ? list[list.length - 1] : undefined;
  };

  const confirmationState = (rowId: string): ConfirmationState | undefined => activeConfirmation(rowId)?.state;

  const validCount = computed(
    () => rows.value.filter((row) => activeConfirmation(row.id)?.state === 'valid').length
  );
  const reviewCount = computed(
    () => rows.value.filter((row) => activeConfirmation(row.id)?.state === 'review').length
  );
  /** 待处理：有差异且尚无有效确认 */
  const unresolvedCount = computed(
    () =>
      rows.value.filter((row) => {
        if (row.status === 'same') return false;
        const state = activeConfirmation(row.id)?.state;
        return state !== 'valid';
      }).length
  );

  function snapshot(): string {
    const data: PersistedCollationState = {
      version: 2,
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value,
      editorName: editorName.value,
      confirmations: confirmations.value,
      archivedConfirmations: archivedConfirmations.value
    };
    return JSON.stringify(data);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, snapshot());
    localStorage.setItem(EDITOR_STORAGE_KEY, editorName.value);
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    refreshConfirmationStates();
    message.value = label;
    persist();
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState;
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rules.value = parsed.rules ?? defaultRules();
    rows.value = (parsed.rows ?? []).map((row) =>
      row.basis === undefined ? { ...row, basis: '' } : row
    );
    selectedRowId.value = parsed.selectedRowId ?? '';
    editorName.value = parsed.editorName ?? localStorage.getItem(EDITOR_STORAGE_KEY) ?? '';
    if (parsed.version === 2) {
      confirmations.value = parsed.confirmations ?? {};
      archivedConfirmations.value = parsed.archivedConfirmations ?? [];
    } else {
      // v1：旧 accepted 标记迁移成确认档案，处理人与依据待补录，先按现场判定状态
      const migrated = migrateLegacyConfirmations(rows.value, rules.value);
      confirmations.value = migrated;
      archivedConfirmations.value = [];
    }
    rows.value.forEach((row) => {
      delete (row as Partial<AlignmentRow> & { accepted?: boolean }).accepted;
    });
    refreshConfirmationStates();
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

  /** v1 的 accepted:true 迁移成待补录的确认档案 */
  function migrateLegacyConfirmations(
    targetRows: AlignmentRow[],
    currentRules: ComparisonRules
  ): Record<string, ConfirmationRecord[]> {
    const map: Record<string, ConfirmationRecord[]> = {};
    targetRows.forEach((row) => {
      if (!row.accepted) return;
      map[row.id] = [
        {
          id: uid('confirm'),
          rowId: row.id,
          editor: '',
          basis: '',
          confirmedAt: new Date(0).toISOString(),
          leftSnapshot: { unitId: row.left?.id, text: row.left?.text ?? '' },
          rightSnapshot: { unitId: row.right?.id, text: row.right?.text ?? '' },
          statusSnapshot: row.status,
          rulesSnapshot: { ...currentRules },
          noteSnapshot: row.note,
          sourceSnapshot: row.source,
          state: 'review',
          reviewReasons: [],
          migrated: true
        }
      ];
    });
    return map;
  }

  /** 现场与确认快照比对：两侧正文、配对、规则、校记任一变化即进入待复核 */
  function reviewReasonsFor(row: AlignmentRow, record: ConfirmationRecord): ReviewReason[] {
    const reasons = new Set<ReviewReason>();
    if (record.migrated) reasons.add('manual');
    if (row.left?.id !== record.leftSnapshot.unitId || (row.left?.text ?? '') !== record.leftSnapshot.text) {
      reasons.add('text');
    }
    if (row.right?.id !== record.rightSnapshot.unitId || (row.right?.text ?? '') !== record.rightSnapshot.text) {
      reasons.add('text');
    }
    if (
      rules.value.ignorePunctuation !== record.rulesSnapshot.ignorePunctuation ||
      rules.value.ignoreVariants !== record.rulesSnapshot.ignoreVariants
    ) {
      reasons.add('rules');
    }
    if (
      row.note !== record.noteSnapshot ||
      row.source !== record.sourceSnapshot ||
      row.basis !== record.basis
    ) {
      reasons.add('annotation');
    }
    if (row.status !== record.statusSnapshot) {
      reasons.add('judgment');
    }
    return [...reasons];
  }

  /** 不改动档案内容，只按当前现场重算 valid / review 状态；旧记录原样保留 */
  function refreshConfirmationStates(changedRowIds?: Set<string>) {
    rows.value.forEach((row) => {
      const list = confirmations.value[row.id];
      if (!list || !list.length) return;
      const record = list[list.length - 1];
      if (record.state === 'invalidated') return;
      if (changedRowIds && !changedRowIds.has(row.id)) return;
      const reasons = reviewReasonsFor(row, record);
      if (reasons.length === 0 && record.state !== 'valid') {
        record.state = 'valid';
        record.reviewReasons = [];
        record.reviewedAt = undefined;
      } else if (reasons.length > 0) {
        record.state = 'review';
        record.reviewReasons = reasons;
        record.reviewedAt ??= new Date().toISOString();
      }
    });
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : '';
    try {
      const result = await alignUnits(leftVersion.value.units, rightVersion.value.units, rules.value, (value) => {
        progress.value = value;
      });
      carryOverConfirmations(result);
      if (commitHistory) {
        history.value.push(previous);
        future.value = [];
      }
      rows.value = result;
      selectedRowId.value = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      refreshConfirmationStates();
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异，确认档案已按配对续接`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  /** 重新对齐：同一对句段的档案带到新行并按新现场复核，其余（含失效档案）归档留痕 */
  function carryOverConfirmations(newRows: AlignmentRow[]) {
    const byKey = new Map<string, AlignmentRow>();
    newRows.forEach((row) => byKey.set(pairingKey(row.left, row.right), row));
    const archive: ConfirmationRecord[] = [...archivedConfirmations.value];
    const next: Record<string, ConfirmationRecord[]> = {};

    Object.entries(confirmations.value).forEach(([oldRowId, list]) => {
      const latest = list[list.length - 1];
      if (!latest) return;
      const key = `${latest.leftSnapshot.unitId ?? '∅'}|${latest.rightSnapshot.unitId ?? '∅'}`;
      const target = latest.state !== 'invalidated' ? byKey.get(key) : undefined;
      if (target) {
        next[target.id] = list.map((item) =>
          item.state === 'invalidated' ? item : { ...item, rowId: target.id }
        );
      } else {
        archive.push(
          ...list.map((item) =>
            item.state === 'invalidated'
              ? item
              : {
                  ...item,
                  rowId: oldRowId,
                  state: 'review' as const,
                  reviewReasons: Array.from(new Set([...item.reviewReasons, 'superseded' as ReviewReason])),
                  reviewedAt: item.reviewedAt ?? new Date().toISOString()
                }
          )
        );
      }
    });
    confirmations.value = next;
    archivedConfirmations.value = archive;
  }

  function recalculate() {
    commit('已按比较规则重算差异，受影响的确认回到待复核', () => {
      const touched = new Set<string>();
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right) return row;
        const score = Number(
          similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
        );
        if (score !== row.similarity) touched.add(row.id);
        return { ...row, similarity: score, status: statusFor(row.left, row.right, score) };
      });
      // 规则变化本身会触发所有有效确认待复核
      Object.keys(confirmations.value).forEach((id) => touched.add(id));
      refreshConfirmationStates(touched);
    });
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行，相关确认已回到待复核', () => {
      const row = rows.value.find((item) => item.id === id);
      if (!row) return;
      Object.assign(row, patch, { manuallyAdjusted: true });
      refreshConfirmationStates(new Set([id]));
    });
  }

  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整配对，相关确认回到待复核' : '已向后调整配对，相关确认回到待复核', () => {
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
      refreshConfirmationStates(new Set([current.id, target.id]));
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动校勘行顺序', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [row] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, row);
      row.manuallyAdjusted = true;
    });
  }

  function buildConfirmation(row: AlignmentRow, basis: string): ConfirmationRecord {
    return {
      id: uid('confirm'),
      rowId: row.id,
      editor: editorName.value.trim(),
      basis: basis.trim(),
      confirmedAt: new Date().toISOString(),
      leftSnapshot: { unitId: row.left?.id, text: row.left?.text ?? '' },
      rightSnapshot: { unitId: row.right?.id, text: row.right?.text ?? '' },
      statusSnapshot: row.status,
      rulesSnapshot: { ...rules.value },
      noteSnapshot: row.note,
      sourceSnapshot: row.source,
      state: 'valid',
      reviewReasons: []
    };
  }

  /** 确认一行：处理人与依据必填；旧档案作废保留 */
  function confirmRow(rowId: string, basis: string): { ok: boolean; reason?: string } {
    const row = rows.value.find((item) => item.id === rowId);
    if (!row) return { ok: false, reason: '未找到对应行' };
    if (!editorName.value.trim()) return { ok: false, reason: '请先填写处理人署名' };
    if (!basis.trim()) return { ok: false, reason: '确认依据不能为空' };

    commit(`已确认 ${row.left?.text?.slice(0, 8) ?? ''}… 一行`, () => {
      row.basis = basis.trim();
      const list = confirmations.value[row.id] ?? [];
      list.forEach((item) => {
        if (item.state !== 'invalidated') {
          item.state = 'invalidated';
          item.invalidatedAt = new Date().toISOString();
        }
      });
      list.push(buildConfirmation(row, basis));
      confirmations.value[row.id] = list;
    });
    return { ok: true };
  }

  /**
   * 批量确认：只覆盖当前搜索结果（传入的候选行）中已写明依据的条目。
   * 返回实际确认与因缺依据/缺署名而跳过的行。
   */
  function confirmRows(candidateIds: string[]): { confirmed: AlignmentRow[]; skipped: AlignmentRow[] } {
    const candidates = new Set(candidateIds);
    const targets = rows.value.filter((row) => candidates.has(row.id) && row.basis.trim());
    const skipped = rows.value.filter((row) => candidates.has(row.id) && !row.basis.trim());
    if (!editorName.value.trim()) {
      return { confirmed: [], skipped: rows.value.filter((row) => candidates.has(row.id)) };
    }
    if (!targets.length) return { confirmed: [], skipped };

    const nowIso = new Date().toISOString();
    commit(`已批量确认 ${targets.length} 条写有依据的条目`, () => {
      targets.forEach((row) => {
        const list = confirmations.value[row.id] ?? [];
        list.forEach((item) => {
          if (item.state !== 'invalidated') {
            item.state = 'invalidated';
            item.invalidatedAt = nowIso;
          }
        });
        list.push(buildConfirmation(row, row.basis));
        confirmations.value[row.id] = list;
      });
    });
    return { confirmed: targets, skipped };
  }

  /** 撤回确认：当前档案标记失效并保留 */
  function withdrawConfirmation(rowId: string) {
    commit('已撤回确认，旧记录保留备查', () => {
      const list = confirmations.value[rowId];
      const record = list?.[list.length - 1];
      if (!record || record.state === 'invalidated') return;
      record.state = 'invalidated';
      record.invalidatedAt = new Date().toISOString();
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (!row || row.status === 'same') continue;
      if (activeConfirmation(row.id)?.state === 'valid') continue;
      selectedRowId.value = row.id;
      message.value = `已跳到第 ${index + 1} 条待复核/待处理差异`;
      persist();
      return;
    }
    message.value = '没有更多待复核或待处理的差异';
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
    const exportable = rows.value.filter((row) => row.status !== 'same' || row.note || row.source || row.basis);
    const stateLabel = (row: AlignmentRow) => {
      const state = activeConfirmation(row.id)?.state;
      return state === 'valid' ? '✅ 有效' : state === 'review' ? '⚠️ 待复核' : '⏳ 待处理';
    };
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      `- 确认统计：有效 ${validCount.value} 条 · 待复核 ${reviewCount.value} 条 · 待处理 ${unresolvedCount.value - reviewCount.value} 条`,
      '',
      '| 序 | 类别 | 底本 | 参校本 | 校记 | 来源 | 确认依据 | 处理人 | 确认时间 | 确认状态 |',
      '|---|---|---|---|---|---|---|---|---|---|'
    ];
    exportable.forEach((row, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      const record = activeConfirmation(row.id);
      lines.push(
        `| ${index + 1} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(row.note)} | ${cell(row.source)} | ${cell(row.basis)} | ${cell(record?.editor)} | ${record ? new Date(record.confirmedAt).toLocaleString('zh-CN') : ''} | ${stateLabel(row)} |`
      );
    });
    lines.push('', `共 ${exportable.length} 条校勘记录（不含完全相同且无校记者）。`);

    const historyLines = renderInvalidatedHistory();
    if (historyLines.length) {
      lines.push('', '## 已失效 / 归档的确认记录', '', ...historyLines);
    }
    return lines.join('\n');
  }

  function renderInvalidatedHistory(): string[] {
    const invalidated: ConfirmationRecord[] = [];
    Object.values(confirmations.value).forEach((list) => {
      list.forEach((item) => {
        if (item.state === 'invalidated') invalidated.push(item);
      });
    });
    const archived = archivedConfirmations.value;
    if (!invalidated.length && !archived.length) return [];
    const lines = [
      '| 处理人 | 依据 | 确认时间 | 当时底本 | 当时参校本 | 状态 | 说明 |',
      '|---|---|---|---|---|---|---|'
    ];
    const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
    invalidated.forEach((item) => {
      lines.push(
        `| ${cell(item.editor)} | ${cell(item.basis)} | ${new Date(item.confirmedAt).toLocaleString('zh-CN')} | ${cell(item.leftSnapshot.text)} | ${cell(item.rightSnapshot.text)} | 已失效 | 被后续确认取代或撤回 |`
      );
    });
    archived.forEach((item) => {
      const label = item.state === 'review' ? '待复核（配对已消失）' : '已失效';
      lines.push(
        `| ${cell(item.editor)} | ${cell(item.basis)} | ${new Date(item.confirmedAt).toLocaleString('zh-CN')} | ${cell(item.leftSnapshot.text)} | ${cell(item.rightSnapshot.text)} | ${label} | 重新对齐后原配对不存在，记录归档 |`
      );
    });
    return lines;
  }

  function exportJson() {
    const payloadRows = rows.value.map((row) => {
      const record = activeConfirmation(row.id);
      return {
        ...row,
        confirmation: record
          ? {
              id: record.id,
              editor: record.editor,
              basis: record.basis,
              confirmedAt: record.confirmedAt,
              state: record.state,
              reviewReasons: record.reviewReasons,
              reviewedAt: record.reviewedAt,
              snapshot: {
                left: record.leftSnapshot,
                right: record.rightSnapshot,
                status: record.statusSnapshot,
                rules: record.rulesSnapshot,
                note: record.noteSnapshot,
                source: record.sourceSnapshot
              }
            }
          : null
      };
    });
    const invalidated: ConfirmationRecord[] = [];
    Object.values(confirmations.value).forEach((list) => {
      list.forEach((item) => {
        if (item.state === 'invalidated') invalidated.push(item);
      });
    });
    return JSON.stringify(
      {
        schema: 'collation-v2',
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        editorName: editorName.value,
        summary: {
          rows: rows.value.length,
          valid: validCount.value,
          review: reviewCount.value,
          pending: unresolvedCount.value - reviewCount.value
        },
        rows: payloadRows,
        invalidatedConfirmations: invalidated,
        archivedConfirmations: archivedConfirmations.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  onMounted(() => {
    editorName.value = localStorage.getItem(EDITOR_STORAGE_KEY) ?? '';
    try {
      // 优先读 v2 数据；旧版（v1）草稿存在另一个键下，读取后自动迁移
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('sologsb-1023/multi-version-collation/v1');
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
  });

  watch(
    [leftVersionId, rightVersionId, () => rules.value.ignorePunctuation, () => rules.value.ignoreVariants],
    () => {
      if (!processing.value) persist();
    }
  );
  watch(editorName, () => persist());

  return {
    versions,
    leftVersionId,
    rightVersionId,
    rows,
    rules,
    selectedRowId,
    processing,
    progress,
    message,
    editorName,
    confirmations,
    archivedConfirmations,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    validCount,
    reviewCount,
    unresolvedCount,
    activeConfirmation,
    confirmationState,
    refreshConfirmationStates,
    restore,
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    confirmRow,
    confirmRows,
    withdrawConfirmation,
    nextDifference,
    addVersion,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    commit
  };
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

export function confirmationStateLabel(state: ConfirmationState) {
  return { valid: '有效', review: '待复核', invalidated: '已失效' }[state];
}

export function reviewReasonLabel(reason: ReviewReason) {
  return {
    text: '两侧正文或配对已变化',
    rules: '比较规则已变化',
    annotation: '校记、来源或依据已变化',
    manual: '旧版确认，处理人与依据待补录',
    judgment: '差异判断类别已变化',
    superseded: '原配对在重新对齐后消失'
  }[reason];
}
