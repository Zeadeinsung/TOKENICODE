import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useChatStore } from '../stores/chatStore';

interface PermissionResolvedPayload {
  stdinId?: string;
  requestId?: string;
  toolUseId?: string;
  allow?: boolean;
  source?: string;
}

/**
 * A permission or AskUserQuestion card can be answered from the phone. The
 * desktop's own copy has no way to find out — the CLI simply proceeds with the
 * tool, and no stream event says "this request is closed". Without this the card
 * sits there interactive forever, and answering it again would send a second
 * control_response for a request the CLI already consumed.
 *
 * The hub re-emits every resolution (from either end) as `permission:resolved`;
 * this marks the matching message resolved so the card flips to its readout.
 */
export function useRemotePermissionSync() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<PermissionResolvedPayload>('permission:resolved', (e) => {
      const { stdinId, requestId } = e.payload || {};
      if (!stdinId || !requestId) return;
      const { tabs, setInteractionState } = useChatStore.getState();
      for (const tab of tabs.values()) {
        if (tab.sessionMeta.stdinId !== stdinId) continue;
        for (const m of tab.messages) {
          if (m.permissionData?.requestId === requestId && !m.resolved) {
            setInteractionState(tab.tabId, m.id, 'resolved');
          }
        }
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);
}
