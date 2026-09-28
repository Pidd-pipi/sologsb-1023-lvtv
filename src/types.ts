export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

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

/** 确认时的正文与规则快照，任一字段变化，确认即回到待复核 */
export interface ConfirmationSnapshot {
  leftText: string;
  rightText: string;
  note: string;
  source: string;
  status: DifferenceStatus;
  rules: ComparisonRules;
}

/** 确认失效原因 */
export type ConfirmationInvalidReason =
  | 'text'
  | 'note'
  | 'status'
  | 'rules'
  | 'alignment'
  | 'legacy'
  | 'withdrawn'
  | 'superseded';

export type ConfirmationState = 'active' | 'stale' | 'void';

export interface Confirmation {
  id: string;
  /** 处理人 */
  handler: string;
  /** 依据（确认时的校勘说明） */
  basis: string;
  source: string;
  createdAt: string;
  state: ConfirmationState;
  /** 确认时两侧正文与规则状态 */
  snapshot: ConfirmationSnapshot;
  /** 待复核或失效的原因，有效确认为空 */
  invalidReason?: ConfirmationInvalidReason;
  invalidDetail?: string;
  invalidAt?: string;
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  /** 兼容旧草稿：有效确认存在时即为 true */
  accepted: boolean;
  manuallyAdjusted: boolean;
  /** 确认历史，最新一条在末尾；旧记录始终保留 */
  confirmations: Confirmation[];
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  handler: string;
}
