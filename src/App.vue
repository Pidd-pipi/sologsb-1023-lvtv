<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import {
  confirmationStateLabel,
  reviewReasonLabel,
  statusLabel,
  useCollation
} from './composables/useCollation';
import type { AlignmentRow, ConfirmationState, DifferenceStatus } from './types';

const {
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
  canUndo,
  canRedo,
  selectedRow,
  differenceCount,
  validCount,
  reviewCount,
  unresolvedCount,
  activeConfirmation,
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
  exportJson
} = useCollation();

const importVisible = ref(false);
const onlyDifferences = ref(false);
const rowQuery = ref('');
const stateFilter = ref<'all' | ConfirmationState | 'pending'>('all');
const noteDraft = ref('');
const sourceDraft = ref('');
const basisDraft = ref('');
const importForm = ref({ name: '', source: '', text: '' });
const fileInput = ref<HTMLInputElement | null>(null);

const columns = [
  { title: '状态 / 确认', dataIndex: 'status', slotName: 'status', width: 150, fixed: 'left' as const },
  { title: '底本', dataIndex: 'left', slotName: 'left', width: 300 },
  { title: '对准操作', dataIndex: 'align', slotName: 'align', width: 108, align: 'center' as const },
  { title: '参校本', dataIndex: 'right', slotName: 'right', width: 300 },
  { title: '校记 / 依据', dataIndex: 'note', slotName: 'note', width: 280 },
  { title: '确认', dataIndex: 'confirm', slotName: 'confirm', width: 150 }
];

const filteredRows = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => {
    if (onlyDifferences.value && row.status === 'same') return false;
    const state = activeConfirmation(row.id)?.state;
    if (stateFilter.value === 'valid' && state !== 'valid') return false;
    if (stateFilter.value === 'review' && state !== 'review') return false;
    if (stateFilter.value === 'pending' && (state === 'valid' || state === 'review' || row.status === 'same')) {
      return false;
    }
    if (!query) return true;
    return [row.left?.text, row.right?.text, row.note, row.source, row.basis, statusLabel(row.status)]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query));
  });
});

/** 批量确认的候选：当前搜索结果里、有差异、尚未有效确认的行 */
const batchCandidates = computed(() =>
  filteredRows.value.filter((row) => {
    if (row.status === 'same') return false;
    return activeConfirmation(row.id)?.state !== 'valid';
  })
);
const batchReadyCount = computed(() => batchCandidates.value.filter((row) => row.basis.trim()).length);

watch(
  selectedRow,
  (row) => {
    noteDraft.value = row?.note ?? '';
    sourceDraft.value = row?.source ?? '';
    basisDraft.value = row?.basis ?? '';
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

function confirmationColor(state: ConfirmationState | undefined) {
  if (state === 'valid') return 'green';
  if (state === 'review') return 'orangered';
  return 'gray';
}

function rowClass(record: AlignmentRow) {
  const state = activeConfirmation(record.id)?.state;
  return [
    record.id === selectedRowId.value ? 'row-active' : '',
    state === 'review' ? 'row-review' : ''
  ];
}

function updateStatus(status: unknown) {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, { status: String(status) as DifferenceStatus });
}

function saveAnnotation() {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, {
    note: noteDraft.value.trim(),
    source: sourceDraft.value.trim(),
    basis: basisDraft.value.trim()
  });
  Message.success('校记、来源与确认依据已保存');
}

/** 单条确认：处理人 + 依据缺一不可 */
function doConfirm(row: AlignmentRow) {
  if (!editorName.value.trim()) {
    Message.warning('请先在左栏填写处理人署名');
    return;
  }
  const active = activeConfirmation(row.id);
  const migrated = !!active?.migrated;
  if (!row.basis.trim()) {
    Message.warning(migrated ? '这是旧版迁移的确认，请补录依据后再确认' : '请先为这一行写明确认依据');
    selectedRowId.value = row.id;
    return;
  }
  const result = confirmRow(row.id, row.basis);
  if (result.ok) {
    Message.success(migrated ? '已补录处理人与依据，重新确认完成' : '已确认，现场与依据已留档');
  } else if (result.reason) Message.warning(result.reason);
}

function doConfirmSelected() {
  if (!selectedRow.value) return;
  doConfirm(selectedRow.value);
}

/** 批量确认：只覆盖当前搜索结果中已写明依据的条目 */
function doBatchConfirm() {
  if (!editorName.value.trim()) {
    Message.warning('请先在左栏填写处理人署名');
    return;
  }
  const { confirmed, skipped } = confirmRows(batchCandidates.value.map((row) => row.id));
  if (!confirmed.length) {
    Message.warning('当前搜索结果里没有已写明依据的条目可确认');
    return;
  }
  Message.success({
    content: skipped.length
      ? `已确认 ${confirmed.length} 条；跳过 ${skipped.length} 条未写依据的条目`
      : `已确认 ${confirmed.length} 条`,
    duration: 3000
  });
}

function doWithdraw(row: AlignmentRow) {
  withdrawConfirmation(row.id);
  Message.info('已撤回确认，旧记录保留在该行档案中');
}

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

function onRowClick(record: unknown) {
  selectedRowId.value = (record as AlignmentRow).id;
}

function formatTime(value?: string) {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (!time) return '旧版迁移';
  return new Date(value).toLocaleString('zh-CN');
}

function rulesText(snapshot: { ignorePunctuation: boolean; ignoreVariants: boolean }) {
  const parts = [];
  parts.push(snapshot.ignorePunctuation ? '忽略标点' : '保留标点比较');
  parts.push(snapshot.ignoreVariants ? '忽略异体字' : '不忽略异体字');
  return parts.join('；');
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
  } else if (event.key.toLowerCase() === 'a') {
    doBatchConfirm();
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
          <div class="brand-subtitle">确认留痕：处理人、依据与现场快照；正文或规则一变即回待复核</div>
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
          <h2 class="panel-title">处理人署名</h2>
          <a-input v-model="editorName" placeholder="确认时记录为处理人，如：整理者姓名" allow-clear>
            <template #prefix>人</template>
          </a-input>
          <div style="margin-top: 8px; color: #86909c; font-size: 12px; line-height: 1.6">
            每次确认都会写下署名、依据和当时的正文与规则；署名保存在本机，刷新不丢。
          </div>
        </section>

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
          <h2 class="panel-title">比较规则</h2>
          <a-space direction="vertical" fill>
            <a-checkbox v-model="rules.ignorePunctuation" @change="recalculate">忽略标点差异</a-checkbox>
            <a-checkbox v-model="rules.ignoreVariants" @change="recalculate">忽略常见异体字</a-checkbox>
          </a-space>
          <div style="margin-top: 10px; color: #86909c; font-size: 12px; line-height: 1.6">
            规则只影响相同/改动判断，原始正文始终保留；改规则会使既有确认回到待复核。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">确认进度</h2>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-number">{{ differenceCount }}</div>
              <div class="stat-label">全部差异</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #00875a">{{ validCount }}</div>
              <div class="stat-label">有效确认</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #cb2634">{{ reviewCount }}</div>
              <div class="stat-label">待复核</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #d25f00">{{ unresolvedCount }}</div>
              <div class="stat-label">待处理 / 复核</div>
            </div>
          </div>
          <a-tooltip content="只确认当前搜索结果中已写明依据的差异行">
            <a-button
              long
              type="primary"
              status="success"
              style="margin-top: 12px"
              :disabled="!batchReadyCount"
              @click="doBatchConfirm"
            >
              批量确认当前结果（{{ batchReadyCount }} 条已写依据）
            </a-button>
          </a-tooltip>
          <a-button long style="margin-top: 8px" @click="nextDifference">跳到下一处待复核/待处理</a-button>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">键盘辅助</h2>
          <div style="color: #4e5969; font-size: 12px; line-height: 2">
            <div><a-tag size="small">Alt ↓</a-tag> 下一处待处理</div>
            <div><a-tag size="small">A</a-tag> 批量确认当前结果</div>
            <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
            <div><a-tag size="small">Ctrl/⌘ Y</a-tag> 重做</div>
          </div>
        </section>
      </a-layout-sider>

      <a-layout-content class="center-panel">
        <a-card :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <a-input-search v-model="rowQuery" placeholder="搜索正文、校记、来源或依据" allow-clear style="max-width: 320px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-select v-model="stateFilter" style="width: 150px" aria-label="按确认状态筛选">
              <a-option value="all">全部确认状态</a-option>
              <a-option value="valid">仅有效确认</a-option>
              <a-option value="review">仅待复核</a-option>
              <a-option value="pending">仅待处理</a-option>
            </a-select>
            <a-tag color="arcoblue">{{ filteredRows.length }} / {{ rows.length }} 行</a-tag>
            <a-tag v-if="batchReadyCount" color="green" style="margin-left: auto">
              当前结果中 {{ batchReadyCount }} 条可批量确认
            </a-tag>
          </div>
        </a-card>

        <a-card :bordered="false" :body-style="{ padding: 0 }">
          <a-alert :show-icon="processing" :type="reviewCount ? 'error' : unresolvedCount ? 'warning' : 'success'" style="border-radius: 0">
            {{ message }}
            <span v-if="reviewCount"> · {{ reviewCount }} 条确认因正文/配对/规则/校记变化回到待复核</span>
            <span v-else-if="unresolvedCount"> · {{ unresolvedCount }} 条差异尚未确认</span>
          </a-alert>
          <a-table
            class="virtual-table"
            row-key="id"
            :columns="columns"
            :data="filteredRows"
            :pagination="false"
            :row-class="rowClass"
            :scroll="{ x: 1310, y: 'calc(100vh - 270px)' }"
            :virtual-list-props="{ height: 590, threshold: 40 }"
            @row-click="onRowClick"
          >
            <template #status="{ record }">
              <a-tag :color="statusColor(record.status)">
                {{ statusLabel(record.status) }}
              </a-tag>
              <div style="margin-top: 6px; color: #86909c; font-size: 11px">
                相似度 {{ Math.round(record.similarity * 100) }}%
              </div>
              <a-tooltip v-if="activeConfirmation(record.id)?.state === 'review'">
                <template #content>
                  <div v-for="reason in activeConfirmation(record.id)!.reviewReasons" :key="reason">
                    · {{ reviewReasonLabel(reason) }}
                  </div>
                </template>
                <a-tag size="small" color="orangered" style="margin-top: 6px">
                  待复核 ×{{ activeConfirmation(record.id)!.reviewReasons.length }}
                </a-tag>
              </a-tooltip>
              <a-tag v-else-if="activeConfirmation(record.id)?.state === 'valid'" size="small" color="green" style="margin-top: 6px">
                确认有效
              </a-tag>
              <a-tag v-else-if="record.status !== 'same'" size="small" color="gray" style="margin-top: 6px">待处理</a-tag>
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
                <div>{{ record.note || '尚未填写校勘说明' }}</div>
                <div v-if="record.source" style="margin-top: 5px; color: #86909c">来源：{{ record.source }}</div>
                <div v-if="record.basis" style="margin-top: 5px; color: #0e42d2">依据：{{ record.basis }}</div>
                <div v-else-if="record.status !== 'same'" style="margin-top: 5px; color: #cb2634">尚未写明确认依据</div>
              </div>
            </template>

            <template #confirm="{ record }">
              <a-space v-if="activeConfirmation(record.id)" direction="vertical" size="mini" style="width: 100%">
                <a-tag :color="confirmationColor(activeConfirmation(record.id)!.state)" size="small">
                  {{ confirmationStateLabel(activeConfirmation(record.id)!.state) }}
                </a-tag>
                <div style="font-size: 11px; color: #86909c">
                  {{ activeConfirmation(record.id)!.editor || '（署名待补）' }}<br />
                  {{ formatTime(activeConfirmation(record.id)!.confirmedAt) }}
                </div>
                <a-button
                  v-if="activeConfirmation(record.id)!.state !== 'valid'"
                  size="mini"
                  type="primary"
                  status="warning"
                  @click.stop="doConfirm(record)"
                >
                  复核后重新确认
                </a-button>
                <a-button size="mini" status="danger" @click.stop="doWithdraw(record)">撤回确认</a-button>
              </a-space>
              <a-button
                v-else-if="record.status !== 'same'"
                size="mini"
                type="primary"
                status="success"
                @click.stop="doConfirm(record)"
              >
                确认本行
              </a-button>
              <span v-else style="color: #c9cdd4; font-size: 12px">相同，无需确认</span>
              <div v-if="record.status !== 'same' && !activeConfirmation(record.id) && !record.basis" style="font-size: 11px; color: #cb2634">
                需先写依据
              </div>
            </template>

            <template #empty>
              <a-empty description="没有符合条件的对齐行" />
            </template>
          </a-table>
        </a-card>
      </a-layout-content>

      <a-layout-sider class="right-panel" :width="350">
        <section class="panel-section">
          <div style="display: flex; align-items: center">
            <h2 class="panel-title" style="margin: 0">校勘详情</h2>
            <a-tag v-if="selectedRow" color="arcoblue" style="margin-left: auto">{{ statusLabel(selectedRow.status) }}</a-tag>
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
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">校勘说明 / 来源 / 确认依据</div>
            <a-textarea
              v-model="noteDraft"
              placeholder="校勘说明：字形、词句、标点或语义差异的判断"
              :auto-size="{ minRows: 3, maxRows: 8 }"
            />
            <a-input v-model="sourceDraft" placeholder="来源，如：某刻本、某条校记" style="margin-top: 8px" />
            <a-textarea
              v-model="basisDraft"
              placeholder="确认依据（必填）：凭什么下此判断，批量确认只认写了依据的行"
              :auto-size="{ minRows: 2, maxRows: 6 }"
              style="margin-top: 8px"
            />
            <a-button long type="primary" style="margin-top: 10px" @click="saveAnnotation">保存校记、来源与依据</a-button>
            <div style="margin-top: 8px; color: #86909c; font-size: 12px; line-height: 1.6">
              保存后若改动校记或来源，与之相关的已确认行会自动回到待复核。
            </div>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">错位修正（只交换配对，不改原文）</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
              <a-button @click="shiftPairing(selectedRow.id, -1)">配对向前</a-button>
              <a-button @click="shiftPairing(selectedRow.id, 1)">配对向后</a-button>
              <a-button @click="moveRow(selectedRow.id, -1)">整行上移</a-button>
              <a-button @click="moveRow(selectedRow.id, 1)">整行下移</a-button>
            </div>
          </section>

          <section class="panel-section confirm-card" :class="`is-${activeConfirmation(selectedRow.id)?.state ?? 'pending'}`">
            <div style="display: flex; align-items: center; margin-bottom: 10px">
              <h2 class="panel-title" style="margin: 0">确认档案</h2>
              <a-tag
                v-if="activeConfirmation(selectedRow.id)"
                :color="confirmationColor(activeConfirmation(selectedRow.id)!.state)"
                style="margin-left: auto"
              >
                {{ confirmationStateLabel(activeConfirmation(selectedRow.id)!.state) }}
              </a-tag>
              <a-tag v-else color="gray" style="margin-left: auto">待处理</a-tag>
            </div>

            <template v-if="activeConfirmation(selectedRow.id)">
              <div class="confirm-meta">
                <div><b>处理人：</b>{{ activeConfirmation(selectedRow.id)!.editor || '（旧版迁移，署名待补）' }}</div>
                <div><b>时间：</b>{{ formatTime(activeConfirmation(selectedRow.id)!.confirmedAt) }}</div>
                <div><b>依据：</b>{{ activeConfirmation(selectedRow.id)!.basis || '（待补录）' }}</div>
              </div>

              <div v-if="activeConfirmation(selectedRow.id)!.state === 'review'" class="review-box">
                <div style="font-weight: 600; margin-bottom: 6px">回到待复核的原因：</div>
                <div v-for="reason in activeConfirmation(selectedRow.id)!.reviewReasons" :key="reason" class="review-reason">
                  · {{ reviewReasonLabel(reason) }}
                </div>
                <div style="margin-top: 8px; color: #86909c; font-size: 12px">
                  核对当前正文与下方确认现场后，可重新确认；旧档案不会删除。
                </div>
              </div>

              <details class="snapshot-box">
                <summary>确认时的现场快照</summary>
                <div style="margin-top: 8px">
                  <div class="snapshot-label">当时底本</div>
                  <div class="diff-text same">{{ activeConfirmation(selectedRow.id)!.leftSnapshot.text || '（无）' }}</div>
                  <div class="snapshot-label">当时参校本</div>
                  <div class="diff-text changed">{{ activeConfirmation(selectedRow.id)!.rightSnapshot.text || '（无）' }}</div>
                  <div style="margin-top: 8px; color: #4e5969; font-size: 12px; line-height: 1.8">
                    <div>当时判断：{{ statusLabel(activeConfirmation(selectedRow.id)!.statusSnapshot) }}</div>
                    <div>当时规则：{{ rulesText(activeConfirmation(selectedRow.id)!.rulesSnapshot) }}</div>
                    <div>当时校记：{{ activeConfirmation(selectedRow.id)!.noteSnapshot || '（无）' }}</div>
                    <div>当时来源：{{ activeConfirmation(selectedRow.id)!.sourceSnapshot || '（无）' }}</div>
                  </div>
                </div>
              </details>

              <div style="display: flex; gap: 8px; margin-top: 12px">
                <a-button
                  long
                  type="primary"
                  :status="activeConfirmation(selectedRow.id)!.state === 'valid' ? 'success' : 'warning'"
                  @click="doConfirmSelected"
                >
                  {{ activeConfirmation(selectedRow.id)!.state === 'valid' ? '按当前现场再次确认' : '复核后重新确认' }}
                </a-button>
                <a-button long status="danger" @click="doWithdraw(selectedRow)">撤回</a-button>
              </div>
            </template>

            <template v-else>
              <div style="color: #4e5969; font-size: 13px; line-height: 1.7">
                本行尚未确认。确认后会记录处理人、依据，以及此刻两侧正文、判断与规则状态；之后任一项变化，本行自动回到待复核，旧记录仍保留。
              </div>
              <a-button long type="primary" status="success" style="margin-top: 12px" @click="doConfirmSelected">
                确认本行
              </a-button>
            </template>
          </section>
        </template>

        <div v-else class="inspector-empty">
          <div>
            <div style="font-size: 30px; color: #c9cdd4">择</div>
            <p>选择中间表格的一行<br />即可调整配对、填写校记并确认</p>
          </div>
        </div>

        <section class="panel-section" style="margin-top: auto">
          <div style="color: #86909c; font-size: 11px; line-height: 1.7">
            最近状态：{{ message }}<br />
            数据与确认档案保存在当前浏览器，关掉页面再打开可接着处理。
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
      <a-alert type="info" :show-icon="true">导入仅写入当前浏览器。重新对齐会按句段配对续接确认档案，接不上的档案归入导出文件的已失效/归档区。</a-alert>
    </a-form>
  </a-modal>
</template>
