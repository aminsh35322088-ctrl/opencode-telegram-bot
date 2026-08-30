const activeGeminiWizards = new Set<number>();

export function markGeminiWizard(chatId: number): void {
  activeGeminiWizards.add(chatId);
}

export function clearGeminiWizard(chatId: number): void {
  activeGeminiWizards.delete(chatId);
}

export function isGeminiWizardActive(chatId: number): boolean {
  return activeGeminiWizards.has(chatId);
}
