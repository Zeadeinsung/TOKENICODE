import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chatStore';
import { extractCcTasks } from '../cc-tasks';

function toolCall(id: string, toolName: string, toolInput: any, toolResultContent?: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    type: 'tool_use',
    content: '',
    toolName,
    toolInput,
    toolResultContent,
    timestamp: 0,
  };
}

describe('extractCcTasks', () => {
  it('replays create and update calls in order', () => {
    const tasks = extractCcTasks([
      toolCall('t1', 'TaskCreate', { subject: '梳理数据链路', activeForm: '正在梳理数据链路' }, '{"task":{"id":"1","subject":"梳理数据链路"}}'),
      toolCall('t2', 'TaskCreate', { subject: '实现浮窗', activeForm: '正在实现浮窗' }, '{"task":{"id":"2","subject":"实现浮窗"}}'),
      toolCall('t3', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      toolCall('t4', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ]);

    expect(tasks).toEqual([
      { id: '1', content: '梳理数据链路', status: 'completed', activeForm: '正在梳理数据链路' },
      { id: '2', content: '实现浮窗', status: 'pending', activeForm: '正在实现浮窗' },
    ]);
  });

  it('adopts an unkeyed create when a later update reveals the real id', () => {
    const tasks = extractCcTasks([
      toolCall('t1', 'TaskCreate', { subject: '构建项目' }),
      toolCall('t2', 'TaskUpdate', { taskId: '7', status: 'in_progress' }),
      toolCall('t3', 'TaskUpdate', { taskId: '7', status: 'completed' }),
    ]);

    expect(tasks).toEqual([
      { id: '7', content: '构建项目', status: 'completed', activeForm: undefined },
    ]);
  });

  it('removes deleted tasks', () => {
    const tasks = extractCcTasks([
      toolCall('t1', 'TaskCreate', { subject: 'A' }, '{"task":{"id":"1","subject":"A"}}'),
      toolCall('t2', 'TaskCreate', { subject: 'B' }, '{"task":{"id":"2","subject":"B"}}'),
      toolCall('t3', 'TaskUpdate', { taskId: '1', status: 'deleted' }),
    ]);

    expect(tasks.map((task) => task.content)).toEqual(['B']);
  });

  it('keeps only tasks touched after sinceIndex', () => {
    const tasks = extractCcTasks(
      [
        toolCall('t1', 'TaskCreate', { subject: '旧任务' }, '{"task":{"id":"1","subject":"旧任务"}}'),
        toolCall('t2', 'TaskUpdate', { taskId: '1', status: 'completed' }),
        toolCall('t3', 'TaskCreate', { subject: '本轮任务' }, '{"task":{"id":"2","subject":"本轮任务"}}'),
      ],
      1,
    );

    expect(tasks.map((task) => task.content)).toEqual(['本轮任务']);
  });

  it('adds unfinished tasks from earlier turns when asked', () => {
    const tasks = extractCcTasks(
      [
        toolCall('t1', 'TaskCreate', { subject: '已完成' }, '{"task":{"id":"1","subject":"已完成"}}'),
        toolCall('t2', 'TaskUpdate', { taskId: '1', status: 'completed' }),
        toolCall('t3', 'TaskCreate', { subject: '没做完' }, '{"task":{"id":"2","subject":"没做完"}}'),
        toolCall('t4', 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
        toolCall('t5', 'TaskCreate', { subject: '本轮任务' }, '{"task":{"id":"3","subject":"本轮任务"}}'),
      ],
      3,
      true,
    );

    expect(tasks.map((task) => task.content)).toEqual(['没做完', '本轮任务']);
  });

  it('ignores unrelated tools', () => {
    const tasks = extractCcTasks([
      toolCall('t1', 'Bash', { command: 'ls' }),
      toolCall('t2', 'Read', { file_path: 'a.txt' }),
    ]);
    expect(tasks).toEqual([]);
  });
});
