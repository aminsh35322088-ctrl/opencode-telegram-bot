import type { ParsedTaskSchedule, ScheduledTaskModel, TaskCreationState } from "../types/scheduled-task.js";
import { cloneParsedTaskSchedule, cloneScheduledTaskModel } from "../types/scheduled-task.js";
import { logger } from "../../utils/logger.js";
import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";

function cloneState(state: TaskCreationState): TaskCreationState {
  return {
    ...state,
    model: cloneScheduledTaskModel(state.model),
    parsedSchedule: state.parsedSchedule ? cloneParsedTaskSchedule(state.parsedSchedule) : null,
  };
}

class TaskCreationManager {
  private readonly states = new Map<string, TaskCreationState | null>();

  private key(): string {
    const topic = getTopicRuntimeContext();
    return topic ? `${topic.chatId}:${topic.threadId}` : "__main__";
  }

  private state(): TaskCreationState | null {
    const key = this.key();
    if (!this.states.has(key)) this.states.set(key, null);
    return this.states.get(key) ?? null;
  }

  start(
    projectId: string,
    projectWorktree: string,
    model: ScheduledTaskModel,
    agent: string,
  ): TaskCreationState {
    const state: TaskCreationState = {
      stage: "awaiting_schedule",
      projectId,
      projectWorktree,
      agent,
      model: cloneScheduledTaskModel(model),
      scheduleText: null,
      parsedSchedule: null,
      scheduleRequestMessageId: null,
      previewMessageId: null,
      promptRequestMessageId: null,
    };
    this.states.set(this.key(), state);

    logger.info(`[TaskCreationManager] Started task creation flow for project=${projectWorktree}`);

    return cloneState(state);
  }

  isActive(): boolean {
    return this.state() !== null;
  }

  isWaitingForSchedule(): boolean {
    return this.state()?.stage === "awaiting_schedule";
  }

  isParsingSchedule(): boolean {
    return this.state()?.stage === "parsing_schedule";
  }

  isWaitingForPrompt(): boolean {
    return this.state()?.stage === "awaiting_prompt";
  }

  getState(): TaskCreationState | null {
    const s = this.state();
    return s ? cloneState(s) : null;
  }

  setParsedSchedule(
    scheduleText: string,
    parsedSchedule: ParsedTaskSchedule,
    previewMessageId: number,
  ): TaskCreationState | null {
    const current = this.state();
    if (!current) return null;

    const updated: TaskCreationState = {
      ...current,
      stage: "awaiting_prompt",
      scheduleText,
      parsedSchedule: cloneParsedTaskSchedule(parsedSchedule),
      scheduleRequestMessageId: null,
      previewMessageId,
      promptRequestMessageId: null,
    };
    this.states.set(this.key(), updated);

    logger.info("[TaskCreationManager] Parsed schedule and switched flow to prompt input");

    return cloneState(updated);
  }

  markScheduleParsing(): TaskCreationState | null {
    const current = this.state();
    if (!current) return null;

    const updated: TaskCreationState = { ...current, stage: "parsing_schedule" };
    this.states.set(this.key(), updated);

    logger.info("[TaskCreationManager] Schedule parsing started");

    return cloneState(updated);
  }

  setPromptRequestMessageId(messageId: number): TaskCreationState | null {
    const current = this.state();
    if (!current) return null;

    const updated: TaskCreationState = { ...current, promptRequestMessageId: messageId };
    this.states.set(this.key(), updated);

    return cloneState(updated);
  }

  setScheduleRequestMessageId(messageId: number): TaskCreationState | null {
    const current = this.state();
    if (!current) return null;

    const updated: TaskCreationState = { ...current, scheduleRequestMessageId: messageId };
    this.states.set(this.key(), updated);

    return cloneState(updated);
  }

  resetSchedule(): TaskCreationState | null {
    const current = this.state();
    if (!current) return null;

    const updated: TaskCreationState = {
      ...current,
      stage: "awaiting_schedule",
      scheduleText: null,
      parsedSchedule: null,
      scheduleRequestMessageId: null,
      previewMessageId: null,
      promptRequestMessageId: null,
    };
    this.states.set(this.key(), updated);

    logger.info("[TaskCreationManager] Reset task creation flow back to schedule input");

    return cloneState(updated);
  }

  clear(): void {
    const key = this.key();
    if (this.states.get(key) === undefined) return;

    logger.debug("[TaskCreationManager] Clearing task creation state");
    this.states.delete(key);
  }
}

export const taskCreationManager = new TaskCreationManager();
