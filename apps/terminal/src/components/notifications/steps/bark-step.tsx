// Copyright (c) 2026 Juan Ignacio Molina Estrada
// SPDX-License-Identifier: FSL-1.1-Apache-2.0
import { useTranslation } from 'react-i18next'
import { Handle, Position } from '@xyflow/react'
import { Smartphone } from 'lucide-react'
import { cn } from '@pairlens/ui'
import { Badge } from '@pairlens/ui/components/ui/badge'

import type { NodeProps } from '@xyflow/react'
import { useBarkConnection } from '@/hooks/use-bark-connection'
import { useSettingsDialogStore } from '@/stores/settings-dialog-store'

/**
 * The Bark channel node.
 *
 * It shows connection state because this is a channel that can sit on the
 * canvas and still deliver nothing: the device key lives in the keychain,
 * set up in Settings. A node that looked complete while nothing was
 * connected would fail silently at the first alert, so the unconnected
 * state is a button that goes and fixes it.
 */
export function BarkStep({ data }: NodeProps) {
  const { t } = useTranslation()
  const connection = useBarkConnection()
  const openSettings = useSettingsDialogStore((s) => s.open)

  let host = ''
  if (connection) {
    try {
      host = new URL(connection.origin).hostname
    } catch {
      host = connection.origin
    }
  }

  return (
    <div
      className={cn(
        'w-[210px] rounded-lg border border-blue-500/40 bg-card px-3 py-2.5',
        'shadow-sm shadow-blue-500/10',
        !!data.disconnected && 'border-blue-500/20 opacity-60',
        !!data.isNew && 'ring-1 ring-blue-400/50',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!size-3 !rounded-full !border-2 !border-blue-500 !bg-background"
      />

      <div className="flex items-center gap-2">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-500/15">
          <Smartphone className="size-3.5 text-blue-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground">
            {t('notifications.builder.steps.bark.title')}
          </div>
        </div>
        <Badge
          variant="outline"
          className="border-blue-500/30 text-[10px] text-blue-400"
        >
          {t('notifications.builder.category.channel')}
        </Badge>
      </div>

      <div className="mt-2 space-y-1.5">
        {connection ? (
          <div className="truncate font-mono text-[9px] text-muted-foreground">
            {host}
          </div>
        ) : (
          <>
            <p className="text-[9px] leading-relaxed text-muted-foreground">
              {t('notifications.builder.steps.bark.notConnected')}
            </p>
            <button
              type="button"
              className="nodrag nopan w-full rounded border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-[10px] font-medium text-blue-400 transition-colors hover:bg-blue-500/20"
              onClick={() => openSettings('notifications')}
            >
              {t('notifications.builder.steps.bark.connect')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
