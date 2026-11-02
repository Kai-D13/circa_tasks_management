// Stub cho gói `server-only` khi script operator nạp module server bằng jiti NGOÀI Next (vd. cms-bootstrap-products.mjs).
// Gói thật ném lỗi khi import ngoài react-server; script chạy trên máy operator (không phải bundle client) nên an toàn.
export {}
