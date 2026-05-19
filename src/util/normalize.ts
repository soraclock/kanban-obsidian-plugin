import { STATUS_VALUES, type Status } from "../data/TaskSchema";

const STATUS_ALIAS: Record<string, Status> = {
  todo: "未着手",
  inprogress: "進行中",
  "in progress": "進行中",
  in_progress: "進行中",
  review: "確認待ち",
  "in review": "確認待ち",
  done: "完了",
  completed: "完了",
  complete: "完了",
  frozen: "凍結",
  freeze: "凍結",
};

export function normalizeStatus(raw: string): Status | null {
  const trimmed = raw.trim().normalize("NFC");
  if ((STATUS_VALUES as readonly string[]).includes(trimmed)) {
    return trimmed as Status;
  }
  const lower = trimmed.toLowerCase();
  return STATUS_ALIAS[lower] ?? null;
}

export function normalizeTag(raw: string): string {
  return raw.trim().normalize("NFC").toLowerCase();
}

/**
 * 表記揺れ検出用：trim/NFC/lowercase 適用前と後で異なる場合は揺れている。
 */
export function statusHasVariance(raw: string): { variant: boolean; canonical: Status | null } {
  const trimmed = raw.trim().normalize("NFC");
  const matchExact = (STATUS_VALUES as readonly string[]).includes(trimmed);
  if (matchExact && trimmed === raw) {
    return { variant: false, canonical: trimmed as Status };
  }
  return { variant: true, canonical: normalizeStatus(raw) };
}
