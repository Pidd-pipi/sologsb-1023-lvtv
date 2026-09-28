export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

/** 确认状态：有效（与现场一致）/ 待复核（现场已变）/ 已失效（被新确认取代或撤回） */
export type ConfirmationState = 'valid' | 'review' | 'invalidated';

export type ReviewReason = 'text' | 'rules' | 'annotation' | 'manual' | 'judgment' | 'superseded';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

/** 确认时生效的比较规则快照 */
export interface RulesSnapshot {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  /** 确认依据：每次确认时必填并留档 */
  basis: string;
  /** @deprecated 旧版遗留字段，已迁移到 confirmations；保留仅为兼容旧数据 */
  accepted?: boolean;
  manuallyAdjusted: boolean;
}

/**
 * 一次确认留下的档案。
 * 确认后正文、配对或规则一旦变化，state 由 valid 变为 review（旧记录仍保留）；
 * 重新确认或撤回时变为 invalidated，并写明失效原因。
 */
export interface ConfirmationRecord {
  id: string;
  rowId: string;
  editor: string;
  basis: string;
  confirmedAt: string;
  /** 确认时底本侧正文现场：句段 id + 文本 */
  leftSnapshot: { unitId?: string; text: string };
  /** 确认时参校本侧正文现场：句段 id + 文本 */
  rightSnapshot: { unitId?: string; text: string };
  /** 确认时的差异判断 */
  statusSnapshot: DifferenceStatus;
  /** 确认时的比较规则现场 */
  rulesSnapshot: RulesSnapshot;
  /** 确认时的校记与来源现场 */
  noteSnapshot: string;
  sourceSnapshot: string;
  state: ConfirmationState;
  reviewReasons: ReviewReason[];
  reviewedAt?: string;
  invalidatedAt?: string;
  /** true 表示由 v1 版本的 accepted 标记迁移而来，等待补录处理人与依据 */
  migrated?: boolean;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface PersistedCollationState {
  version: 2;
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  /** 当前整理者署名，确认时写入档案；可随时切换，不入撤销历史 */
  editorName: string;
  /** 按行保存的确认档案，每行至多一条处于 valid/review，其余均为 invalidated */
  confirmations: Record<string, ConfirmationRecord[]>;
  /** 重新对齐后已消失行的确认档案，继续留痕并随导出保留 */
  archivedConfirmations: ConfirmationRecord[];
}
