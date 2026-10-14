import 'server-only'
import { careFlagsFromEnv } from './config'
import { careQaUiState } from './server/qaUi'

// Feature gate CRM-CSKH (SPEC B0). Mặc định OFF; chỉ bật ở bước rollout B6 sau
// migration + VERIFY + QA. Server-only — client nhận giá trị qua prop như
// KPI_CAMPAIGN_ENABLED (lib/kpi/flags.ts).

/**
 * CARE_ENABLED — nav, route, action CRM. B6-qa-ui: dev server bật CARE_QA_UI nhưng cổng QA chưa đạt
 * ⇒ CRM TẮT (fail-closed, không rơi về chế độ thường). Production: cổng QA luôn 'off'.
 */
export function isCareEnabled(): boolean {
  return careFlagsFromEnv(process.env).enabled && careQaUiState().kind !== 'blocked'
}

/** CARE_SYNC_ENABLED — cron care-period-close + care-orders-sync (B5). */
export function isCareSyncEnabled(): boolean {
  return careFlagsFromEnv(process.env).syncEnabled
}
