import { describe, it, expect } from 'vitest';
import { buildAnswersObject } from '../QuestionCard';
import type { UserQuestion } from '../../../stores/chatStore';

const questions: UserQuestion[] = [
  {
    question: 'How should I format the output?',
    header: 'Format',
    multiSelect: false,
    options: [
      { label: 'Summary', description: 'Brief overview' },
      { label: 'Detailed', description: 'Full explanation' },
    ],
  },
  {
    question: 'Which sections should I include?',
    header: 'Sections',
    multiSelect: true,
    options: [
      { label: 'Introduction', description: 'Opening context' },
      { label: 'Conclusion', description: 'Final summary' },
    ],
  },
];

describe('buildAnswersObject', () => {
  it('keys answers by the question text, not the index', () => {
    const selectedMap: Record<number, Set<number>> = { 0: new Set([1]) };
    const answers = buildAnswersObject(questions, selectedMap, {}, {});

    expect(answers).toEqual({
      'How should I format the output?': 'Detailed',
    });
    expect(answers).not.toHaveProperty('0');
  });

  it('joins multi-select labels with a comma', () => {
    const selectedMap: Record<number, Set<number>> = {
      0: new Set([0]),
      1: new Set([0, 1]),
    };
    const answers = buildAnswersObject(questions, selectedMap, {}, {});

    expect(answers['Which sections should I include?']).toBe(
      'Introduction, Conclusion',
    );
  });

  it('uses free text for the Other option', () => {
    const useOther: Record<number, boolean> = { 0: true };
    const otherText: Record<number, string> = { 0: 'Custom idea' };
    const answers = buildAnswersObject(questions, {}, useOther, otherText);

    expect(answers['How should I format the output?']).toBe('Custom idea');
  });

  it('skips questions with no selection', () => {
    const answers = buildAnswersObject(questions, {}, {}, {});
    expect(answers).toEqual({});
  });
});
