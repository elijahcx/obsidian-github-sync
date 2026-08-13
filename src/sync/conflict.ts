import { ConflictFile } from "../types";

/**
 * Produce a simple line-by-line diff summary between ours and theirs.
 * Used in the conflict modal to help the user decide.
 */
export function diffSummary(conflict: ConflictFile): string {
  if (conflict.isBinary) return "Binary file — choose a side to preserve its exact bytes.";
  const oursLines   = conflict.ours.split("\n");
  const theirsLines = conflict.theirs.split("\n");

  const maxLen = Math.max(oursLines.length, theirsLines.length);
  const diffLines: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const a = oursLines[i]   ?? "";
    const b = theirsLines[i] ?? "";
    if (a !== b) {
      diffLines.push(`Line ${i + 1}:`);
      if (a) diffLines.push(`  - ${a}`);
      if (b) diffLines.push(`  + ${b}`);
    }
  }

  return diffLines.length > 0
    ? diffLines.join("\n")
    : "(files are identical — safe to accept either)";
}
