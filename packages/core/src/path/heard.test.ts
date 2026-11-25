import { describe, expect, it } from 'vitest';

import { heardRight, soundOf, withoutStutter } from './heard.js';

const NAMES = ['ReelRoom'];
const LINES = ['A booking board for student film gear.', 'Get the film department to pay.'];
const heard = (text: string) => heardRight(text, NAMES, LINES);

describe('what a call heard badly, from the venture’s own words', () => {
  it.each([
    [
      'how do I get the fill em department to pay for the real room',
      'how do I get the film department to pay for the ReelRoom',
    ],
    ['no I mean the booking bored for the gear', 'no I mean the booking board for the gear'],
    ['what does reel room need next', 'what does ReelRoom need next'],
    ['the fillum department said no', 'the film department said no'],
  ])('%s', (said, meant) => {
    expect(heard(said).text).toBe(meant);
  });

  it.each([
    'I was bored in the meeting with the dean',
    'we need a real person in the room',
    'the film department likes the booking board',
    'how much would they pay for a month',
    'can you fill in the form with me',
    'is there room for one more feature',
  ])('what was said right stays: %s', (said) => {
    expect(heard(said)).toEqual({ text: said, changes: [] });
  });

  it('other ventures', () => {
    expect(
      heardRight('people want the knoll lamp for their desk', ['NollLamp'], ['Desk lamps for dorm rooms.'])
        .text,
    ).toBe('people want the NollLamp for their desk');
    expect(heardRight('the clinic cue texts work', ['ClinicCue'], ['Reminder texts for clinics.']).text).toBe(
      'the ClinicCue texts work',
    );
    expect(heardRight('the dorm gym is open', ['DormJam'], ['Music nights in dorms.']).changes).toEqual([]);
  });

  it('fillers and words said twice', () => {
    expect(withoutStutter('um so like how do i uh get them to to pay')).toBe(
      'so like how do i get them to pay',
    );
    expect(withoutStutter('what does what does my idea cost')).toBe('what does my idea cost');
    expect(withoutStutter('it was very very good')).toBe('it was very good');
  });

  it('sounds', () => {
    expect(soundOf('film')).toBe(soundOf('fillem'));
    expect(soundOf('ReelRoom')).toBe(soundOf('realroom'));
    expect(soundOf('board')).toBe(soundOf('bored'));
    expect(soundOf('film')).not.toBe(soundOf('firm'));
  });
});
