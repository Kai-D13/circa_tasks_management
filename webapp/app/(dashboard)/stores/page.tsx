import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate } from '@/lib/dateUtils'

export default async function StoresPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()

  if (profile?.role === 'staff') redirect('/dashboard')

  const { data: stores } = await supabase
    .from('stores')
    .select('*')
    .order('name')

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Danh sách cửa hàng</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên cửa hàng</TableHead>
                <TableHead>Mã POS</TableHead>
                <TableHead>Địa chỉ</TableHead>
                <TableHead>Ngày tạo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(stores ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono">{s.code}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.address ?? '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(s.created_at)}</TableCell>
                </TableRow>
              ))}
              {(stores ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    Chưa có cửa hàng nào
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
