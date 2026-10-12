// Gốc trang của 3 màn dược sĩ CSKH (B7-ui r2) — dùng chung cho trang thật và khung catalog để bố cục
// test/chụp đúng như production. `data-care-screen` bật nền ấm của artboard trên <main> (globals.css).
// Màn con (chi tiết / ghi nhận): cột flex cao tối thiểu bằng vùng cuộn <main> ⇒ thanh hành động đáy
// (mt-auto) sát đáy màn kể cả khi nội dung ngắn; desktop (md+) về bố cục thường có padding.
const ROOT = {
  list: 'md:space-y-4 md:p-6',
  detail: 'flex min-h-full flex-col md:block md:min-h-0 md:space-y-4 md:p-6',
  update: 'flex min-h-full flex-col md:mx-auto md:block md:min-h-0 md:max-w-2xl md:space-y-4 md:p-6',
} as const

export function CareMyScreen({ screen, children }: { screen: keyof typeof ROOT; children: React.ReactNode }) {
  return <div data-layout-width="fluid" data-care-screen={screen} className={ROOT[screen]}>{children}</div>
}
