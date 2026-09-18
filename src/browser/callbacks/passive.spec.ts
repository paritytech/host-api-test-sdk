import { describe, expect, it } from 'vitest';
import { createLocaleCallbacks } from './passive.js';
import { createHostState } from './state.js';

describe('locale callbacks', () => {
  it('emits the current locale, then each change', async () => {
    const state = createHostState();
    const { subscribeLocale } = createLocaleCallbacks(state);
    const items = subscribeLocale()[Symbol.asyncIterator]();

    const first = await items.next();
    expect(first.value).toEqual({ value: { languageTag: 'en' } });

    state.locale = 'pt-BR';
    for (const notify of state.localeSubscribers) notify(state.locale);

    const second = await items.next();
    expect(second.value).toEqual({ value: { languageTag: 'pt-BR' } });
  });
});
