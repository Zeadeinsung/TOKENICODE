import { describe, expect, it } from 'vitest';
import { explainShellCommand } from '../activity-text';

describe('explainShellCommand', () => {
  it('explains a timeout-wrapped type check with a log redirect', () => {
    const command = 'timeout 180 ./node_modules/.bin/tsc --noEmit > /d/CogniFlow/.run/tsc_label.log 2>&1; echo EXIT=$?; tail -10 /d/CogniFlow/.run/tsc_label.log';
    expect(explainShellCommand(command)).toBe(
      '类型检查 TypeScript 项目（限时 180 秒，结果写入 .run/tsc_label.log）',
    );
  });

  it('explains package scripts', () => {
    expect(explainShellCommand('npm run build')).toBe('构建项目');
    expect(explainShellCommand('pnpm test')).toBe('运行测试');
    expect(explainShellCommand('npm run lint')).toBe('代码检查');
  });

  it('skips cd prefix', () => {
    expect(explainShellCommand('cd /d/CogniFlow && npm run lint')).toBe('代码检查');
  });

  it('unwraps npx and npm exec', () => {
    expect(explainShellCommand('npx vitest run')).toBe('运行测试');
    expect(explainShellCommand('npm exec tsc --noEmit')).toBe('类型检查 TypeScript 项目');
  });

  it('explains common commands', () => {
    expect(explainShellCommand('git status')).toBe('查看 git 状态');
    expect(explainShellCommand('git commit -m "x"')).toBe('提交代码');
    expect(explainShellCommand('python -m pytest -q')).toBe('运行 Python 测试');
    expect(explainShellCommand('grep -rn "foo" src')).toBe('搜索文本');
    expect(explainShellCommand('cat package.json')).toBe('查看文件内容');
    expect(explainShellCommand('rm -rf dist')).toBe('删除文件');
  });

  it('ignores /dev/null redirects', () => {
    expect(explainShellCommand('npm run build > /dev/null 2>&1')).toBe('构建项目');
  });

  it('returns empty for unknown commands', () => {
    expect(explainShellCommand('frobnicate --now')).toBe('');
  });
});
