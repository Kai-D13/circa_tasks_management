import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate } from '@/lib/dateUtils'

const REGION_LABEL: Record<string, string> = {
  north:   'Miền Bắc',
  central: 'Miền Trung',
  south:   'Miền Nam',
}
const REGION_COLOR: Record<string, string> = {
  north:   'bg-blue-100 text-blue-700',
  central: 'bg-amber-100 text-amber-700',
  south:   'bg-green-100 text-green-700',
}

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
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Danh sách cửa hàng</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên cửa hàng</TableHead>
                <TableHead>Mã POS</TableHead>
                <TableHead>Vùng</TableHead>
                <TableHead>Địa chỉ</TableHead>
                <TableHead>Ngày tạo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(stores ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono">{s.code}</TableCell>
                  <TableCell>
                    {s.region ? (
                      <Badge className={REGION_COLOR[s.region] ?? 'bg-gray-100 text-gray-600'}>
                        {REGION_LABEL[s.region] ?? s.region}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">Chưa gán</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.address ?? '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(s.created_at)}</TableCell>
                </TableRow>
              ))}
              {(stores ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
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
