// P3-C r1 — Sanitizer dùng chung cho log + HTTP response vận hành (audit P1#2):
// message lỗi từ driver/exception có thể chứa connection string, token, header…
// Mọi text đi ra console.warn hoặc response body PHẢI qua đây trước.
// Pure — test bằng secret GIẢ (không bao giờ dùng credential thật trong test).

export function sanitizeOpsText(input: string): string {
  return input
    // CR/LF → space: chống log-injection (kẻ xấu chèn dòng log giả qua message)
    .replace(/[\r\n]+/g, ' ')
    // Connection string Mongo (mongodb:// và mongodb+srv://) — che toàn bộ phần sau scheme
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, 'mongodb$1://***')
    // Authorization bearer token (case-insensitive — 'bearer x' cũng phải che)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    // Cặp KEY=value / KEY: value của các secret đã biết + password nói chung
    .replace(/(MONGODB_AFFILIATE_URI|SUPABASE_SERVICE_ROLE_KEY|CRON_SECRET|BQ_SERVICE_ACCOUNT_KEY|QA_PASSWORD|password)\s*[=:]\s*[^\s"']+/gi, '$1=***')
}
