import 'server-only'
import { MongoClient } from 'mongodb'
import type { SourceOrderDoc } from '@/lib/affiliate/normalize'

// MongoDB Circa Online — SERVER-ONLY (stakeholder P2: UI tuyệt đối không query
// Mongo trực tiếp; chỉ cron/route dùng). Singleton cached trên globalThis để
// hot-reload dev không leak connection. Timeout ngắn: tổng thời gian route
// luôn << lease 15 phút của rpc_start_affiliate_sync.
// KHÔNG log URI/credentials.

const g = globalThis as unknown as { __affiliateMongoClient?: MongoClient }

const DB_NAME = process.env.AFFILIATE_MONGO_DB ?? 'circa-online_prd_order'
const COLLECTION = process.env.AFFILIATE_MONGO_COLLECTION ?? 'order'

export function getAffiliateMongo(): MongoClient {
  const uri = process.env.MONGODB_AFFILIATE_URI
  if (!uri) throw new Error('MONGODB_AFFILIATE_URI chưa cấu hình')
  if (!g.__affiliateMongoClient) {
    g.__affiliateMongoClient = new MongoClient(uri, {
      maxPoolSize: 3,
      serverSelectionTimeoutMS: 15_000,
      connectTimeoutMS: 15_000,
      socketTimeoutMS: 60_000,
    })
  }
  return g.__affiliateMongoClient
}

// Projection TỐI THIỂU (audit P2): không kéo admin_note/system_note/payment
// payload/địa chỉ/orderItems. Marker = affiliate_partner_code non-empty
// (data contract D0 — KHÔNG dùng tag AFFILIATE_FS vì 40 đơn cũ thiếu tag).
const PROJECTION = {
  _id: 0,
  order_id: 1,
  order_code: 1,
  pos_order_code: 1,
  affiliate_partner_code: 1,
  status: 1,
  sale_order_status: 1,
  total_price: 1,
  total_item: 1,
  'first_item.product_name': 1,
  customer_name: 1,
  customer_phone: 1,
  created_time: 1,
  confirmed_time: 1,
  last_updated_time: 1,
} as const

// Pull TOÀN BỘ snapshot subset affiliate vào memory trước khi ghi DB
// (stakeholder F2 #5 — ~150 đơn hiện tại, loại nguy cơ cursor đứt giữa upsert).
// Không cửa sổ thời gian: mỗi run = full reconciliation (thiết kế plan §3).
export async function fetchAffiliateOrdersSnapshot(): Promise<SourceOrderDoc[]> {
  const client = getAffiliateMongo()
  await client.connect()
  return client
    .db(DB_NAME)
    .collection(COLLECTION)
    .find(
      { affiliate_partner_code: { $exists: true, $nin: [null, ''] } },
      { projection: PROJECTION },
    )
    .toArray() as Promise<SourceOrderDoc[]>
}
