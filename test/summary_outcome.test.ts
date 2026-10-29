import { describe, expect, it } from 'vitest';
import { encodeSummaries } from '../functions/_lib/codec';

describe('Partieliste mit Ausgang', () => {
  it('beendete Partien tragen W, L oder D hinter der Zugmarke, laufende nicht', () => {
    const base = { code: 'ABCDEF', myTurn: false, names: ['Ich', 'Du'], deadlineAt: 5 };
    const text = encodeSummaries([
      { ...base, id: 'a', status: 'FINISHED', outcome: 'W' },
      { ...base, id: 'b', status: 'FINISHED', outcome: 'L' },
      { ...base, id: 'c', status: 'FINISHED', outcome: 'D' },
      { ...base, id: 'd', status: 'RUNNING', myTurn: true },
    ]);
    const marks = text.split('\n').filter((l) => l.startsWith('game ')).map((l) => l.split(' ')[4]);
    expect(marks).toEqual(['0W', '0L', '0D', '1']);
  });
});
