import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { FileText, Image as ImageIcon, Link as LinkIcon, Music } from 'lucide-react'
import { TaskAttachment } from '@/types'

interface Props {
  inputData: Record<string, unknown>
}

export function InputDataDisplay({ inputData }: Props) {
  const rows        = inputData.rows        as Record<string, string>[] | undefined
  const posCode     = inputData.pos_code    as string | undefined
  const fileName    = inputData.file_name   as string | undefined
  const rowCount    = inputData.row_count   as number | undefined
  const attachments = inputData.attachments as TaskAttachment[] | undefined
  const links       = inputData.links       as { label: string; url: string }[] | undefined

  const hasAttachments = attachments && attachments.length > 0
  const hasLinks       = links && links.length > 0
  const hasRows        = rows && rows.length > 0

  if (!hasAttachments && !hasLinks && !hasRows) return null

  return (
    <div className="space-y-4">
      {/* Attachments — images display inline, files as download links */}
      {hasAttachments && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tài liệu đính kèm</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Image previews */}
            {attachments.filter((a) => a.type.startsWith('image/')).length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments
                  .filter((a) => a.type.startsWith('image/'))
                  .map((att, i) => (
                    <a key={i} href={att.url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={att.url}
                        alt={att.name}
                        className="h-24 w-24 object-cover rounded border hover:opacity-80 transition-opacity"
                      />
                    </a>
                  ))}
              </div>
            )}
            {/* Audio players */}
            {attachments
              .filter((a) => a.type.startsWith('audio/'))
              .map((att, i) => (
                <div key={`audio-${i}`} className="p-2 border rounded bg-muted/20 space-y-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <Music className="h-4 w-4 text-muted-foreground shrink-0" />
                    <a href={att.url} target="_blank" rel="noopener noreferrer" className="flex-1 truncate text-primary hover:underline">
                      {att.name}
                    </a>
                  </div>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio controls preload="none" src={att.url} className="w-full h-9" />
                </div>
              ))}

            {/* Other files (non-image, non-audio) */}
            {attachments
              .filter((a) => !a.type.startsWith('image/') && !a.type.startsWith('audio/'))
              .map((att, i) => (
                <a
                  key={i}
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-2 border rounded text-sm hover:bg-muted/40 transition-colors"
                >
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 truncate text-primary">{att.name}</span>
                  {att.size && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {att.size < 1024 * 1024
                        ? `${(att.size / 1024).toFixed(0)}KB`
                        : `${(att.size / 1024 / 1024).toFixed(1)}MB`}
                    </span>
                  )}
                </a>
              ))}
          </CardContent>
        </Card>
      )}

      {/* Links */}
      {hasLinks && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Đường dẫn</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {links.map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-primary hover:underline"
              >
                <LinkIcon className="h-3.5 w-3.5 shrink-0" />
                {link.label || link.url}
              </a>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Bulk import rows table */}
      {hasRows && (
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
                    {Object.keys(rows[0]).map((h) => (
                      <TableHead key={h} className="text-xs whitespace-nowrap px-3 py-2">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, i) => (
                    <TableRow key={i}>
                      {Object.keys(rows[0]).map((h) => (
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
      )}
    </div>
  )
}
