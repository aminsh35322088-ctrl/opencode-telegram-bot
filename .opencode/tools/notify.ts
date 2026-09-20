import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Send notifications to Telegram. Supports text messages, alerts, and scheduled notifications.",
  args: {
    action: tool.schema.enum(["send", "alert", "schedule", "list", "cancel"]).describe("Notification action to execute."),
    message: tool.schema.string().describe("Notification message text."),
    target: tool.schema.string().optional().describe("Target chat ID (defaults to current chat)."),
    priority: tool.schema.enum(["low", "normal", "high", "urgent"]).optional().describe("Notification priority."),
    schedule: tool.schema.string().optional().describe("Schedule time for schedule action (ISO 8601 or relative like '1h', '30m')."),
    notification_id: tool.schema.string().optional().describe("Notification ID for cancel action."),
  },
  async execute(args, context) {
    const { action, message, target, priority, schedule, notification_id } = args;
    const chatId = target || context.chatId;
    const apiBase = process.env.OPENCODE_API_URL || "http://localhost:4096";

    async function apiCall(endpoint: string, method: string, body?: unknown): Promise<unknown> {
      const response = await fetch(`${apiBase}${endpoint}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        const error = await response.text().catch(() => "");
        throw new Error(`API error ${response.status}: ${error || response.statusText}`);
      }
      return response.json();
    }

    switch (action) {
      case "send": {
        await apiCall("/notification/send", "POST", {
          chatId,
          message,
          priority: priority || "normal",
        });
        return `Notification sent to chat ${chatId}`;
      }
      case "alert": {
        const emoji = priority === "urgent" ? "🚨" : priority === "high" ? "⚠️" : "ℹ️";
        await apiCall("/notification/send", "POST", {
          chatId,
          message: `${emoji} ${message}`,
          priority: priority || "high",
        });
        return `Alert sent to chat ${chatId}`;
      }
      case "schedule": {
        if (!schedule) throw new Error("Schedule time required. Provide: schedule=\"1h\" or schedule=\"2024-01-01T10:00:00Z\"");
        let scheduledTime: Date;
        if (schedule.match(/^\d+[mh]$/)) {
          const value = parseInt(schedule.slice(0, -1));
          const unit = schedule.slice(-1);
          scheduledTime = new Date(Date.now() + value * (unit === "h" ? 3600000 : 60000));
        } else {
          scheduledTime = new Date(schedule);
        }
        if (isNaN(scheduledTime.getTime())) throw new Error("Invalid schedule time format");
        await apiCall("/notification/schedule", "POST", {
          chatId,
          message,
          scheduledTime: scheduledTime.toISOString(),
          priority: priority || "normal",
        });
        return `Notification scheduled for ${scheduledTime.toISOString()}`;
      }
      case "list": {
        const notifications = await apiCall("/notification/list", "GET") as Array<{
          id: string;
          message: string;
          scheduledTime?: string;
        }>;
        if (!notifications.length) return "No scheduled notifications";
        return notifications.map((n) => `${n.id}: ${n.message} (${n.scheduledTime || "pending"})`).join("\n");
      }
      case "cancel": {
        if (!notification_id) throw new Error("notification_id required for cancel");
        await apiCall(`/notification/${notification_id}`, "DELETE");
        return `Notification ${notification_id} cancelled`;
      }
      default:
        throw new Error(`Unknown notification action: ${action}`);
    }
  },
});
