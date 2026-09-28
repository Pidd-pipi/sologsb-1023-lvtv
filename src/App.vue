<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import {
  invalidReasonLabel,
  latestConfirmation,
  reviewStateLabel,
  rowReviewState,
  statusLabel,
  useCollation
} from './composables/useCollation';
import type { RowReviewState } from './composables/useCollation';
import type { AlignmentRow, DifferenceStatus } from './types';

const {
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
  canUndo,
  canRedo,
  selectedRow,
  differenceCount,
  acceptedCount,
  staleCount,
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
  commit
} = useCollation();

const importVisible = ref(false);
const onlyDifferences = ref(false);
const reviewFilter = ref<'' | RowReviewState>('');
const rowQuery = ref('');
const noteDraft = ref('');
const sourceDraft = ref('');
const importForm = ref({ name: '', source: '', text: '' });
const fileInput = ref<HTMLInputElement | null>(null);

// 确认弹窗
const confirmVisible = ref(false);
const confirmMode = ref<'single' | 'batch'>('single');
const confirmRowId = ref('');
const confirmHandlerDraft = ref('');
const confirmBasisDraft = ref('');
// 批量确认的范围：null 表示当前搜索结果全部可确认条目；数组表示仅勾选的条目
const confirmScopeIds = ref<string[] | null>(null);

const columns = [
  { title: '状态', dataIndex: 'status', slotName: 'status', width: 122, fixed: 'left' as const },
  { title: '底本', dataIndex: 'left', slotName: 'left', width: 330 },
  { title: '对准操作', dataIndex: 'align', slotName: 'align', width: 112, align: 'center' as const },
  { title: '参校本', dataIndex: 'right', slotName: 'right', width: 330 },
  { title: '校记 / 来源', dataIndex: 'note', slotName: 'note', width: 260 }
];

const filteredRows = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => {
    const state = rowReviewState(row);
    if (onlyDifferences.value && row.status === 'same') return false;
    if (reviewFilter.value && state !== reviewFilter.value) return false;
    if (!query) return true;
    return [
      row.left?.text,
      row.right?.text,
      row.note,
      row.source,
      statusLabel(row.status),
      ...row.confirmations.flatMap((item) => [item.handler, item.basis])
    ]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query));
  });
});

/** 当前搜索结果里已写明依据（校记）、且没有有效确认的条目，才有资格批量确认 */
const eligibleRows = computed(() =>
  filteredRows.value.filter((row) => row.note.trim() && rowReviewState(row) !== 'active')
);
const skippedRows = computed(() =>
  filteredRows.value.filter((row) => !row.note.trim() && rowReviewState(row) !== 'active')
);

const confirmTargetRow = computed(() => rows.value.find((row) => row.id === confirmRowId.value));
const pendingCount = computed(
  () => rows.value.filter((row) => row.status !== 'same' && rowReviewState(row) === 'none').length
);

// 批量确认弹窗实际会覆盖的条目（已写明依据、尚无有效确认）
const batchTargets = computed(() => {
  if (confirmScopeIds.value === null) return eligibleRows.value;
  const scope = new Set(confirmScopeIds.value);
  return filteredRows.value.filter(
    (row) => scope.has(row.id) && row.note.trim() && rowReviewState(row) !== 'active'
  );
});
// 本次范围内因缺少依据会被跳过的条目
const batchSkipped = computed(() => {
  if (confirmScopeIds.value === null) return skippedRows.value;
  const scope = new Set(confirmScopeIds.value);
  return filteredRows.value.filter((row) => scope.has(row.id) && !row.note.trim());
});

const rowSelection = computed(() => ({
  type: 'checkbox' as const,
  showCheckedAll: true,
  selectedRowKeys: selectedRowIds.value,
  onlyCurrent: false
}));

watch(
  selectedRow,
  (row) => {
    noteDraft.value = row?.note ?? '';
    sourceDraft.value = row?.source ?? '';
  },
  { immediate: true }
);

function statusColor(status: DifferenceStatus) {
  return {
    same: 'gray',
    changed: 'orange',
    added: 'green',
    removed: 'red',
    misaligned: 'arcoblue'
  }[status] as 'gray' | 'orange' | 'green' | 'red' | 'arcoblue';
}

function reviewStateColor(state: RowReviewState) {
  return {
    active: 'green',
    stale: 'orange',
    void: 'gray',
    none: 'orangered'
  }[state] as 'green' | 'orange' | 'gray' | 'orangered';
}

function rowState(row: AlignmentRow): RowReviewState {
  return rowReviewState(row);
}

function rowLatest(row: AlignmentRow) {
  return latestConfirmation(row);
}

function stateOfRow(row: AlignmentRow) {
  return reviewStateLabel(rowReviewState(row));
}

function stateReason(row: AlignmentRow) {
  const current = latestConfirmation(row);
  return current?.invalidReason ? invalidReasonLabel[current.invalidReason] : '';
}

function formatTime(value?: string) {
  if (!value) return '时间未详';
  return new Date(value).toLocaleString('zh-CN');
}

function rowClass(record: AlignmentRow) {
  return record.id === selectedRowId.value ? 'row-active' : '';
}

function onSelectionChange(keys: (string | number)[]) {
  selectedRowIds.value = keys;
}

function updateStatus(status: unknown) {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, { status: String(status) as DifferenceStatus });
}

function onRowClick(record: Record<string, unknown>) {
  const row = record as unknown as AlignmentRow;
  selectedRowId.value = row.id;
}

function saveAnnotation() {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, {
    note: noteDraft.value.trim(),
    source: sourceDraft.value.trim()
  });
  Message.success('校勘说明已保存；若该行已有确认，会自动回到待复核');
}

function openSingleConfirm(row: AlignmentRow) {
  confirmMode.value = 'single';
  confirmRowId.value = row.id;
  confirmHandlerDraft.value = handler.value.trim();
  confirmBasisDraft.value = row.note;
  confirmVisible.value = true;
}

function openBatchConfirm(ids?: string[]) {
  confirmMode.value = 'batch';
  confirmRowId.value = '';
  confirmScopeIds.value = ids ? [...ids] : null;
  confirmHandlerDraft.value = handler.value.trim();
  confirmBasisDraft.value = '';
  if (!batchTargets.value.length) {
    Message.warning('所选条目都还没有写明依据（校记），请先补写校勘说明再确认');
    return;
  }
  confirmVisible.value = true;
}

function submitConfirm() {
  const confirmHandler = confirmHandlerDraft.value.trim();
  if (!confirmHandler) {
    Message.warning('请填写处理人，便于交接时核对是谁的判断');
    return;
  }
  handler.value = confirmHandler;
  if (confirmMode.value === 'single') {
    const basis = confirmBasisDraft.value.trim();
    if (!basis) {
      Message.warning('请写明本次确认的依据（校勘说明）');
      return;
    }
    const { confirmed, skipped } = confirmRows([confirmRowId.value], confirmHandler, basis);
    if (confirmed) {
      Message.success(`已确认 1 条：处理人 ${confirmHandler}，依据与当时正文/规则状态已留痕`);
    } else if (skipped) {
      Message.warning('该条没有依据，未确认');
    }
  } else {
    const result = confirmRows(
      batchTargets.value.map((row) => row.id),
      confirmHandler
    );
    if (result.confirmed) {
      Message.success(`已确认 ${result.confirmed} 条写明依据的条目`);
    }
    if (result.skipped || batchSkipped.value.length) {
      Message.info(`${result.skipped || batchSkipped.value.length} 条未写明依据，已跳过`);
    }
  }
  confirmVisible.value = false;
}

function withdraw(rowId: string) {
  withdrawConfirmation(rowId);
  Message.info('确认已撤回，旧记录标记为已失效并保留');
}

// 确认记录最新在前
const confirmationHistory = computed(() =>
  selectedRow.value ? [...selectedRow.value.confirmations].reverse() : []
);

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleExport(kind: 'markdown' | 'json') {
  if (kind === 'markdown') {
    download('校勘记.md', exportMarkdown(), 'text/markdown;charset=utf-8');
  } else {
    download('校勘数据.json', exportJson(), 'application/json;charset=utf-8');
  }
}

function openImport() {
  importForm.value = { name: `导入版本 ${versions.value.length + 1}`, source: '', text: '' };
  importVisible.value = true;
}

function confirmImport() {
  if (!importForm.value.text.trim()) {
    Message.warning('请粘贴版本正文或选择文本文件');
    return;
  }
  addVersion(importForm.value.name, importForm.value.source, importForm.value.text.trim());
  importVisible.value = false;
}

function handleFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    importForm.value.text = text;
    if (!importForm.value.name || importForm.value.name.startsWith('导入版本')) {
      importForm.value.name = file.name.replace(/\.[^.]+$/, '');
    }
  });
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (typing) return;
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    nextDifference();
  } else if (event.key.toLowerCase() === 'a' && selectedRowIds.value.length) {
    const ids = selectedRowIds.value.map(String);
    if (!handler.value.trim()) {
      Message.warning('请先在左侧填写处理人，再批量确认');
      return;
    }
    const result = confirmRows(ids, handler.value.trim());
    if (result.confirmed) {
      Message.success(`已确认勾选结果中 ${result.confirmed} 条写明依据的条目`);
    }
    if (result.skipped) {
      Message.info(`${result.skipped} 条勾选条目未写明依据，已跳过`);
    }
  }
}

window.addEventListener('keydown', handleKeydown);

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (unresolvedCount.value > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', beforeUnload);
</script>

<template>
  <a-layout class="workbench-shell">
    <a-layout-header class="topbar">
      <div style="display: flex; align-items: center; gap: 12px; width: 100%">
        <div class="brand-mark">校</div>
        <div>
          <h1 class="brand-title">校异斋 · 多版本校勘台</h1>
          <div class="brand-subtitle">自动对齐、人工修正、校记导出，全程本地保存</div>
        </div>
        <a-space style="margin-left: auto" wrap>
          <a-button :disabled="!canUndo" @click="undo">撤销</a-button>
          <a-button :disabled="!canRedo" @click="redo">重做</a-button>
          <a-button type="primary" :loading="processing" @click="runAlignment()">重新自动对齐</a-button>
          <a-button @click="openImport">导入版本</a-button>
          <a-dropdown>
            <a-button>导出校勘记</a-button>
            <template #content>
              <a-doption @click="handleExport('markdown')">Markdown 校勘记</a-doption>
              <a-doption @click="handleExport('json')">JSON 校勘数据</a-doption>
            </template>
          </a-dropdown>
        </a-space>
      </div>
    </a-layout-header>

    <a-layout class="main-layout">
      <a-layout-sider class="left-panel" :width="282">
        <section class="panel-section">
          <h2 class="panel-title">比对版本</h2>
          <div style="display: grid; gap: 10px">
            <a-select v-model="leftVersionId" aria-label="底本">
              <template #prefix>底本</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-select v-model="rightVersionId" aria-label="参校本">
              <template #prefix>参校</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-button long type="outline" @click="runAlignment()">执行分片自动对齐</a-button>
          </div>
          <a-progress v-if="processing" :percent="progress" size="small" style="margin-top: 12px" />
          <div v-if="processing" style="margin-top: 6px; color: #86909c; font-size: 12px">
            正在让出主线程，长文本编辑不会一直卡住
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">处理人</h2>
          <a-input
            v-model="handler"
            placeholder="填写本次整理者姓名，确认时留痕"
            allow-clear
            aria-label="处理人"
          />
          <div style="margin-top: 8px; color: #86909c; font-size: 12px; line-height: 1.6">
            每次确认都会记录处理人、依据，以及当时两侧正文与规则状态；交接时可据此核对。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">比较规则</h2>
          <a-space direction="vertical" fill>
            <a-checkbox v-model="rules.ignorePunctuation" @change="recalculate">忽略标点差异</a-checkbox>
            <a-checkbox v-model="rules.ignoreVariants" @change="recalculate">忽略常见异体字</a-checkbox>
          </a-space>
          <div style="margin-top: 10px; color: #86909c; font-size: 12px; line-height: 1.6">
            规则只影响相同/改动判断，原始正文始终保留；规则一变，已有确认立即回到待复核。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">处理进度</h2>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-number">{{ differenceCount }}</div>
              <div class="stat-label">全部差异</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #d25f00">{{ pendingCount }}</div>
              <div class="stat-label">待处理</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #d25f00">{{ staleCount }}</div>
              <div class="stat-label">待复核</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #00875a">{{ acceptedCount }}</div>
              <div class="stat-label">确认有效</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #86909c">{{ voidConfirmationCount }}</div>
              <div class="stat-label">已失效留痕</div>
            </div>
            <div class="stat-card">
              <div class="stat-number">{{ rows.length }}</div>
              <div class="stat-label">对齐句段</div>
            </div>
          </div>
          <a-button
            long
            type="primary"
            status="success"
            style="margin-top: 12px"
            :disabled="!eligibleRows.length"
            @click="openBatchConfirm()"
          >
            批量确认当前结果（{{ eligibleRows.length }} 条有据可依）
          </a-button>
          <div style="margin-top: 6px; color: #86909c; font-size: 11px; line-height: 1.6">
            只覆盖当前搜索结果里已写明依据、且尚无有效确认的条目；
            <template v-if="skippedRows.length">本视图 {{ skippedRows.length }} 条无依据会被跳过。</template>
          </div>
          <a-button long style="margin-top: 8px" @click="nextDifference">跳到下一处待复核差异</a-button>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">键盘辅助</h2>
          <div style="color: #4e5969; font-size: 12px; line-height: 2">
            <div><a-tag size="small">Alt ↓</a-tag> 下一处待复核差异</div>
            <div><a-tag size="small">A</a-tag> 确认勾选条目（须有依据）</div>
            <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
            <div><a-tag size="small">Ctrl/⌘ Y</a-tag> 重做</div>
          </div>
        </section>
      </a-layout-sider>

      <a-layout-content class="center-panel">
        <a-card :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <a-input-search v-model="rowQuery" placeholder="搜索正文、校记、来源或处理人" allow-clear style="max-width: 360px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-select
              v-model="reviewFilter"
              placeholder="确认状态"
              style="width: 132px"
              allow-clear
              aria-label="按确认状态筛选"
            >
              <a-option :value="'none'">待处理</a-option>
              <a-option :value="'stale'">待复核</a-option>
              <a-option :value="'active'">确认有效</a-option>
              <a-option :value="'void'">已失效留痕</a-option>
            </a-select>
            <a-tag color="arcoblue">{{ filteredRows.length }} / {{ rows.length }} 行</a-tag>
            <a-tag v-if="eligibleRows.length" color="green">{{ eligibleRows.length }} 行可批量确认</a-tag>
            <a-tag v-if="selectedRowIds.length" color="purple">{{ selectedRowIds.length }} 行已勾选</a-tag>
            <a-button
              v-if="selectedRowIds.length"
              type="primary"
              status="success"
              size="small"
              style="margin-left: auto"
              @click="openBatchConfirm(selectedRowIds.map(String))"
            >
              确认勾选条目
            </a-button>
          </div>
        </a-card>

        <a-card :bordered="false" :body-style="{ padding: 0 }">
          <a-alert :show-icon="processing" :type="unresolvedCount ? 'warning' : 'success'" style="border-radius: 0">
            {{ message
            }}<span v-if="unresolvedCount"> · {{ unresolvedCount }} 条差异待处理或待复核；补校记、挪配对、换规则都会让旧确认回到待复核</span>
          </a-alert>
          <a-table
            class="virtual-table"
            row-key="id"
            :columns="columns"
            :data="filteredRows"
            :pagination="false"
            :row-selection="rowSelection"
            :row-class="rowClass"
            :scroll="{ x: 1160, y: 'calc(100vh - 260px)' }"
            :virtual-list-props="{ height: 590, threshold: 40 }"
            @selection-change="onSelectionChange"
            @row-click="onRowClick"
          >
            <template #status="{ record }">
              <a-tag :color="statusColor(record.status)">
                {{ statusLabel(record.status) }}
              </a-tag>
              <div style="margin-top: 6px; color: #86909c; font-size: 11px">
                相似度 {{ Math.round(record.similarity * 100) }}%
              </div>
              <a-tag
                :color="reviewStateColor(rowState(record))"
                size="small"
                style="margin-top: 6px"
              >
                {{ stateOfRow(record) }}
              </a-tag>
              <div v-if="record.manuallyAdjusted" style="margin-top: 4px; color: #165dff; font-size: 11px">人工调整</div>
            </template>

            <template #left="{ record }">
              <div v-if="record.left">
                <div class="paragraph-label">段 {{ record.left.paragraphOrder }} · 句 {{ record.left.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'removed' ? 'removed' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.left.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应底本句</div>
            </template>

            <template #align="{ record }">
              <a-space direction="vertical" size="mini">
                <a-button size="mini" @click.stop="shiftPairing(record.id, -1)">配对上移</a-button>
                <a-button size="mini" @click.stop="shiftPairing(record.id, 1)">配对下移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, -1)">整行上移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, 1)">整行下移</a-button>
                <a-tooltip content="确认这一行的判断（须填写处理人与依据）">
                  <a-button
                    size="mini"
                    :status="rowState(record) === 'active' ? 'normal' : 'success'"
                    :type="rowState(record) === 'active' ? 'outline' : 'primary'"
                    @click.stop="openSingleConfirm(record)"
                  >
                    {{ rowState(record) === 'active' ? '重新确认' : '确认' }}
                  </a-button>
                </a-tooltip>
              </a-space>
            </template>

            <template #right="{ record }">
              <div v-if="record.right">
                <div class="paragraph-label">段 {{ record.right.paragraphOrder }} · 句 {{ record.right.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'added' ? 'added' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.right.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应参校本句</div>
            </template>

            <template #note="{ record }">
              <div style="font-size: 12px; line-height: 1.6; color: #4e5969">
                <div>{{ record.note || '尚未填写校勘说明（依据）' }}</div>
                <div v-if="record.source" style="margin-top: 5px; color: #86909c">来源：{{ record.source }}</div>
                <a-tag :color="reviewStateColor(rowState(record))" size="small" style="margin-top: 7px">
                  {{ stateOfRow(record) }}
                </a-tag>
                <template v-if="rowLatest(record)">
                  <div style="margin-top: 5px; color: #86909c">
                    {{ rowLatest(record)!.handler }} · {{ formatTime(rowLatest(record)!.createdAt) }}
                  </div>
                  <a-tooltip v-if="rowState(record) === 'stale'" :content="stateReason(record)">
                    <div style="margin-top: 3px; color: #d25f00">
                      ⚠ {{ stateReason(record) }}，请重新确认
                    </div>
                  </a-tooltip>
                  <div v-if="record.confirmations.length > 1" style="margin-top: 3px; color: #86909c">
                    另有 {{ record.confirmations.length - 1 }} 条历史确认已留痕
                  </div>
                </template>
              </div>
            </template>

            <template #empty>
              <a-empty description="没有符合条件的对齐行" />
            </template>
          </a-table>
        </a-card>
      </a-layout-content>

      <a-layout-sider class="right-panel" :width="340">
        <section v-if="selectedRow" class="panel-section">
          <div style="display: flex; align-items: center">
            <h2 class="panel-title" style="margin: 0">校勘详情</h2>
            <a-space style="margin-left: auto" size="small">
              <a-tag :color="statusColor(selectedRow.status)">{{ statusLabel(selectedRow.status) }}</a-tag>
              <a-tag :color="reviewStateColor(rowState(selectedRow))">{{ stateOfRow(selectedRow) }}</a-tag>
            </a-space>
          </div>
        </section>

        <template v-if="selectedRow">
          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">判断类别</div>
            <a-select :model-value="selectedRow.status" style="width: 100%" @change="updateStatus">
              <a-option value="same">相同</a-option>
              <a-option value="changed">改动</a-option>
              <a-option value="added">右侧新增</a-option>
              <a-option value="removed">左侧删减</a-option>
              <a-option value="misaligned">疑错位</a-option>
            </a-select>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">底本 / 参校本</div>
            <div class="diff-text same">{{ selectedRow.left?.text || '（无）' }}</div>
            <div style="height: 8px" />
            <div class="diff-text changed">{{ selectedRow.right?.text || '（无）' }}</div>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">校勘说明</div>
            <a-textarea
              v-model="noteDraft"
              placeholder="记录字形、词句、标点或语义差异的判断依据"
              :auto-size="{ minRows: 5, maxRows: 10 }"
            />
            <a-input v-model="sourceDraft" placeholder="来源，如：某刻本、某整理者" style="margin-top: 10px" />
            <a-button long type="primary" style="margin-top: 10px" @click="saveAnnotation">保存校勘说明</a-button>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">错位修正</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
              <a-button @click="shiftPairing(selectedRow.id, -1)">配对向前</a-button>
              <a-button @click="shiftPairing(selectedRow.id, 1)">配对向后</a-button>
              <a-button @click="moveRow(selectedRow.id, -1)">整行上移</a-button>
              <a-button @click="moveRow(selectedRow.id, 1)">整行下移</a-button>
            </div>
            <a-alert type="info" style="margin-top: 10px" :show-icon="true">
              配对移动只交换左栏句段，不会改写底本或参校本原文。
            </a-alert>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">确认留痕</div>
            <a-button long type="primary" status="success" @click="openSingleConfirm(selectedRow)">
              {{ rowState(selectedRow) === 'active' ? '重新确认本行判断' : '确认本行判断' }}
            </a-button>
            <a-button
              v-if="rowState(selectedRow) !== 'none'"
              long
              type="outline"
              status="warning"
              style="margin-top: 8px"
              :disabled="rowState(selectedRow) === 'void'"
              @click="withdraw(selectedRow.id)"
            >
              撤回确认（旧记录标记已失效并保留）
            </a-button>
            <a-alert
              :type="rowState(selectedRow) === 'stale' ? 'warning' : 'info'"
              style="margin-top: 10px"
              :show-icon="true"
            >
              <template v-if="rowState(selectedRow) === 'stale'">
                本行旧确认已失效：{{ stateReason(selectedRow) }}。请核对后重新确认，旧记录仍会保留。
              </template>
              <template v-else>
                确认时会保存处理人、依据，以及当时两侧正文、校记、类别和规则快照；任一项变化即回到待复核。
              </template>
            </a-alert>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">
              确认历史（{{ selectedRow.confirmations.length }}）
            </div>
            <div v-if="confirmationHistory.length" style="display: grid; gap: 8px">
              <div
                v-for="item in confirmationHistory"
                :key="item.id"
                class="confirm-card"
                :class="`confirm-${item.state}`"
              >
                <div style="display: flex; align-items: center; gap: 6px">
                  <a-tag size="small" :color="reviewStateColor(item.state)">{{ reviewStateLabel(item.state) }}</a-tag>
                  <span style="color: #4e5969; font-size: 12px; font-weight: 600">{{ item.handler }}</span>
                  <span style="margin-left: auto; color: #86909c; font-size: 11px">{{ formatTime(item.createdAt) }}</span>
                </div>
                <div style="margin-top: 5px; font-size: 12px; line-height: 1.6; color: #4e5969">依据：{{ item.basis }}</div>
                <div v-if="item.source" style="margin-top: 2px; font-size: 11px; color: #86909c">来源：{{ item.source }}</div>
                <div style="margin-top: 4px; font-size: 11px; color: #86909c; line-height: 1.6">
                  当时规则：{{ item.snapshot.rules.ignorePunctuation ? '忽略标点 ' : '' }}{{ item.snapshot.rules.ignoreVariants ? '忽略异体字' : '保留异体字' }}
                  · 类别：{{ statusLabel(item.snapshot.status) }}
                </div>
                <div v-if="item.invalidReason" style="margin-top: 4px; font-size: 11px; color: #d25f00; line-height: 1.6">
                  {{ invalidReasonLabel[item.invalidReason] }}<template v-if="item.invalidAt"> · {{ formatTime(item.invalidAt) }}</template>
                </div>
              </div>
            </div>
            <div v-else style="color: #86909c; font-size: 12px">尚无确认记录，交接前请确认并写明依据。</div>
          </section>
        </template>

        <div v-else class="inspector-empty">
          <div>
            <div style="font-size: 30px; color: #c9cdd4">择</div>
            <p>选择中间表格的一行<br />即可调整错位并填写校勘说明</p>
          </div>
        </div>

        <section class="panel-section" style="margin-top: auto">
          <div style="color: #86909c; font-size: 11px; line-height: 1.7">
            最近状态：{{ message }}<br />
            数据保存在当前浏览器，刷新后继续。
          </div>
        </section>
      </a-layout-sider>
    </a-layout>
  </a-layout>

  <a-modal v-model:visible="importVisible" title="导入同一作品的新版本" width="700px" @ok="confirmImport">
    <a-form :model="importForm" layout="vertical">
      <a-grid :cols="2" :col-gap="12">
        <a-grid-item>
          <a-form-item label="版本名称">
            <a-input v-model="importForm.name" placeholder="如：某刻本 / 某校点本" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="来源">
            <a-input v-model="importForm.source" placeholder="馆藏、整理者或文件来源" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="选择文本文件">
        <input ref="fileInput" type="file" accept=".txt,.md,text/plain,text/markdown" @change="handleFile" />
      </a-form-item>
      <a-form-item label="或直接粘贴正文">
        <a-textarea
          v-model="importForm.text"
          placeholder="空行分段；句号、问号、感叹号或分号后自动分句"
          :auto-size="{ minRows: 10, maxRows: 18 }"
        />
      </a-form-item>
      <a-alert type="info" :show-icon="true">导入仅写入当前浏览器。对齐过程会分片执行，原文不会被自动改写。</a-alert>
    </a-form>
  </a-modal>

  <a-modal
    v-model:visible="confirmVisible"
    :title="confirmMode === 'single' ? '确认本行校勘判断' : `批量确认（${batchTargets.length} 条）`"
    width="620px"
    ok-text="确认并留痕"
    @ok="submitConfirm"
  >
    <a-form layout="vertical" :model="{ handler: confirmHandlerDraft, basis: confirmBasisDraft }">
      <a-form-item label="处理人" required>
        <a-input v-model="confirmHandlerDraft" placeholder="交接时可据此找到本次判断人" allow-clear />
      </a-form-item>
      <template v-if="confirmMode === 'single'">
        <a-form-item label="依据（校勘说明）" required>
          <a-textarea
            v-model="confirmBasisDraft"
            placeholder="写明判断依据，如：据某刻本，异体字关系，或文义取舍理由"
            :auto-size="{ minRows: 4, maxRows: 9 }"
          />
        </a-form-item>
        <a-alert type="info" :show-icon="true">
          确认时将同时保存当前两侧正文、判断类别和比较规则；之后任一项变化，本行自动回到待复核，本次记录仍保留。
        </a-alert>
      </template>
      <template v-else>
        <a-alert type="info" :show-icon="true" style="margin-bottom: 10px">
          将确认<template v-if="confirmScopeIds === null">当前搜索结果中</template><b> {{ batchTargets.length }} </b>条已写明依据（校记）、且尚无有效确认的条目；
          依据沿用各行现有校记。<template v-if="batchSkipped.length">{{ batchSkipped.length }} 条未写依据的条目会跳过。</template>
        </a-alert>
        <div style="max-height: 220px; overflow: auto; display: grid; gap: 6px">
          <div v-for="row in batchTargets" :key="row.id" class="confirm-batch-item">
            <a-tag size="small" color="green">将确认</a-tag>
            <span class="confirm-batch-text">{{ row.left?.text || '（无）' }}</span>
            <span class="confirm-batch-arrow">→</span>
            <span class="confirm-batch-text">{{ row.right?.text || '（无）' }}</span>
          </div>
        </div>
      </template>
    </a-form>
  </a-modal>
</template>
