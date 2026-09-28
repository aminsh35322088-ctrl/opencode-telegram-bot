import type { Question, QuestionState, QuestionAnswer } from "../types/question.js";
import { logger } from "../../utils/logger.js";
import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";

type ScopedQuestionState = QuestionState & { chatId: number | null };
const emptyState = (): ScopedQuestionState => ({ questions: [], currentIndex: 0, selectedOptions: new Map(), customAnswers: new Map(), customInputQuestionIndex: null, activeMessageId: null, messageIds: [], isActive: false, requestID: null, chatId: null });
class QuestionManager {
  private readonly states = new Map<string, ScopedQuestionState>();
  private key(): string { const topic = getTopicRuntimeContext(); return topic ? `${topic.chatId}:${topic.threadId}` : "__main__"; }
  private state(): ScopedQuestionState { const key = this.key(); let state = this.states.get(key); if (!state) { state = emptyState(); this.states.set(key, state); } return state; }
  startQuestions(questions: Question[], requestID: string): void { const state = this.state(); if (state.isActive) this.clear(); this.states.set(this.key(), { ...emptyState(), questions, isActive: true, requestID }); logger.info(`[QuestionManager] Started question flow: key=${this.key()}, requestID=${requestID}`); }
  setChatId(chatId: number): void { this.state().chatId = chatId; }
  getChatId(): number | null { return this.state().chatId; }
  isActiveForChat(chatId: number | undefined): boolean { const state = this.state(); return state.isActive && chatId !== undefined && (state.chatId === null || state.chatId === chatId); }
  getRequestID(): string | null { return this.state().requestID; }
  getCurrentQuestion(): Question | null { const state = this.state(); return state.questions[state.currentIndex] ?? null; }
  selectOption(questionIndex: number, optionIndex: number): void { const state = this.state(); if (!state.isActive) return; const question = state.questions[questionIndex]; if (!question) return; const selected = state.selectedOptions.get(questionIndex) || new Set<number>(); if (question.multiple) { if (selected.has(optionIndex)) selected.delete(optionIndex); else selected.add(optionIndex); } else { selected.clear(); selected.add(optionIndex); } state.selectedOptions.set(questionIndex, selected); }
  getSelectedOptions(questionIndex: number): Set<number> { return this.state().selectedOptions.get(questionIndex) || new Set<number>(); }
  getSelectedAnswer(questionIndex: number): string { const state = this.state(); const question = state.questions[questionIndex]; if (!question) return ""; return Array.from(state.selectedOptions.get(questionIndex) || new Set<number>()).flatMap((idx) => { const option = question.options[idx]; return option ? [`* ${option.label}: ${option.description}`] : []; }).join("\n"); }
  setCustomAnswer(questionIndex: number, answer: string): void { this.state().customAnswers.set(questionIndex, answer); }
  getCustomAnswer(questionIndex: number): string | undefined { return this.state().customAnswers.get(questionIndex); }
  hasCustomAnswer(questionIndex: number): boolean { return this.state().customAnswers.has(questionIndex); }
  nextQuestion(): void { const state = this.state(); state.currentIndex++; state.customInputQuestionIndex = null; state.activeMessageId = null; }
  hasNextQuestion(): boolean { const state = this.state(); return state.currentIndex < state.questions.length; }
  getCurrentIndex(): number { return this.state().currentIndex; }
  getTotalQuestions(): number { return this.state().questions.length; }
  addMessageId(messageId: number): void { this.state().messageIds.push(messageId); }
  setActiveMessageId(messageId: number): void { this.state().activeMessageId = messageId; }
  getActiveMessageId(): number | null { return this.state().activeMessageId; }
  isActiveMessage(messageId: number | null): boolean { const state = this.state(); return state.isActive && state.activeMessageId !== null && messageId === state.activeMessageId; }
  startCustomInput(questionIndex: number): void { const state = this.state(); if (!state.isActive || !state.questions[questionIndex]) return; state.customInputQuestionIndex = questionIndex; }
  clearCustomInput(): void { this.state().customInputQuestionIndex = null; }
  isWaitingForCustomInput(questionIndex: number): boolean { return this.state().customInputQuestionIndex === questionIndex; }
  getMessageIds(): number[] { return [...this.state().messageIds]; }
  isActive(): boolean { return this.state().isActive; }
  cancel(): void { const state = this.state(); state.isActive = false; state.customInputQuestionIndex = null; state.activeMessageId = null; }
  clear(): void { this.states.set(this.key(), emptyState()); }
  clearSession(scopeKey: string): void { this.states.delete(scopeKey); }
  clearAll(): void { this.states.clear(); }
  getAllAnswers(): QuestionAnswer[] { const state = this.state(); const answers: QuestionAnswer[] = []; for (let i = 0; i < state.questions.length; i++) { const question = state.questions[i]; if (!question) continue; const answer = this.getCustomAnswer(i) || this.getSelectedAnswer(i); if (answer) answers.push({ question: question.question, answer }); } return answers; }
}
export const questionManager = new QuestionManager();
