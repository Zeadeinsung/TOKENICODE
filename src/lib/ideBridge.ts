import { invoke } from '@tauri-apps/api/core';
import { useFileStore } from '../stores/fileStore';

export interface IdeSelection {
  text: string;
  /** 0-based line number, matching the CLI's diagnostics/selection shape. */
  lineStart: number;
  lineCount: number;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

function forwardSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

function languageId(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Push the editor state the IDE bridge serves to the CLI. The bridge keeps the
 * latest snapshot and answers mcp__ide__getOpenEditors / getCurrentSelection
 * from it; nothing here touches the session process directly.
 */
export function pushIdeState(selection: IdeSelection | null): void {
  const s = useFileStore.getState();
  const active = s.selectedFile;
  const activePath = active ? forwardSlashes(active) : null;

  const openEditors = activePath
    ? [{
        file_path: activePath,
        is_active: true,
        is_dirty: s.editContent !== null && s.editContent !== s.fileContent,
        language_id: languageId(activePath),
      }]
    : [];

  const currentSelection = activePath && selection
    ? {
        file_path: activePath,
        text: selection.text,
        selection: selection.selection,
        line_start: selection.lineStart,
        line_count: selection.lineCount,
      }
    : null;

  void invoke('ide_update_editor_state', {
    payload: {
      workspace_folders: s.rootPath ? [forwardSlashes(s.rootPath)] : [],
      open_editors: openEditors,
      current_selection: currentSelection,
      latest_selection: currentSelection,
      active_file: activePath,
    },
  }).catch(() => {
    // Bridge unavailable (browser dev mode, or it failed to bind) — ignore.
  });
}

/**
 * Start mirroring fileStore changes into the bridge. Returns an unsubscribe
 * function so React StrictMode's double-effect doesn't leave duplicate
 * subscriptions behind.
 */
export function initIdeBridge(): () => void {
  pushIdeState(null);
  const unsubscribe = useFileStore.subscribe((state, prev) => {
    if (state.selectedFile !== prev.selectedFile || state.rootPath !== prev.rootPath) {
      pushIdeState(null);
    }
  });
  return unsubscribe;
}
