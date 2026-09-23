export {
  configureAutomationBusiness,
  type AutomationBusinessDeps,
  type AutomationAgentRunnerDeps,
  type AutomationNotificationSenderDeps,
} from './automation-business-deps'

export {
  computeNextRunAt,
  listAutomations,
  getAutomation,
  applyMaxRunsUpdate,
  normalizeAutomationScheduleFields,
  validateExplicitAutomationScheduleFields,
  getEffectiveAutomationScheduleFields,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  appendRun,
  setNextRunAt,
  setLastSessionId,
} from './automation-manager'

export {
  runAutomation,
  runAutomationNow,
  broadcastChanged,
  startScheduler,
  stopScheduler,
} from './automation-scheduler'

export { notifyAutomationRunFinished } from './automation-notification-service'

export {
  shouldNotifyAutomationTarget,
  extractAssistantText,
  buildAutomationFeishuCard,
} from './automation-notification-format'
