/* 端到端验证：在 Node 中模拟浏览器环境，直接驱动 useCollation 的核心流程 */
(async () => {
const assert = require('node:assert');
const { build } = require('esbuild');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
};
globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
globalThis.window = {
  setTimeout: (fn) => setTimeout(fn, 0),
  addEventListener: () => {}
};

const entry = path.join(os.tmpdir(), 'use-collation-test.mjs');
await build({
  entryPoints: ['src/composables/useCollation.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: entry,
  logLevel: 'silent'
});

const mod = await import(pathToFileURL(entry).href);
const { useCollation, rowReviewState: stateOf, latestConfirmation, invalidReasonLabel } = mod;

function setup() {
  const c = useCollation();
  return c;
}

const c = setup();
await c.runAlignment(false);
assert.ok(c.rows.value.length > 0, '自动对齐应产生行');

// 找一行差异
const diffRow = c.rows.value.find((r) => r.status !== 'same');
assert.ok(diffRow, '示例数据应有差异行');

// 无处理人时确认仍会留痕（UI 层负责拦截空处理人）；无依据则跳过
let res = c.confirmRows([diffRow.id], '张三');
assert.strictEqual(res.confirmed, 0, '无依据（校记）时应跳过');
assert.strictEqual(res.skipped, 1);

// 补校记后确认
c.updateRow(diffRow.id, { note: '据王弼本，异体字“識/识”为同一字', source: '王弼注本' });
res = c.confirmRows([diffRow.id], '张三');
assert.strictEqual(res.confirmed, 1);
assert.strictEqual(stateOf(c.rows.value.find((r) => r.id === diffRow.id)), 'active');
const confirmed = latestConfirmation(c.rows.value.find((r) => r.id === diffRow.id));
assert.strictEqual(confirmed.handler, '张三');
assert.ok(confirmed.snapshot.rules.ignorePunctuation === true, '快照应记录规则状态');
assert.strictEqual(confirmed.snapshot.leftText, diffRow.left?.text ?? '', '快照应记录底本正文');

// 场景1：补改校记 → 回到待复核，旧记录保留
c.updateRow(diffRow.id, { note: '补充：参校帛书本亦可通' });
let row = c.rows.value.find((r) => r.id === diffRow.id);
assert.strictEqual(stateOf(row), 'stale', '补校记后应回到待复核');
assert.strictEqual(row.accepted, false, '待复核行不应再亮已接受标记');
assert.strictEqual(latestConfirmation(row).invalidReason, 'note');

// 场景2：重新确认 → 旧记录变 void(superseded) 且保留
res = c.confirmRows([diffRow.id], '李四');
assert.strictEqual(res.confirmed, 1);
row = c.rows.value.find((r) => r.id === diffRow.id);
assert.strictEqual(stateOf(row), 'active');
assert.strictEqual(row.confirmations.length, 2, '旧记录应保留');
assert.strictEqual(row.confirmations[0].state, 'void');
assert.strictEqual(row.confirmations[0].invalidReason, 'superseded');
assert.strictEqual(row.confirmations[1].handler, '李四');

// 场景3：挪动配对 → 涉及两行回到待复核
const before = c.rows.value.find((r) => r.id === diffRow.id);
const idx = c.rows.value.findIndex((r) => r.id === diffRow.id);
const neighbor = c.rows.value[idx + 1];
c.updateRow(neighbor.id, { note: '邻行依据：句序对应', source: '' });
c.confirmRows([neighbor.id], '李四');
c.shiftPairing(diffRow.id, 1);
row = c.rows.value.find((r) => r.id === diffRow.id);
const neighborAfter = c.rows.value.find((r) => r.id === neighbor.id);
assert.strictEqual(stateOf(row), 'stale', '挪动配对后当前行回到待复核');
assert.strictEqual(latestConfirmation(row).invalidReason, 'text');
assert.strictEqual(stateOf(neighborAfter), 'stale', '被波及的邻行也应回到待复核');

// 重新确认两行
c.confirmRows([diffRow.id, neighbor.id], '李四');

// 场景4：换规则 → 全部有效确认回到待复核（类别随之变化时可能报 status）
c.rules.value.ignorePunctuation = false;
c.recalculate();
assert.strictEqual(stateOf(c.rows.value.find((r) => r.id === diffRow.id)), 'stale');
assert.ok(['rules', 'status'].includes(latestConfirmation(c.rows.value.find((r) => r.id === diffRow.id)).invalidReason));
c.rules.value.ignorePunctuation = true;
c.recalculate();
// 规则改回原值后也不能自动复活——仍需人工重新确认
assert.strictEqual(stateOf(c.rows.value.find((r) => r.id === diffRow.id)), 'stale', '旧确认不应自动复活');
c.confirmRows([diffRow.id, neighbor.id], '李四');

// 场景5：撤回 → void(withdrawn)，记录保留
const countBefore = c.rows.value.find((r) => r.id === diffRow.id).confirmations.length;
c.withdrawConfirmation(diffRow.id);
row = c.rows.value.find((r) => r.id === diffRow.id);
assert.strictEqual(stateOf(row), 'void');
assert.strictEqual(row.confirmations.length, countBefore, '撤回不删除记录');
assert.strictEqual(latestConfirmation(row).invalidReason, 'withdrawn');

// 场景6：批量确认只覆盖有依据的条目
const allDiff = c.rows.value.filter((r) => r.status !== 'same');
const targetNoNote = allDiff.find((r) => stateOf(r) === 'none' || !r.note) ?? allDiff[2];
c.updateRow(targetNoNote.id, { note: '' });
const targetWithNote = allDiff.find((r) => r.id !== targetNoNote.id && stateOf(r) !== 'active');
if (targetWithNote) c.updateRow(targetWithNote.id, { note: '批量依据：字形对应明确' });
const scope = [targetNoNote.id].concat(targetWithNote ? [targetWithNote.id] : []);
res = c.confirmRows(scope, '王五');
assert.strictEqual(res.confirmed, targetWithNote ? 1 : 0, '只确认有依据的条目');
assert.ok(res.skipped >= 1, '无依据条目被跳过');

// 场景7：重新自动对齐 → 相同配对的旧确认带到新行并标 stale
c.confirmRows([diffRow.id], '李四', '对齐前再次确认的依据');
await c.runAlignment(true);
const carried = c.rows.value.find(
  (r) => r.left?.id === before.left?.id || r.confirmations.some((x) => x.handler === '李四')
);
assert.ok(carried, '旧确认应随相同配对保留');
const anyStaleCarry = c.rows.value.some((r) => {
  const cur = latestConfirmation(r);
  return cur && cur.state === 'stale' && cur.invalidReason === 'alignment';
});
assert.ok(anyStaleCarry, '重新对齐后旧确认应标为待复核(alignment)');

// 场景8：导出含三类标记
const md = c.exportMarkdown();
assert.ok(md.includes('有效'), 'Markdown 应标出有效统计');
assert.ok(md.includes('待复核'), 'Markdown 应标出待复核');
assert.ok(md.includes('已失效确认归档'), 'Markdown 应归档已失效确认');
const json = JSON.parse(c.exportJson());
assert.ok(json.summary && typeof json.summary.active === 'number', 'JSON 应含分类统计');
assert.ok(json.rows.every((r) => ['active', 'stale', 'void', 'none'].includes(r.reviewState)), 'JSON 每行带确认状态');

// 场景9：localStorage 持久化 + 旧版本 accepted 迁移为待复核 + 关闭重开接续处理
const raw = JSON.parse(localStorage.getItem('sologsb-1023/multi-version-collation/v1'));
assert.ok(raw.handler !== undefined, '处理人应持久化');

// 9a. 模拟关闭页面再打开：新实例 bootstrap 应恢复草稿、保留确认历史
const reopened = useCollation();
reopened.bootstrap();
assert.ok(reopened.rows.value.length > 0, '重开后应恢复对齐行');
const reopenedRow = reopened.rows.value.find((r) => r.left?.id === before.left?.id);
assert.ok(reopenedRow && reopenedRow.confirmations.length > 0, '重开后确认历史应保留');
assert.strictEqual(reopened.handler.value, '李四', '处理人应恢复');

// 9b. 旧版本草稿（只有 accepted 布尔，没有 confirmations）→ 迁移为待复核 legacy
storage.clear();
const legacyRows = c.rows.value.map((r) => ({ ...r, accepted: true, confirmations: undefined }));
storage.set(
  'sologsb-1023/multi-version-collation/v1',
  JSON.stringify({
    versions: c.versions.value,
    leftVersionId: c.leftVersionId.value,
    rightVersionId: c.rightVersionId.value,
    rows: legacyRows,
    rules: c.rules.value,
    selectedRowId: '',
    handler: '张三'
  })
);
const c2 = useCollation();
c2.bootstrap();
assert.ok(c2.rows.value.length > 0, '旧草稿应可载入');
assert.ok(
  c2.rows.value.every((r) => Array.isArray(r.confirmations)),
  '所有行应补齐 confirmations 字段'
);
const legacy = c2.rows.value.find((r) => r.confirmations.length > 0);
assert.ok(legacy, '旧 accepted 行应生成遗留确认记录');
assert.strictEqual(stateOf(legacy), 'stale', '旧接受记录应回到待复核');
assert.strictEqual(latestConfirmation(legacy).invalidReason, 'legacy');
assert.strictEqual(latestConfirmation(legacy).invalidReason && invalidReasonLabel.legacy.includes('旧版本'), true);
assert.strictEqual(legacy.accepted, false, '旧布尔标记不应继续亮灯');

console.log('全部核心断言通过 ✔');
fs.rmSync(entry, { force: true });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
