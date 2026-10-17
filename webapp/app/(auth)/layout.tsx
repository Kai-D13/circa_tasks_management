import { ThemeProvider } from '@/components/providers/ThemeProvider'

// UI v2 Login: màn đăng nhập theo CÙNG lựa chọn sáng/tối đang dùng của app (next-themes, localStorage 'theme',
// mặc định light, không theo HĐH) — như layout dashboard. next-themes gắn class trước khi vẽ ⇒ không nháy theme.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>
}
