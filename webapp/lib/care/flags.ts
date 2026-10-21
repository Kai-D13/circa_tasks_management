import 'server-only'
import { careFlagsFromEnv, careImportCancelEnabledFromEnv, careOrderLinksFlagsFromEnv } from './config'
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

/** CARE_IMPORT_CANCEL_ENABLED — huỷ file import (D1). Cần cả CARE_ENABLED; migration 115 phải đã chạy trước khi bật. */
export function isCareImportCancelEnabled(): boolean {
  return isCareEnabled() && careImportCancelEnabledFromEnv(process.env)
}

/** CARE_ORDER_LINKS_SYNC_ENABLED — lượt thường + lượt chốt đơn sau import (E). Cần CARE_ENABLED; migration 116 phải đã chạy. */
export function isCareOrderLinksSyncEnabled(): boolean {
  return isCareEnabled() && careOrderLinksFlagsFromEnv(process.env).sync
}

/** CARE_ORDER_LINKS_UI_ENABLED — hiển thị đơn xác thực sau import (E). Cần CARE_ENABLED. */
export function isCareOrderLinksUiEnabled(): boolean {
  return isCareEnabled() && careOrderLinksFlagsFromEnv(process.env).ui
}

/** CARE_ORDER_LINKS_TRIAL_ENABLED — route trial của E (tạm). Cần CARE_ENABLED; độc lập cờ sync. */
export function isCareOrderLinksTrialEnabled(): boolean {
  return isCareEnabled() && careOrderLinksFlagsFromEnv(process.env).trial
}
