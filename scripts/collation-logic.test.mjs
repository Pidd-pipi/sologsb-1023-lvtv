// 纯逻辑验证：不挂载 Vue 组件，直接驱动 useCollation
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
};

await build({
  entryPoints: [join(here, 'collation-logic.test.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: join(here, '.tmp/test-bundle.mjs'),
  logLevel: 'silent'
});

const V2_KEY = 'sologsb-1023/multi-version-collation/v2';
const V1_KEY = 'sologsb-1023/multi-version-collation/v1';

let passed = 0;
function assert(cond, label) {
  if (!cond) throw new Error(`断言失败：${label}`);
  passed += 1;
  console.log('  ✓', label);
}

async function makeStore() {
  const mod = await import(`./.tmp/test-bundle.mjs?cache=${Math.random()}`);
  return mod.makeStore();
}

// 用例一：确认留痕 + 正文/规则变化回到待复核，旧记录保留
{
  store.clear();
  const c = await makeStore();
  await c.runAlignment(false);
  const idx = c.rows.value.findIndex((r) => (r.status === 'changed' || r.status === 'misaligned') && r.id !== c.rows.value.at(-1).id);
  const changed = c.rows.value[idx];
  assert(!!changed, '自动对齐产生差异行');
  c.editorName.value = '整理者甲';
  let res = c.confirmRow(changed.id, '');
  assert(!res.ok, '缺依据不能确认');
  c.editorName.value = '';
  res = c.confirmRow(changed.id, '据底本');
  assert(!res.ok, '缺处理人不能确认');
  c.editorName.value = '整理者甲';
  c.rows.value.find((r) => r.id === changed.id).basis = '据某刻本及上下文';
  res = c.confirmRow(changed.id, '据某刻本及上下文');
  assert(res.ok, '处理人+依据齐全可以确认');
  let active = c.activeConfirmation(changed.id);
  assert(active?.state === 'valid', '确认后为有效状态');
  assert(active?.editor === '整理者甲' && active?.basis === '据某刻本及上下文', '档案记下处理人与依据');
  assert(active.leftSnapshot.text === changed.left.text && active.rulesSnapshot.ignorePunctuation === true, '档案含两侧正文与规则现场');

  c.shiftPairing(changed.id, 1);
  active = c.activeConfirmation(changed.id);
  assert(active?.state === 'review' && active.reviewReasons.includes('text'), '挪动配对后回到待复核（正文/配对变化）');

  const row = c.rows.value.find((r) => r.id === changed.id);
  row.basis = '复核后维持原判';
  c.confirmRow(changed.id, '复核后维持原判');
  const list = c.confirmations.value[changed.id];
  assert(list.length === 2, '行内留有两条档案');
  assert(list[0].state === 'invalidated' && list[1].state === 'valid', '旧档案失效保留，新档案有效');

  c.rules.value.ignoreVariants = false;
  c.recalculate();
  assert(c.activeConfirmation(changed.id)?.state === 'review', '规则变化后回到待复核');
  assert(c.activeConfirmation(changed.id)?.reviewReasons.includes('rules'), '待复核理由包含规则变化');

  c.withdrawConfirmation(changed.id);
  assert(c.activeConfirmation(changed.id)?.state === 'invalidated', '撤回后当前档案失效');
  assert(c.confirmations.value[changed.id].length === 2, '撤回不删除旧记录');
}

// 用例二：批量确认只覆盖当前搜索结果里写了依据的条目
{
  store.clear();
  const c = await makeStore();
  await c.runAlignment(false);
  c.editorName.value = '整理者乙';
  const diffs = c.rows.value.filter((r) => r.status !== 'same');
  diffs.slice(0, 3).forEach((r, i) => {
    if (i % 2 === 0) r.basis = '批量依据';
  });
  const withBasis = diffs.filter((r) => r.basis.trim());
  const { confirmed, skipped } = c.confirmRows(diffs.map((r) => r.id));
  assert(confirmed.length === withBasis.length, `只确认写了依据的条目（${confirmed.length} 条）`);
  assert(skipped.length === diffs.length - withBasis.length, `无依据条目被跳过（${skipped.length} 条）`);
  assert(confirmed.every((r) => c.activeConfirmation(r.id)?.state === 'valid'), '被确认条目均有效');
  assert(skipped.every((r) => !c.activeConfirmation(r.id)), '被跳过条目没有档案');

  // 无署名时一条也不确认
  store.clear();
  const c2 = await makeStore();
  await c2.runAlignment(false);
  c2.rows.value.filter((r) => r.status !== 'same').forEach((r) => (r.basis = 'x'));
  const out = c2.confirmRows(c2.rows.value.map((r) => r.id));
  assert(out.confirmed.length === 0 && out.skipped.length > 0, '未署名时批量确认全部跳过');
}

// 用例三：关掉页面再打开（localStorage 持久化）+ v1 迁移
{
  store.clear();
  const c = await makeStore();
  await c.runAlignment(false);
  c.editorName.value = '整理者丙';
  const target = c.rows.value.find((r) => r.status !== 'same');
  c.rows.value.find((r) => r.id === target.id).basis = '终审定稿依据';
  c.confirmRow(target.id, '终审定稿依据');

  const c2 = await makeStore();
  c2.restore(localStorage.getItem(V2_KEY));
  assert(c2.editorName.value === '整理者丙', '重开后处理人署名恢复');
  assert(c2.activeConfirmation(target.id)?.state === 'valid', '重开后有效确认仍在');
  assert(c2.activeConfirmation(target.id)?.basis === '终审定稿依据', '重开后依据与档案恢复');

  const v1 = JSON.parse(localStorage.getItem(V2_KEY));
  const oldRows = v1.rows.map((r) => {
    const copy = { ...r };
    delete copy.basis;
    return copy;
  });
  const someDiff = oldRows.find((r) => r.status !== 'same');
  someDiff.accepted = true;
  localStorage.removeItem(V2_KEY);
  localStorage.setItem(V1_KEY, JSON.stringify({ ...v1, rows: oldRows, version: 1 }));

  const c3 = await makeStore();
  c3.restore(localStorage.getItem(V1_KEY));
  const migrated = c3.activeConfirmation(someDiff.id);
  assert(!!migrated && migrated.state === 'review', 'v1 已接受标记迁移为待复核确认档案');
  assert(migrated.migrated === true, '迁移档案带 migrated 标记');
  assert(c3.rows.value.every((r) => r.accepted === undefined), '迁移后旧 accepted 字段清除');
}

// 用例四：重新对齐后确认档案按配对续接，接不上的归档
{
  store.clear();
  const c = await makeStore();
  await c.runAlignment(false);
  c.editorName.value = '整理者丁';
  const target = c.rows.value.find((r) => r.left && r.right && r.status !== 'same');
  c.rows.value.find((r) => r.id === target.id).basis = '对齐前确认';
  c.confirmRow(target.id, '对齐前确认');
  const pairKey = `${target.left.id}|${target.right.id}`;
  await c.runAlignment(true);
  const newRow = c.rows.value.find((r) => `${r.left?.id ?? '∅'}|${r.right?.id ?? '∅'}` === pairKey);
  assert(!!newRow, '同一对句段在新结果中存在');
  assert(!!c.activeConfirmation(newRow.id), '确认档案按配对续接到新行');

  const added = c.rows.value.find((r) => !r.left && r.right);
  assert(!!added, '示例数据存在右侧新增行');
  c.rows.value.find((r) => r.id === added.id).basis = '新增确认';
  c.confirmRow(added.id, '新增确认');
  c.rightVersionId.value = c.versions.value[2].id;
  await c.runAlignment(true);
  assert(c.archivedConfirmations.value.some((a) => a.basis === '新增确认'), '消失配对的确认进入归档并继续保留');
  assert(
    c.archivedConfirmations.value.some((a) => a.state === 'review' && a.reviewReasons.includes('superseded')),
    '归档记录标记为配对消失待复核'
  );
}

// 用例五：导出文件分别标出有效、待复核、已失效
{
  store.clear();
  const c = await makeStore();
  await c.runAlignment(false);
  c.editorName.value = '整理者戊';
  const diffs = c.rows.value.filter((r) => r.status !== 'same');
  const [a, b] = diffs;
  c.rows.value.find((r) => r.id === a.id).basis = '依据甲';
  c.confirmRow(a.id, '依据甲');
  c.rows.value.find((r) => r.id === b.id).basis = '依据乙';
  c.confirmRow(b.id, '依据乙');
  c.withdrawConfirmation(a.id);
  c.rules.value.ignorePunctuation = false;
  c.recalculate();

  const md = c.exportMarkdown();
  assert(md.includes('已失效'), 'Markdown 含已失效分区');
  assert(md.includes('⚠️ 待复核'), 'Markdown 标注待复核');
  assert(md.includes('处理人'), 'Markdown 含处理人列');

  const json = JSON.parse(c.exportJson());
  assert(json.schema === 'collation-v2', 'JSON 带 v2 schema 标记');
  assert(typeof json.summary.valid === 'number' && typeof json.summary.review === 'number', 'JSON 含有效/待复核统计');
  assert(json.invalidatedConfirmations.some((i) => i.basis === '依据甲'), 'JSON 含已失效确认清单');
  const rowB = json.rows.find((r) => r.id === b.id);
  assert(rowB.confirmation?.state === 'review', 'JSON 行内确认标注待复核');
}

console.log(`\n全部通过：${passed} 项断言`);
process.exit(0);
