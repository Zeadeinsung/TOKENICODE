import { useFileStore } from '../../stores/fileStore';
import { useT } from '../../lib/i18n';
import { FilePreview } from '../files/FilePreview';

/**
 * 侧边栏「预览」标签的容器：选中文件时渲染 FilePreview，
 * 未选中时展示空状态提示（FilePreview 在无选中文件时直接返回 null）。
 */
export function PreviewPanel() {
  const t = useT();
  const selectedFile = useFileStore((s) => s.selectedFile);

  if (!selectedFile) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6
        gap-3 text-center">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.2"
          className="text-text-tertiary/40">
          <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5z" />
          <circle cx="12" cy="12" r="4" />
        </svg>
        <p className="text-xs text-text-tertiary leading-relaxed">
          {t('panel.previewEmpty')}
        </p>
      </div>
    );
  }

  return <FilePreview />;
}
