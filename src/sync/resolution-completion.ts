/** Persist non-critical resolution metadata without changing Git success. */
export async function persistResolutionMetadata(
  save: () => Promise<void>,
  onFailure: (error: unknown) => void
): Promise<void> {
  try {
    await save();
  } catch (error) {
    onFailure(error);
  }
}
