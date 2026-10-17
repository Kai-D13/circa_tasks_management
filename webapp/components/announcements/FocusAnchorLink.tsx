'use client'

// Link neo trong trang (#id) đưa cả FOCUS tới đích, không chỉ cuộn: hash link gốc chỉ cuộn (và router Next có thể xử
// lý lại việc đổi hash), nên người dùng bàn phím / trình đọc màn hình vẫn đứng ở link cũ. Khi JS chạy: tự cuộn + focus
// đích (đích phải có tabIndex={-1}), không đổi URL; không JS: href="#id" vẫn cuộn như thường.
export function FocusAnchorLink({ targetId, className, children, ...rest }: {
  targetId: string
  className?: string
  children: React.ReactNode
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  return (
    <a
      {...rest}
      href={`#${targetId}`}
      className={className}
      onClick={(e) => {
        const target = document.getElementById(targetId)
        if (!target) return
        e.preventDefault()
        target.scrollIntoView({ block: 'start', behavior: 'smooth' })
        target.focus({ preventScroll: true })
      }}
    >
      {children}
    </a>
  )
}
