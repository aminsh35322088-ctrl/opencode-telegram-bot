let activeGeminiWizard = false;

export function markGeminiWizard(): void {
  activeGeminiWizard = true;
}

export function clearGeminiWizard(): void {
  activeGeminiWizard = false;
}

export function isGeminiWizardActive(): boolean {
  return activeGeminiWizard;
}
