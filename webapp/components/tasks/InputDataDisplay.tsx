import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Props {
  inputData: Record<string, unknown>
}

export function InputDataDisplay({ inputData }: Props) {
  const rows = inputData.rows as Record<string, string>[] | undefined
  const posCode = inputData.pos_code as string | undefined
  const fileName = inputData.file_name as string | undefined
  const rowCount = inputData.row_count as number | undefined

  if (!rows || rows.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Dữ liệu task</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-40">
            {JSON.stringify(inputData, null, 2)}
          </pre>
        </CardContent>
      </Card>
    )
  }

  const headers = Object.keys(rows[0])

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">
            Chi tiết dữ liệu
            {rowCount && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({rowCount} dòng)
              </span>
            )}
          </CardTitle>
          {(posCode || fileName) && (
            <div className="text-xs text-muted-foreground space-x-3">
              {posCode && <span>POS: <strong>{posCode}</strong></span>}
              {fileName && <span>File: {fileName}</span>}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto max-h-80">
          <Table>
            <TableHeader>
              <TableRow>
                {headers.map((h) => (
                  <TableHead key={h} className="text-xs whitespace-nowrap px-3 py-2">
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  {headers.map((h) => (
                    <TableCell key={h} className="text-xs px-3 py-1.5 whitespace-nowrap">
                      {row[h] ?? '—'}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
